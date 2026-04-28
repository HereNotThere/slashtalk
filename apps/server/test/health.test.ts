import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createApp } from "../src/app";
import { db, pingDatabase } from "../src/db";
import { RedisBridge } from "../src/ws/redis-bridge";

let app: ReturnType<typeof createApp>;
let baseUrl: string;
let redis: RedisBridge;

beforeAll(async () => {
  redis = new RedisBridge();
  await redis.connect();
  app = createApp(db, redis);
  app.listen(0);
  baseUrl = `http://localhost:${app.server!.port}`;
}, 30_000);

afterAll(async () => {
  await app.stop();
  await redis.disconnect();
});

describe("liveness / readiness", () => {
  it("/health returns 200 ok without checking dependencies", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("/ready returns 200 ready when database and redis are reachable", async () => {
    const res = await fetch(`${baseUrl}/ready`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; database: boolean; redis: boolean };
    expect(body.status).toBe("ready");
    expect(body.database).toBe(true);
    expect(body.redis).toBe(true);
  });

  it("pingDatabase resolves to true against the live test database", async () => {
    expect(await pingDatabase()).toBe(true);
  });

  it("RedisBridge.ping returns true against live Redis", async () => {
    expect(await redis.ping()).toBe(true);
  });
});
