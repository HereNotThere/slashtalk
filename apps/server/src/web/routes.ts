import { Elysia } from "elysia";

const WEB_DIST_URL = new URL("../../../web/dist/", import.meta.url);
const INDEX_HTML = "index.html";

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

export const webAppRoutes = () =>
  new Elysia({ name: "web-app" })
    .get("/app", ({ request, set }) => serveWebApp(request, set))
    .get("/app/*", ({ request, set }) => serveWebApp(request, set));

async function serveWebApp(request: Request, set: { status?: number | string }) {
  const relPath = relativeAppPath(new URL(request.url).pathname);
  if (relPath === null) {
    set.status = 404;
    return "Not found";
  }

  const file = Bun.file(new URL(relPath, WEB_DIST_URL));
  if (await file.exists()) return fileResponse(file, relPath);

  if (hasFileExtension(relPath)) {
    set.status = 404;
    return "Not found";
  }

  const index = Bun.file(new URL(INDEX_HTML, WEB_DIST_URL));
  if (await index.exists()) return fileResponse(index, INDEX_HTML);

  set.status = 404;
  return "Web app has not been built. Run `bun --filter @slashtalk/web build`.";
}

export function relativeAppPath(pathname: string): string | null {
  if (pathname === "/app" || pathname === "/app/") return INDEX_HTML;
  if (!pathname.startsWith("/app/")) return null;

  let rel: string;
  try {
    rel = decodeURIComponent(pathname.slice("/app/".length));
  } catch {
    return null;
  }

  if (rel.includes("\0") || rel.includes("%")) return null;
  rel = rel.replace(/\/+$/, "");
  if (!rel) return INDEX_HTML;

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
  if (path === INDEX_HTML || path === "sw.js" || path === "manifest.webmanifest") {
    return "no-cache";
  }
  if (path.startsWith("assets/")) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
}

function hasFileExtension(path: string): boolean {
  const last = path.split("/").pop() ?? "";
  return last.includes(".");
}
