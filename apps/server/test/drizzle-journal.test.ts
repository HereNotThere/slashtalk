import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

type JournalEntry = {
  idx: number;
  when: number;
  tag: string;
};

const journal = JSON.parse(
  readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
) as { entries: JournalEntry[] };

describe("drizzle migration journal", () => {
  test("keeps migration indexes aligned with filenames", () => {
    for (const [index, entry] of journal.entries.entries()) {
      expect(entry.idx).toBe(index);
      expect(entry.tag.startsWith(String(index).padStart(4, "0"))).toBe(true);
    }
  });

  test("latest migration can advance production past the highest applied timestamp", () => {
    const maxWhen = Math.max(...journal.entries.map((entry) => entry.when));
    const latest = journal.entries.at(-1);

    expect(latest?.when).toBe(maxWhen);
  });
});
