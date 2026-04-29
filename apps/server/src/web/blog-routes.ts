import { Elysia } from "elysia";
import { INDEX_HTML, fileResponse, hasFileExtension, relativePathUnder } from "./shared";

const BLOG_DIST_URL = new URL("../../../blog/dist/", import.meta.url);

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
    if (await file.exists()) return fileResponse(file, relPath, cacheControl(relPath));
    set.status = 404;
    return "Not found";
  }

  const nested = `${relPath}/${INDEX_HTML}`;
  const nestedFile = Bun.file(new URL(nested, BLOG_DIST_URL));
  if (await nestedFile.exists()) return fileResponse(nestedFile, nested, cacheControl(nested));

  set.status = 404;
  return "Not found";
}

async function serveOrFallback(relPath: string, set: { status?: number | string }) {
  const file = Bun.file(new URL(relPath, BLOG_DIST_URL));
  if (await file.exists()) return fileResponse(file, relPath, cacheControl(relPath));
  set.status = 404;
  return "Blog has not been built. Run `bun --filter @slashtalk/blog build`.";
}

export function relativeBlogPath(pathname: string): string | null {
  return relativePathUnder(pathname, "/blog");
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
