import { and, desc, eq, gt, or, sql } from "drizzle-orm";
import type { Database } from "../db";
import { events as eventsTable, sessionInsights, sessions } from "../db/schema";
import type { RedisBridge } from "../ws/redis-bridge";
import { config } from "../config";
import { analyzers } from "./registry";
import { publishInsightsUpdate } from "./publish";
import type { Analyzer, AnalyzerContext } from "./types";

const INITIAL_DELAY_MS = 5_000;
// One in-process guard so a slow tick doesn't overlap with the next interval
// fire. When we actually run multiple replicas, add a Redis-backed lock here.
let tickInFlight = false;

export function startScheduler(db: Database, redis: RedisBridge): void {
  if (!config.anthropicApiKey) {
    console.log("[analyzers] ANTHROPIC_API_KEY unset — scheduler disabled");
    return;
  }
  console.log(
    `[analyzers] scheduler enabled (tick=${config.analyzerTickMs}ms, concurrency=${config.analyzerConcurrency}, cap=${config.analyzerMaxSessionsPerTick})`,
  );
  const onTick = () => tick(db, redis).catch((e) => console.error("[analyzers] tick error", e));
  setTimeout(onTick, INITIAL_DELAY_MS);
  setInterval(onTick, config.analyzerTickMs);
}

async function tick(db: Database, redis: RedisBridge): Promise<void> {
  if (tickInFlight) {
    console.log("[analyzers] tick skipped — previous tick still running");
    return;
  }
  tickInFlight = true;
  const startedAt = Date.now();
  console.log("[analyzers] tick starting");

  try {
    const candidates = await db
      .select()
      .from(sessions)
      .where(
        or(
          gt(sessions.lastTs, sql`now() - interval '1 hour'`),
          sql`NOT EXISTS (SELECT 1 FROM ${sessionInsights} si WHERE si.session_id = ${sessions.sessionId})`,
        ),
      )
      .orderBy(desc(sessions.lastTs))
      .limit(config.analyzerMaxSessionsPerTick);

    console.log(
      `[analyzers] selected ${candidates.length} candidate sessions (touched in last 1h or never analyzed), running ${analyzers.length} analyzers`,
    );

    if (candidates.length === 0) {
      console.log("[analyzers] tick done: no candidates");
      return;
    }

    let generated = 0;
    let skipped = 0;
    let errored = 0;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let costUsd = 0;

    const pairs: Array<{ a: Analyzer; s: typeof sessions.$inferSelect }> = [];
    for (const a of analyzers) {
      for (const s of candidates) pairs.push({ a, s });
    }

    await runInPool(pairs, config.analyzerConcurrency, async ({ a, s }) => {
      const res = await runOne(db, redis, a, s);
      if (res.ran) generated++;
      else if (!res.errored) skipped++;
      if (res.errored) errored++;
      totalTokensIn += res.tokensIn;
      totalTokensOut += res.tokensOut;
      costUsd += res.costUsd;
    });

    const elapsed = Date.now() - startedAt;
    console.log(
      `[analyzers] tick done in ${elapsed}ms: ${generated} ran, ${skipped} skipped, ${errored} errored — ${totalTokensIn}in/${totalTokensOut}out tokens, $${costUsd.toFixed(4)}`,
    );
  } finally {
    tickInFlight = false;
  }
}

