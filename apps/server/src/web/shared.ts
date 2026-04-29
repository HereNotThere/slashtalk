// Shared static-file helpers for /app and /blog. The path sanitization is
// security-critical (null-byte, traversal, scheme injection, encoded
// traversal, backslash) — keep it here so a fix lands in one place.

export const INDEX_HTML = "index.html";

export const MIME_TYPES: Record<string, string> = {
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
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};

// Strip the mount prefix and return a sanitized relative path, or null if the
// request doesn't belong to this prefix or contains an unsafe segment.
// Returns "" for a request to the prefix itself ("/app", "/app/") so callers
// can decide what the "root" maps to (e.g. INDEX_HTML for the SPA, or a
// directory-format index lookup for the blog).
export function relativePathUnder(pathname: string, prefix: string): string | null {
  if (pathname === prefix || pathname === `${prefix}/`) return "";
  const withSlash = `${prefix}/`;
  if (!pathname.startsWith(withSlash)) return null;

  let rel: string;
  try {
    rel = decodeURIComponent(pathname.slice(withSlash.length));
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

export function fileResponse(file: Bun.BunFile, relPath: string, cacheControl: string): Response {
  const headers = new Headers();
  headers.set("content-type", contentType(relPath));
  headers.set("cache-control", cacheControl);
  return new Response(file, { headers });
}

export function contentType(path: string): string {
  const lower = path.toLowerCase();
  for (const [suffix, type] of Object.entries(MIME_TYPES)) {
    if (lower.endsWith(suffix)) return type;
  }
  return "application/octet-stream";
}

export function hasFileExtension(path: string): boolean {
  const last = path.split("/").pop() ?? "";
  return last.includes(".");
}
