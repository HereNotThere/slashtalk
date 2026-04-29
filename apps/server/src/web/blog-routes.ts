import { Elysia } from "elysia";

const BLOG_DIST_URL = new URL("../../../blog/dist/", import.meta.url);
const INDEX_HTML = "index.html";

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};

export const blogRoutes = () =>
  new Elysia({ name: "web-blog" })
    .get("/blog", ({ request, set }) => serveBlog(request, set))
    .get("/blog/*", ({ request, set }) => serveBlog(request, set));

async function serveBlog(request: Request, set: { status?: number | string }) {
  const relPath = relativeBlogPath(new URL(request.url).pathname);
  if (relPath === null) {
    set.status = 404;
    return "Not found";
  }

  if (relPath === "") {
    return await serveOrFallback(INDEX_HTML, set);
  }

  if (hasFileExtension(relPath)) {
    const file = Bun.file(new URL(relPath, BLOG_DIST_URL));
    if (await file.exists()) return fileResponse(file, relPath);
    set.status = 404;
    return "Not found";
  }

  const nested = `${relPath}/${INDEX_HTML}`;
  const nestedFile = Bun.file(new URL(nested, BLOG_DIST_URL));
  if (await nestedFile.exists()) return fileResponse(nestedFile, nested);

  set.status = 404;
  return "Not found";
}

async function serveOrFallback(relPath: string, set: { status?: number | string }) {
  const file = Bun.file(new URL(relPath, BLOG_DIST_URL));
  if (await file.exists()) return fileResponse(file, relPath);
  set.status = 404;
  return "Blog has not been built. Run `bun --filter @slashtalk/blog build`.";
}

export function relativeBlogPath(pathname: string): string | null {
  if (pathname === "/blog" || pathname === "/blog/") return "";
  if (!pathname.startsWith("/blog/")) return null;

  let rel: string;
  try {
    rel = decodeURIComponent(pathname.slice("/blog/".length));
  } catch {
    return null;
  }

  if (rel.includes("\0") || rel.includes("%") || rel.includes(":") || rel.includes("\\")) {
    return null;
  }
  rel = rel.replace(/\/+$/, "");
  if (!rel) return "";

  const segments = rel.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) {
    return null;
  }
  return rel;
}

function fileResponse(file: Bun.BunFile, relPath: string): Response {
  const headers = new Headers();
  headers.set("content-type", contentType(relPath));
  headers.set("cache-control", cacheControl(relPath));
  return new Response(file, { headers });
}

function contentType(path: string): string {
  const lower = path.toLowerCase();
  for (const [suffix, type] of Object.entries(MIME_TYPES)) {
    if (lower.endsWith(suffix)) return type;
  }
  return "application/octet-stream";
}

function cacheControl(path: string): string {
  if (path === "" || path === INDEX_HTML || path.endsWith(`/${INDEX_HTML}`)) {
    return "no-cache";
  }
  if (path.startsWith("_astro/")) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
}

function hasFileExtension(path: string): boolean {
  const last = path.split("/").pop() ?? "";
  return last.includes(".");
}
