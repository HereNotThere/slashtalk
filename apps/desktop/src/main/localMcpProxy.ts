import http from "node:http";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { LOCAL_PROXY_SECRET_HEADER, remoteMcpUrl } from "./installMcp";
import { localMcpPortOverride } from "./config";

type MaybePromise<T> = T | Promise<T>;

interface LocalMcpProxyDeps {
  port?: number;
  getSavedPort?: () => MaybePromise<number | null>;
  saveBoundPort?: (port: number) => MaybePromise<void>;
  rotateProxySecret?: () => MaybePromise<unknown>;
  getToken?: () => string | null;
  getProxySecret?: () => string | null;
  remoteMcpUrl?: () => string;
}

export interface LocalMcpProxy {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  url: () => string;
  isRunning: () => boolean;
  on: (event: "port-changed", listener: (port: number) => void) => LocalMcpProxy;
  off: (event: "port-changed", listener: (port: number) => void) => LocalMcpProxy;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const RESPONSE_SKIP_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "content-encoding",
  "content-length",
]);

async function readBody(req: http.IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

function response(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function upstreamUrl(base: string, incomingUrl: string | undefined): URL {
  const target = new URL(base);
  const incoming = new URL(incomingUrl ?? "/mcp", "http://127.0.0.1");
  for (const [key, value] of incoming.searchParams) {
    target.searchParams.append(key, value);
  }
  return target;
}

function forwardedHeaders(req: http.IncomingMessage, token: string): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (lower === "authorization" || lower === "host") continue;
    if (lower === LOCAL_PROXY_SECRET_HEADER.toLowerCase()) continue;
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(name, v);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  headers.set("authorization", `Bearer ${token}`);
  return headers;
}

function copyResponseHeaders(upstream: Response, res: http.ServerResponse): void {
  upstream.headers.forEach((value, name) => {
    if (RESPONSE_SKIP_HEADERS.has(name.toLowerCase())) return;
    res.setHeader(name, value);
  });
}

async function defaultGetSavedPort(): Promise<number | null> {
  const { getSavedLocalMcpPort } = await import("./localMcpProxyPort");
  return getSavedLocalMcpPort();
}

async function defaultSaveBoundPort(port: number): Promise<void> {
  const { saveSavedLocalMcpPort } = await import("./localMcpProxyPort");
  saveSavedLocalMcpPort(port);
}

function listenOn(
  port: number,
  handler: http.RequestListener,
): Promise<{
  server: http.Server;
  port: number;
}> {
  const next = http.createServer(handler);
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      next.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      next.off("error", onError);
      const addr = next.address() as AddressInfo | null;
      if (!addr?.port) {
        next.close();
        reject(new Error("Local MCP proxy bound without a TCP port"));
        return;
      }
      resolve({ server: next, port: addr.port });
    };

    next.once("error", onError);
    next.once("listening", onListening);
    next.listen(port, "127.0.0.1");
  });
}

function urlForPort(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

export function createLocalMcpProxy(deps: LocalMcpProxyDeps = {}): LocalMcpProxy {
  let server: http.Server | null = null;
  let boundPort: number | null = null;
  const events = new EventEmitter();
  const getSavedPort = deps.getSavedPort ?? defaultGetSavedPort;
  const saveBoundPort = deps.saveBoundPort ?? defaultSaveBoundPort;
  const rotateProxySecret = deps.rotateProxySecret ?? (() => undefined);
  const getToken = deps.getToken ?? (() => null);
  const getProxySecret = deps.getProxySecret ?? (() => null);
  const getRemoteMcpUrl = deps.remoteMcpUrl ?? remoteMcpUrl;

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const incoming = new URL(req.url ?? "/", "http://127.0.0.1");
    if (incoming.pathname !== "/mcp") {
      response(res, 404, "not found");
      return;
    }

    const expectedProxySecret = getProxySecret();
    const suppliedProxySecret = headerValue(req.headers[LOCAL_PROXY_SECRET_HEADER.toLowerCase()]);
    if (!expectedProxySecret || suppliedProxySecret !== expectedProxySecret) {
      response(res, 401, "Invalid Slashtalk local proxy token");
      return;
    }

    const token = getToken();
    if (!token) {
      response(res, 401, "Slashtalk desktop is not signed in");
      return;
    }

    const abortController = new AbortController();
    let finished = false;
    const abortUpstream = () => {
      if (!finished) abortController.abort();
    };
    req.on("aborted", abortUpstream);
    req.socket.on("close", abortUpstream);
    res.on("close", abortUpstream);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    try {
      const body = await readBody(req);
      const requestInit: RequestInit = {
        method: req.method,
        headers: forwardedHeaders(req, token),
        signal: abortController.signal,
      };
      if (body) {
        requestInit.body = body.buffer.slice(
          body.byteOffset,
          body.byteOffset + body.byteLength,
        ) as ArrayBuffer;
      }
      const upstream = await fetch(upstreamUrl(getRemoteMcpUrl(), req.url), {
        ...requestInit,
      });
      res.statusCode = upstream.status;
      res.statusMessage = upstream.statusText;
      copyResponseHeaders(upstream, res);
      if (!upstream.body) {
        finished = true;
        res.end();
        return;
      }
      reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) res.write(Buffer.from(value));
      }
      finished = true;
      res.end();
    } catch (err) {
      if (!abortController.signal.aborted) {
        console.warn("[localMcpProxy] forward failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      if (!res.headersSent) response(res, 502, "MCP proxy upstream failed");
      else if (!res.destroyed) res.end();
    } finally {
      finished = true;
      req.off("aborted", abortUpstream);
      req.socket.off("close", abortUpstream);
      res.off("close", abortUpstream);
      await reader?.cancel().catch(() => undefined);
    }
  }

  return {
    async start() {
      if (server) return;
      const explicitPort = deps.port;
      const envPort = explicitPort === undefined ? localMcpPortOverride() : null;
      const savedPort =
        explicitPort === undefined && envPort === null ? await getSavedPort() : null;
      const preferredPort = explicitPort ?? envPort ?? savedPort ?? 0;
      const explicitPreference = explicitPort !== undefined || envPort !== null;

      let usedFallbackPort = false;
      const bound = await listenOn(preferredPort, (req, res) => void handle(req, res)).catch(
        async (err: NodeJS.ErrnoException) => {
          if (err.code !== "EADDRINUSE" || explicitPreference) throw err;
          usedFallbackPort = true;
          return listenOn(0, (req, res) => void handle(req, res));
        },
      );

      server = bound.server;
      boundPort = bound.port;
      const savedChanged = savedPort !== boundPort;
      if (!explicitPreference && savedChanged) {
        if (usedFallbackPort) await rotateProxySecret();
        await saveBoundPort(boundPort);
        events.emit("port-changed", boundPort);
      }

      console.log("[localMcpProxy] listening", { url: urlForPort(boundPort) });
    },

    async stop() {
      const current = server;
      server = null;
      if (!current) return;
      await new Promise<void>((resolve, reject) => {
        current.close((err) => (err ? reject(err) : resolve()));
      });
    },

    url() {
      if (boundPort === null) throw new Error("Local MCP proxy is not ready");
      return urlForPort(boundPort);
    },

    isRunning() {
      return Boolean(server);
    },

    on(event, listener) {
      events.on(event, listener);
      return this;
    },

    off(event, listener) {
      events.off(event, listener);
      return this;
    },
  };
}
