import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { MODELS } from "../models";

const MAX_TOKENS = 400;
const COUNT = 6;
const MAX_PHRASE_CHARS = 48;
const FALLBACK: string[] = ["Thinking"];

const SYSTEM = `You generate short "thinking state" phrases shown in the loading indicator while the slashtalk team-presence assistant works on a user's question. The UI cycles through them one-by-one so the user sees them alternate while waiting. They should read like a live status of what the assistant is ACTUALLY doing to answer the user — not generic platitudes.

Background — what the slashtalk assistant can actually do:
- It has tools that list teammates' recent Claude Code sessions across shared GitHub repos, and that fetch details on a single session (current prompt, files being edited, tool calls, token spend, LLM-generated title/summary).
- It synthesizes a per-teammate roll-up: who is working on what, which repos, which files, session state (busy/active/idle/recent).
- It can cite specific sessions it looked at.

Analyze the user's prompt and produce ${COUNT} distinct, short present-progressive phrases that describe what the assistant would plausibly be doing to answer THIS specific question. Each phrase should capture a different step or angle of the work. Be concrete and specific to the user's message — not generic. Phrases should read naturally, like status lines in a progress indicator (e.g. "Checking team sessions", "Gathering more info", "Pulling up your teammates' repos", "Scanning recent Claude Code activity", "Reading session summaries", "Lining up the highlights").

Style:
- Positive, cheerful, lightly playful. A little whimsy is welcome but don't sacrifice clarity.
- Concrete verbs tied to the actual work: checking, gathering, scanning, reading, reviewing, pulling, lining up, stitching together, cross-referencing, zooming in, peeking at, tallying, summarizing, comparing, etc.
- Reflect the user's topic in the noun phrase (team sessions, repos, files, pull requests, summaries, etc.) when relevant.

Strict rules:
- Output exactly ${COUNT} lines, one phrase per line. No numbering, no bullets, no quotes, no trailing punctuation, no emoji, no explanation, no blank lines.
- Each phrase: 2 to 6 words, present-progressive form (starts with an -ing verb), max ${MAX_PHRASE_CHARS} characters.
- Capitalize only the first letter of the phrase. The rest is lowercase unless it's a proper noun.
- Each phrase must be distinct in meaning — don't just reword the same idea.
- NEVER use alarming/concerning verbs: connecting, disconnecting, reconnecting, retrying, lagging, freezing, waiting, hanging, loading, buffering, throttling.
- NEVER use destructive verbs: terminating, killing, deleting, destroying, stopping, exiting, aborting, crashing, failing, removing, erasing, dropping.
- NEVER use potentially offensive or derogatory verbs: penetrating, probing, exploiting, hacking, stalking.

Output format: exactly ${COUNT} lines, each one short phrase, nothing else.`;

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    if (!config.anthropicApiKey) {
      throw new Error("ANTHROPIC_API_KEY not set");
    }
    _client = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  return _client;
}

const BANNED_TOKENS = [
  "connecting",
  "disconnecting",
  "reconnecting",
  "retrying",
  "lagging",
  "freezing",
  "waiting",
  "hanging",
  "loading",
  "buffering",
  "throttling",
  "terminating",
  "killing",
  "deleting",
  "destroying",
  "stopping",
  "exiting",
  "aborting",
  "crashing",
  "failing",
  "removing",
  "erasing",
  "dropping",
  "penetrating",
  "probing",
  "exploiting",
  "hacking",
  "stalking",
];

function containsBanned(text: string): boolean {
  const lower = text.toLowerCase();
  for (const token of BANNED_TOKENS) {
    if (new RegExp(`\\b${token}\\b`).test(lower)) return true;
  }
  return false;
}

// Strip wrapping quotes/bullets/numbering, collapse whitespace. We still allow
// internal punctuation like apostrophes so phrases like "your teammates' repos"
// survive. Trailing punctuation is trimmed since the UI appends "...".
function sanitizeOne(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  s = s.replace(/^[\s\-\u2022\u00B7*]+/, "");
  s = s.replace(/^\d+[.)\]]\s*/, "");
  s = s.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "");
  s = s.replace(/[.!?…,;:\s]+$/g, "");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (s.length > MAX_PHRASE_CHARS) return null;
  const words = s.split(" ");
  if (words.length < 1 || words.length > 8) return null;
  if (!/^[A-Za-z][A-Za-z-]*ing\b/i.test(words[0])) return null;
  if (containsBanned(s)) return null;
  return s[0].toUpperCase() + s.slice(1);
}

function sanitizeList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const phrase = sanitizeOne(line);
    if (!phrase) continue;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(phrase);
    if (out.length >= COUNT) break;
  }
  return out.length > 0 ? out : FALLBACK;
}

export async function generateGerunds(prompt: string): Promise<string[]> {
  if (!config.anthropicApiKey) return FALLBACK;
  try {
    const resp = await client().messages.create({
      model: MODELS.haiku,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: "text",
          text: SYSTEM,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content
      .filter((c) => c.type === "text")
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("")
      .trim();
    return sanitizeList(text);
  } catch (err) {
    console.error("[gerund] generation failed:", err);
    return FALLBACK;
  }
}
