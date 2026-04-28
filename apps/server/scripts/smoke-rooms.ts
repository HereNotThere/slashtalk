#!/usr/bin/env bun
// End-to-end smoke test for the rooms sandbox adapter. Provisions an E2B
// sandbox with a tiny public repo, runs TWO agent turns, and verifies that
// --resume continuity worked: turn 1 sets a fact, turn 2 must recall it
// without re-reading the file.
//
// Roughly $0.10 in E2B + Anthropic spend per run.
//
// Run from apps/server/:
//   ROOMS_ENABLED=true ANTHROPIC_API_KEY=sk-ant-... bun run scripts/smoke-rooms.ts
//
// E2B_API_KEY is read from .env automatically. The other required server env
// vars (DATABASE_URL etc.) are stubbed below — this script doesn't touch the DB.

// Stub the env vars that config.ts requires at boot but this script doesn't use.
process.env.DATABASE_URL ??= "postgres://stub:stub@localhost:5452/stub";
process.env.REDIS_URL ??= "redis://localhost:6399";
process.env.GITHUB_CLIENT_ID ??= "stub";
process.env.GITHUB_CLIENT_SECRET ??= "stub";
process.env.JWT_SECRET ??= "stub";
process.env.ENCRYPTION_KEY ??= "0".repeat(64);
process.env.BASE_URL ??= "http://localhost:10000";

const { e2bAdapter } = await import("../src/rooms/sandbox");
import type { AgentEvent } from "../src/rooms/sandbox";

const REPO = "https://github.com/octocat/Hello-World.git";
const TURN_1 =
  "Remember this fact: my favorite color is octocat-green. " +
  "Just acknowledge — don't write any files.";
const TURN_2 =
  "What favorite color did I just tell you? Answer in one word — don't read any files.";

function summarizeEvent(event: AgentEvent): string {
  if (event.type === "system") return `[system] session=${event.session_id ?? "?"}`;
  if (event.type === "assistant") {
    const msg = event.message as { content?: Array<{ type: string; text?: string }> } | undefined;
    const text =
      msg?.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("")
        .trim() ?? "";
    return `[assistant] ${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`;
  }
  if (event.type === "result") return `[result] ${(event.result ?? "").slice(0, 200)}`;
  return `[${event.type}]`;
}

async function runTurn(
  sandboxId: string,
  label: string,
  prompt: string,
): Promise<{ text: string; sessionId: string | null }> {
  console.log(`\n→ ${label}: ${prompt}`);
  const t = Date.now();
  const result = await e2bAdapter.runAgentTurn(sandboxId, {
    prompt,
    onEvent: (event) => console.log("  " + summarizeEvent(event)),
    onStderr: (chunk) => process.stderr.write(chunk),
  });
  console.log(
    `  done  exit=${result.exitCode}  session=${result.sessionId ?? "?"}  ` +
      `diff=${result.diffStat.filesChanged}f +${result.diffStat.insertions} -${result.diffStat.deletions}  ` +
      `(${((Date.now() - t) / 1000).toFixed(1)}s)`,
  );
  console.log(`  final text: ${result.text.trim()}`);
  return { text: result.text, sessionId: result.sessionId };
}

async function main(): Promise<void> {
  console.log("→ Provisioning sandbox (clones repo + installs claude-code, ~30s)...");
  const t0 = Date.now();
  const { sandboxId } = await e2bAdapter.provision({
    repoCloneUrl: REPO,
    gitUser: { name: "Slashtalk Smoke", email: "smoke@slashtalk.local" },
    agentDef: {
      systemPrompt: "You are a concise coding agent. Acknowledge briefly when asked to remember.",
      model: "claude-haiku-4-5-20251001",
    },
  });
  console.log(`  sandbox=${sandboxId}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  try {
    const t1 = await runTurn(sandboxId, "Turn 1", TURN_1);
    const t2 = await runTurn(sandboxId, "Turn 2", TURN_2);

    console.log("\n→ Continuity check:");
    if (t1.sessionId && t2.sessionId === t1.sessionId) {
      console.log(`  ✓ session id preserved (${t1.sessionId})`);
    } else {
      console.log(
        `  ✗ session id changed: turn1=${t1.sessionId ?? "?"} turn2=${t2.sessionId ?? "?"}`,
      );
    }
    if (/octocat-green/i.test(t2.text)) {
      console.log("  ✓ turn 2 recalled the color");
    } else {
      console.log("  ✗ turn 2 did NOT recall the color — --resume not working as expected");
    }
  } finally {
    console.log("\n→ Destroying sandbox...");
    await e2bAdapter.destroy(sandboxId);
    console.log("  done");
  }
}

main().catch((err) => {
  console.error("smoke test failed:", err);
  process.exit(1);
});