interface RunOneResult {
  ran: boolean;
  errored: boolean;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function previewOutput(output: unknown): string {
  if (!output || typeof output !== "object") return String(output);
  const o = output as Record<string, unknown>;
  if (typeof o.title === "string") {
    const desc = typeof o.description === "string" ? ` — ${o.description}` : "";
    return `"${o.title}"${desc}`.slice(0, 200);
  }
  if (typeof o.summary === "string") {
    return `"${o.summary}"`.slice(0, 200);
  }
  return JSON.stringify(output).slice(0, 200);
}

async function runOne(
  db: Database,
  redis: RedisBridge,
  analyzer: Analyzer,
  session: typeof sessions.$inferSelect,
): Promise<RunOneResult> {
  const tag = `[analyzers:${analyzer.name}] ${shortId(session.sessionId)}`;
  const empty: RunOneResult = {
    ran: false,
    errored: false,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
  };

  const [existing] = await db
    .select()
    .from(sessionInsights)
    .where(
      and(
        eq(sessionInsights.sessionId, session.sessionId),
        eq(sessionInsights.analyzerName, analyzer.name),
      ),
    )
    .limit(1);

  const ctx: AnalyzerContext = {
    db,
    session,
    existingInsight: existing ?? null,
    recentEvents: async () => {
      const rows = await db
        .select()
        .from(eventsTable)
        .where(eq(eventsTable.sessionId, session.sessionId))
        .orderBy(desc(eventsTable.lineSeq))
        .limit(30);
      return rows.reverse();
    },
  };

  try {
    if (!(await analyzer.shouldRun(ctx))) {
      return empty;
    }
  } catch (e) {
    console.error(`${tag} shouldRun threw:`, e);
    return { ...empty, errored: true };
  }

  const reason = existing ? "refresh" : "first-run";
  const seq = session.serverLineSeq ?? 0;
  const prevSeq = existing?.inputLineSeq ?? 0;
  console.log(
    `${tag} running (${reason}, project=${session.project}, events=${session.events ?? 0}, seq ${prevSeq}→${seq})`,
  );
  const t0 = Date.now();

  try {
    const result = await analyzer.run(ctx);
    const elapsed = Date.now() - t0;
    const now = new Date();
    await upsertSuccess(db, analyzer, session.sessionId, now, result);

    console.log(
      `${tag} ok in ${elapsed}ms — ${result.tokensIn}in/${result.tokensOut}out (cache ${result.tokensCacheRead}) $${result.costUsd.toFixed(5)} — ${previewOutput(result.output)}`,
    );

    if (session.repoId) {
      publishInsightsUpdate(
        redis,
        session.sessionId,
        session.repoId,
        analyzer.name,
        result.output,
        now,
      );
      console.log(`${tag} published to repo:${session.repoId}`);
    } else {
      console.log(`${tag} no repoId — skipping WS publish`);
    }
    return {
      ran: true,
      errored: false,
      costUsd: result.costUsd,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
    };
  } catch (e) {
    const err = e as Error;
    const elapsed = Date.now() - t0;
    console.error(`${tag} failed in ${elapsed}ms: ${err.message}`);
    await upsertError(db, analyzer, session, err.message.slice(0, 500));
    return { ...empty, errored: true };
  }
}

async function upsertSuccess(
  db: Database,
  analyzer: Analyzer,
  sessionId: string,
  now: Date,
  result: {
    output: unknown;
    inputLineSeq: number;
    tokensIn: number;
    tokensOut: number;
    tokensCacheRead: number;
    costUsd: number;
  },
): Promise<void> {
  const row = {
    sessionId,
    analyzerName: analyzer.name,
    analyzerVersion: analyzer.version,
    output: result.output as object,
    inputLineSeq: result.inputLineSeq,
    model: analyzer.model,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    tokensCacheRead: result.tokensCacheRead,
    costUsd: result.costUsd.toFixed(6),
    analyzedAt: now,
    errorText: null,
  };
  await db
    .insert(sessionInsights)
    .values(row)
    .onConflictDoUpdate({
      target: [sessionInsights.sessionId, sessionInsights.analyzerName],
      set: row,
    });
}

/**
 * On failure we preserve the previous successful output/tokens/cost and only
 * update analyzedAt + errorText. A transient failure shouldn't nuke a good
 * prior run.
 */
async function upsertError(
  db: Database,
  analyzer: Analyzer,
  session: typeof sessions.$inferSelect,
  errorText: string,
): Promise<void> {
  const now = new Date();
  await db
    .insert(sessionInsights)
    .values({
      sessionId: session.sessionId,
      analyzerName: analyzer.name,
      analyzerVersion: analyzer.version,
      output: {},
      inputLineSeq: session.serverLineSeq ?? 0,
      model: analyzer.model,
      tokensIn: 0,
      tokensOut: 0,
      tokensCacheRead: 0,
      costUsd: "0",
      analyzedAt: now,
      errorText,
    })
    .onConflictDoUpdate({
      target: [sessionInsights.sessionId, sessionInsights.analyzerName],
      set: { analyzedAt: now, errorText },
    });
}

async function runInPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const queue = [...items];
  const workers: Promise<void>[] = [];
  const n = Math.max(1, Math.min(concurrency, items.length));
  for (let i = 0; i < n; i++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const item = queue.shift();
          if (item === undefined) break;
          await fn(item);
        }
      })(),
    );
  }
  await Promise.all(workers);
}
