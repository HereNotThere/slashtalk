import { useState } from "react";
import { Button } from "../shared/Button";

// Minimal unified-diff parser. Good enough for `git diff` output without
// renames/binary headers — we feed it straight from /api/rooms/:id/patch.
interface DiffLine {
  kind: "context" | "add" | "del" | "meta";
  text: string;
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

interface DiffFile {
  filename: string;
  hunks: DiffHunk[];
  totalAdds: number;
  totalDels: number;
}

function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = raw.match(/ b\/(.+)$/);
      current = {
        filename: m ? m[1]! : raw,
        hunks: [],
        totalAdds: 0,
        totalDels: 0,
      };
      files.push(current);
      currentHunk = null;
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("@@")) {
      currentHunk = { header: raw, lines: [] };
      current.hunks.push(currentHunk);
      continue;
    }
    if (
      raw.startsWith("---") ||
      raw.startsWith("+++") ||
      raw.startsWith("index ") ||
      raw.startsWith("new file") ||
      raw.startsWith("deleted file") ||
      raw.startsWith("similarity ")
    ) {
      // Header noise — skip; we already captured the filename.
      continue;
    }
    if (!currentHunk) continue;
    if (raw.startsWith("+")) {
      currentHunk.lines.push({ kind: "add", text: raw.slice(1) });
      current.totalAdds += 1;
    } else if (raw.startsWith("-")) {
      currentHunk.lines.push({ kind: "del", text: raw.slice(1) });
      current.totalDels += 1;
    } else if (raw.startsWith("\\")) {
      currentHunk.lines.push({ kind: "meta", text: raw });
    } else {
      currentHunk.lines.push({ kind: "context", text: raw.startsWith(" ") ? raw.slice(1) : raw });
    }
  }
  return files;
}

function FileBlock({ file }: { file: DiffFile }): JSX.Element {
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="border border-border rounded-lg overflow-hidden bg-surface">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left bg-surface hover:bg-surface-hover transition-colors"
      >
        <span className="text-xs text-subtle">{expanded ? "▾" : "▸"}</span>
        <span className="font-mono text-sm flex-1 truncate">{file.filename}</span>
        <span className="text-xs text-success font-mono">+{file.totalAdds}</span>
        <span className="text-xs text-danger font-mono">-{file.totalDels}</span>
      </button>
      {expanded && (
        <div className="font-mono text-xs leading-relaxed bg-code/50 overflow-x-auto">
          {file.hunks.map((hunk, hi) => (
            <div key={hi}>
              <div className="px-3 py-1 text-subtle bg-surface-strong/40 border-y border-border">
                {hunk.header}
              </div>
              {hunk.lines.map((line, li) => (
                <div
                  key={li}
                  className={
                    "px-3 whitespace-pre " +
                    (line.kind === "add"
                      ? "bg-success/10 text-fg"
                      : line.kind === "del"
                        ? "bg-danger/10 text-fg"
                        : line.kind === "meta"
                          ? "text-subtle italic"
                          : "text-fg/70")
                  }
                >
                  <span className="select-none mr-2 text-subtle">
                    {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                  </span>
                  {line.text || " "}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function DiffView({
  patch,
  onApply,
  onDownload,
  applying,
}: {
  patch: string;
  onApply: () => void;
  onDownload: () => void;
  applying: boolean;
}): JSX.Element {
  const files = parseDiff(patch);

  if (files.length === 0) {
    return <div className="text-sm text-subtle italic px-3 py-2">No changes in working tree.</div>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-1">
        <span className="text-xs text-subtle">
          {files.length} file{files.length === 1 ? "" : "s"} changed
        </span>
        <div className="flex-1" />
        <Button variant="primary" size="sm" onClick={onApply} disabled={applying}>
          {applying ? "Applying…" : "Apply to local repo"}
        </Button>
        <Button variant="secondary" size="sm" onClick={onDownload}>
          Download .patch
        </Button>
      </div>
      {files.map((file) => (
        <FileBlock key={file.filename} file={file} />
      ))}
    </div>
  );
}
