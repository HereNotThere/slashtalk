import { Elysia } from "elysia";
import { INDEX_HTML, fileResponse, hasFileExtension, relativePathUnder } from "./shared";

const WEB_DIST_URL = new URL("../../../web/dist/", import.meta.url);

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
  if (await file.exists()) return fileResponse(file, relPath, cacheControl(relPath));

  if (hasFileExtension(relPath)) {
    set.status = 404;
    return "Not found";
  }

  const index = Bun.file(new URL(INDEX_HTML, WEB_DIST_URL));
  if (await index.exists()) return fileResponse(index, INDEX_HTML, cacheControl(INDEX_HTML));

  set.status = 404;
  return "Web app has not been built. Run `bun --filter @slashtalk/web build`.";
}

export function relativeAppPath(pathname: string): string | null {
  const rel = relativePathUnder(pathname, "/app");
  if (rel === null) return null;
  return rel === "" ? INDEX_HTML : rel;
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
