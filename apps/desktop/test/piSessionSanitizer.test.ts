import { describe, expect, it } from "bun:test";
import { sanitizePiChunk } from "../src/main/piSessionSanitizer";

function lines(body: string): unknown[] {
  return body
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

describe("sanitizePiChunk", () => {
  it("drops extension-authored custom entries", () => {
    const body = sanitizePiChunk(
      Buffer.from(
        [
          JSON.stringify({ type: "custom", data: { token: "secret" } }),
          JSON.stringify({ type: "custom_message", content: "secret context" }),
          JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
        ].join("\n") + "\n",
      ),
    );

    const out = lines(body);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ type: "message", message: { role: "user", content: "hello" } });
  });

  it("strips Pi signature fields and redacts image bytes", () => {
    const body = sanitizePiChunk(
      Buffer.from(
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "working",
                thinkingSignature: { encrypted_content: "ciphertext" },
              },
              {
                type: "text",
                text: "done",
                textSignature: { encrypted_content: "text-ciphertext" },
              },
              {
                type: "image",
                data: "BASE64_BYTES",
                source: { data: "NESTED_BASE64_BYTES" },
              },
            ],
          },
        }) + "\n",
      ),
    );

    expect(body).not.toContain("ciphertext");
    expect(body).not.toContain("BASE64_BYTES");
    expect(body).toContain('"data":"[redacted]"');
  });
});
