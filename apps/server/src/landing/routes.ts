import { Elysia } from "elysia";
import { INDEX_HTML, fileResponse, relativePathUnder } from "../web/shared";

const LANDING_DIST_URL = new URL("../../../landing/dist/", import.meta.url);

export const landingRoutes = () =>
  new Elysia({ name: "landing" })
    .get("/", ({ request, set }) => serveLanding(request, set))
    .get("/_astro/*", ({ request, set }) => serveLanding(request, set))
    .get("/favicon.svg", ({ request, set }) => serveLanding(request, set))
    .get("/favicon.ico", ({ request, set }) => serveLanding(request, set))
    .get("/screenshot-dock.png", ({ request, set }) => serveLanding(request, set))
    .get("/screenshot-card.png", ({ request, set }) => serveLanding(request, set))
    .get("/screenshot-ask.png", ({ request, set }) => serveLanding(request, set))
    .get("/og-image.png", ({ request, set }) => serveLanding(request, set));

async function serveLanding(request: Request, set: { status?: number | string }) {
  const relPath = relativeLandingPath(new URL(request.url).pathname);
  if (relPath === null) {
    set.status = 404;
    return "Not found";
  }

  const file = Bun.file(new URL(relPath, LANDING_DIST_URL));
  if (await file.exists()) return fileResponse(file, relPath, cacheControl(relPath));

  if (relPath === INDEX_HTML) {
    set.status = 503;
    return "Landing page has not been built. Run `bun --filter @slashtalk/landing build`.";
  }

  set.status = 404;
  return "Not found";
}

export function relativeLandingPath(pathname: string): string | null {
  const rel = relativePathUnder(pathname, "");
  if (rel === null) return null;
  return rel === "" ? INDEX_HTML : rel;
}

function cacheControl(path: string): string {
  if (path === INDEX_HTML) return "no-cache";
  if (path.startsWith("_astro/")) return "public, max-age=31536000, immutable";
  return "public, max-age=3600";
}
