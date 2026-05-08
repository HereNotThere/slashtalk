type JsonObj = Record<string, unknown>;

function isObj(v: unknown): v is JsonObj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sanitizePiValue(value: unknown, insideImage: boolean = false): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizePiValue(item, insideImage));
  if (!isObj(value)) return value;

  const isImage = insideImage || value.type === "image";
  const out: JsonObj = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "thinkingSignature" || key === "textSignature" || key === "encrypted_content") {
      continue;
    }
    if (isImage && key === "data" && typeof child === "string") {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = sanitizePiValue(child, isImage);
  }
  return out;
}

function sanitizePiLine(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (isObj(parsed) && (parsed.type === "custom" || parsed.type === "custom_message")) {
      return null;
    }
    return JSON.stringify(sanitizePiValue(parsed));
  } catch {
    return JSON.stringify({ type: "malformed", malformed: true });
  }
}

export function sanitizePiChunk(chunk: Buffer): string {
  const raw = chunk.toString("utf8");
  const lines = raw.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const sanitized = lines
    .map((line) => (line.trim() ? sanitizePiLine(line) : null))
    .filter((line): line is string => line !== null);
  return sanitized.length > 0 ? `${sanitized.join("\n")}\n` : "";
}
