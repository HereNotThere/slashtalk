import { afterEach, describe, expect, it } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createLocalMcpProxy } from "../src/main/localMcpProxy";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function listen(
  handler: http.RequestListener,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}/mcp`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((err) => (err ? closeReject(err) : closeResolve()));
          }),
      });
    });
  });
}

describe("localMcpProxy", () => {
  it("throws when url is read before the proxy starts", () => {
    const proxy = createLocalMcpProxy({
      port: 0,
      getToken: () => "safe-storage-token",
      getProxySecret: () => "local-proxy-secret",
      remoteMcpUrl: () => "https://api.example.com/mcp",
    });

    expect(() => proxy.url()).toThrow("not ready");
  });

  it("binds port-zero on first start and persists the chosen port", async () => {
    let savedPort: number | null = null;
    const proxy = createLocalMcpProxy({
      getSavedPort: () => null,
      saveBoundPort: (port) => {
        savedPort = port;
      },
      getToken: () => "safe-storage-token",
      getProxySecret: () => "local-proxy-secret",
      remoteMcpUrl: () => "https://api.example.com/mcp",
    });
    await proxy.start();
    closers.push(() => proxy.stop());

    const url = new URL(proxy.url());
    expect(url.hostname).toBe("127.0.0.1");
    expect(Number(url.port)).toBeGreaterThan(0);
    expect(savedPort).toBe(Number(url.port));
  });

  it("reuses a saved port on the next start", async () => {
    let savedPort: number | null = null;
    const first = createLocalMcpProxy({
      getSavedPort: () => savedPort,
      saveBoundPort: (port) => {
        savedPort = port;
      },
      getToken: () => "safe-storage-token",
      getProxySecret: () => "local-proxy-secret",
      remoteMcpUrl: () => "https://api.example.com/mcp",
    });
    await first.start();
    const firstPort = Number(new URL(first.url()).port);
    await first.stop();

    const second = createLocalMcpProxy({
      getSavedPort: () => savedPort,
      saveBoundPort: (port) => {
        savedPort = port;
      },
      getToken: () => "safe-storage-token",
      getProxySecret: () => "local-proxy-secret",
      remoteMcpUrl: () => "https://api.example.com/mcp",
    });
    await second.start();
    closers.push(() => second.stop());

    expect(Number(new URL(second.url()).port)).toBe(firstPort);
  });

  it("falls back to port-zero when a saved port is occupied", async () => {
    const sentinel = await listen((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    closers.push(sentinel.close);
    const occupiedPort = Number(new URL(sentinel.url).port);
    let savedPort: number | null = occupiedPort;
    let changedPort: number | null = null;
    const proxy = createLocalMcpProxy({
      getSavedPort: () => savedPort,
      saveBoundPort: (port) => {
        savedPort = port;
      },
      getToken: () => "safe-storage-token",
      getProxySecret: () => "local-proxy-secret",
      remoteMcpUrl: () => "https://api.example.com/mcp",
    });
    proxy.on("port-changed", (port) => {
      changedPort = port;
    });

    await proxy.start();
    closers.push(() => proxy.stop());

    const actualPort = Number(new URL(proxy.url()).port);
    expect(actualPort).not.toBe(occupiedPort);
    expect(savedPort).toBe(actualPort);
    expect(changedPort).toBe(actualPort);
  });

  it("rotates the proxy secret when a saved port is occupied", async () => {
    const sentinel = await listen((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    closers.push(sentinel.close);
    const upstream = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    closers.push(upstream.close);
    let secret = "old-local-proxy-secret";
    const proxy = createLocalMcpProxy({
      getSavedPort: () => Number(new URL(sentinel.url).port),
      saveBoundPort: () => undefined,
      rotateProxySecret: () => {
        secret = "new-local-proxy-secret";
      },
      getToken: () => "safe-storage-token",
      getProxySecret: () => secret,
      remoteMcpUrl: () => upstream.url,
    });

    await proxy.start();
    closers.push(() => proxy.stop());

    const oldSecretResponse = await fetch(proxy.url(), {
      method: "POST",
      headers: { "X-Slashtalk-Proxy-Token": "old-local-proxy-secret" },
      body: "{}",
    });
    expect(oldSecretResponse.status).toBe(401);
    const newSecretResponse = await fetch(proxy.url(), {
      method: "POST",
      headers: { "X-Slashtalk-Proxy-Token": "new-local-proxy-secret" },
      body: "{}",
    });
    expect(newSecretResponse.status).toBe(200);
  });

  it("uses the env override before the saved port and fails if the override is occupied", async () => {
    const sentinel = await listen((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    closers.push(sentinel.close);
    process.env["SLASHTALK_LOCAL_MCP_PORT"] = String(Number(new URL(sentinel.url).port));
    const proxy = createLocalMcpProxy({
      getSavedPort: () => 54321,
      saveBoundPort: () => {
        throw new Error("saved port should not be updated for env override");
      },
      getToken: () => "safe-storage-token",
      getProxySecret: () => "local-proxy-secret",
      remoteMcpUrl: () => "https://api.example.com/mcp",
    });

    try {
      await expect(proxy.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      delete process.env["SLASHTALK_LOCAL_MCP_PORT"];
    }
  });

  it("injects the current token and strips inbound authorization", async () => {
    let upstreamAuth: string | undefined;
    let upstreamSession: string | undefined;
    let upstreamProxyToken: string | string[] | undefined;
    let upstreamBody = "";
    const upstream = await listen((req, res) => {
      upstreamAuth = req.headers.authorization;
      upstreamSession = req.headers["mcp-session-id"] as string | undefined;
      upstreamProxyToken = req.headers["x-slashtalk-proxy-token"];
      req.on("data", (chunk) => {
        upstreamBody += chunk.toString();
      });
      req.on("end", () => {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "server-session",
        });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    closers.push(upstream.close);
    const proxy = createLocalMcpProxy({
      port: 0,
      getToken: () => "safe-storage-token",
      getProxySecret: () => "local-proxy-secret",
      remoteMcpUrl: () => upstream.url,
    });
    await proxy.start();
    closers.push(() => proxy.stop());

    const res = await fetch(proxy.url(), {
      method: "POST",
      headers: {
        authorization: "Bearer attacker",
        "content-type": "application/json",
        "mcp-session-id": "client-session",
        "x-slashtalk-proxy-token": "local-proxy-secret",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBe("server-session");
    expect(await res.json()).toEqual({ ok: true });
    expect(upstreamAuth).toBe("Bearer safe-storage-token");
    expect(upstreamSession).toBe("client-session");
    expect(upstreamProxyToken).toBeUndefined();
    expect(JSON.parse(upstreamBody).method).toBe("tools/list");
  });

  it("rejects MCP requests without the local proxy secret", async () => {
    let upstreamCalled = false;
    const upstream = await listen((_req, res) => {
      upstreamCalled = true;
      res.writeHead(200);
      res.end();
    });
    closers.push(upstream.close);
    const proxy = createLocalMcpProxy({
      port: 0,
      getToken: () => "safe-storage-token",
      getProxySecret: () => "local-proxy-secret",
      remoteMcpUrl: () => upstream.url,
    });
    await proxy.start();
    closers.push(() => proxy.stop());

    const missing = await fetch(proxy.url(), { method: "POST", body: "{}" });
    const wrong = await fetch(proxy.url(), {
      method: "POST",
      headers: { "x-slashtalk-proxy-token": "wrong" },
      body: "{}",
    });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(upstreamCalled).toBe(false);
  });

  it("rejects MCP requests when the desktop has no token", async () => {
    let upstreamCalled = false;
    const upstream = await listen((_req, res) => {
      upstreamCalled = true;
      res.writeHead(200);
      res.end();
    });
    closers.push(upstream.close);
    const proxy = createLocalMcpProxy({
      port: 0,
      getToken: () => null,
      getProxySecret: () => "local-proxy-secret",
      remoteMcpUrl: () => upstream.url,
    });
    await proxy.start();
    closers.push(() => proxy.stop());

    const res = await fetch(proxy.url(), {
      method: "POST",
      headers: { "x-slashtalk-proxy-token": "local-proxy-secret" },
      body: "{}",
    });

    expect(res.status).toBe(401);
    expect(await res.text()).toContain("not signed in");
    expect(upstreamCalled).toBe(false);
  });

  it("rejects oversized MCP request bodies before forwarding", async () => {
    let upstreamCalled = false;
    const upstream = await listen((_req, res) => {
      upstreamCalled = true;
      res.writeHead(200);
      res.end();
    });
    closers.push(upstream.close);
    const proxy = createLocalMcpProxy({
      port: 0,
      getToken: () => "safe-storage-token",
      getProxySecret: () => "local-proxy-secret",
      remoteMcpUrl: () => upstream.url,
    });
    await proxy.start();
    closers.push(() => proxy.stop());

    const res = await fetch(proxy.url(), {
      method: "POST",
      headers: { "x-slashtalk-proxy-token": "local-proxy-secret" },
      body: "x".repeat(1024 * 1024 + 1),
    });

    expect(res.status).toBe(413);
    expect(await res.text()).toContain("too large");
    expect(upstreamCalled).toBe(false);
  });

  it("aborts the upstream request when the client disconnects", async () => {
    const originalFetch = globalThis.fetch;
    let upstreamAborted = false;
    let resolveFetchStarted!: () => void;
    let resolveAbort!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      resolveFetchStarted = resolve;
    });
    const abortObserved = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      resolveFetchStarted();
      init?.signal?.addEventListener("abort", () => {
        upstreamAborted = true;
        resolveAbort();
      });
      return new Promise<Response>(() => undefined);
    }) as typeof fetch;

    try {
      const proxy = createLocalMcpProxy({
        port: 0,
        getToken: () => "safe-storage-token",
        getProxySecret: () => "local-proxy-secret",
        remoteMcpUrl: () => "https://api.example.com/mcp",
      });
      await proxy.start();
      closers.push(() => proxy.stop());

      const req = await new Promise<http.ClientRequest>((resolve, reject) => {
        const url = new URL(proxy.url());
        const req = http.request(
          {
            hostname: url.hostname,
            port: Number(url.port),
            path: url.pathname,
            method: "GET",
            headers: { "x-slashtalk-proxy-token": "local-proxy-secret" },
          },
          () => undefined,
        );
        req.on("error", (err) => {
          if ((err as NodeJS.ErrnoException).code === "ECONNRESET") return;
          reject(err);
        });
        req.end();
        resolve(req);
      });
      await fetchStarted;
      req.destroy();
      await Promise.race([abortObserved, new Promise((resolve) => setTimeout(resolve, 250))]);

      expect(upstreamAborted).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
