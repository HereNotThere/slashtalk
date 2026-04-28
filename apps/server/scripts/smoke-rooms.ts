#!/usr/bin/env bun
// End-to-end smoke test for the rooms sandbox adapter. Provisions an E2B
// sandbox with a tiny public repo, runs one agent turn that creates a file,
// pulls the diff, and tears down. Roughly $0.05 in E2B + Anthropic spend.
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

const REPO = "https://github.com/octocat/Hello-World.git"; // tiny public repo
const PROMPT = "Create a file called smoke.txt with the contents 'rooms work'. No other changes.";

async function main(): Promise<void> {
  console.log("→ Provisioning sandbox (clones repo + installs claude-code, ~30s)...");
  const t0 = Date.now();
  const { sandboxId } = await e2bAdapter.provision({
    repoCloneUrl: REPO,
    gitUser: { name: "Slashtalk Smoke", email: "smoke@slashtalk.local" },
    agentDef: {
      systemPrompt: "You are a coding agent. Make small, precise changes.",
      model: "claude-haiku-4-5-20251001",
    },
  });
  console.log(`  sandbox=${sandboxId}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  try {
    console.log(`→ Running turn: ${PROMPT}`);
    const t1 = Date.now();
    const result = await e2bAdapter.runAgentTurn(sandboxId, {
      prompt: PROMPT,
      onStdout: (chunk) => process.stdout.write(chunk),
      onStderr: (chunk) => process.stderr.write(chunk),
    });
    console.log(
      `\n  exit=${result.exitCode}  diff=${result.diffStat.filesChanged}f +${result.diffStat.insertions} -${result.diffStat.deletions}  (${((Date.now() - t1) / 1000).toFixed(1)}s)`,
    );

    console.log("→ Fetching full diff:");
    const diff = await e2bAdapter.diff(sandboxId);
    console.log(diff || "(empty)");
  } finally {
    console.log("→ Destroying sandbox...");
    await e2bAdapter.destroy(sandboxId);
    console.log("  done");
  }
}

main().catch((err) => {
  console.error("smoke test failed:", err);
  process.exit(1);
});
