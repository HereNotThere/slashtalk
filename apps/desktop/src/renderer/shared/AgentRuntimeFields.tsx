import { useState } from "react";
import { FolderIcon } from "@heroicons/react/24/outline";
import { XMarkIcon } from "@heroicons/react/20/solid";
import { Button } from "./Button";
import type { McpServerInput, TrackedRepo } from "../../shared/types";

// Known MCP servers the user can one-click add. Covers common services that
// expose a hosted MCP endpoint — Anthropic handles OAuth discovery when the
// agent first calls a tool that needs it.
export const MCP_PRESETS: McpServerInput[] = [
  { name: "github", url: "https://api.githubcopilot.com/mcp/" },
  { name: "linear", url: "https://mcp.linear.app/mcp" },
  { name: "sentry", url: "https://mcp.sentry.dev/mcp" },
  { name: "slack", url: "https://mcp.slack.com/mcp" },
];

export function CwdPicker({
  value,
  onChange,
  trackedRepos,
}: {
  value: string;
  onChange: (v: string) => void;
  trackedRepos: TrackedRepo[];
}): JSX.Element {
  const choose = async (): Promise<void> => {
    const picked = await window.chatheads.selectDirectory(value || undefined);
    if (picked) onChange(picked);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <Button
          variant="secondary"
          size="sm"
          onClick={choose}
          icon={<FolderIcon className="w-4 h-4" />}
        >
          Choose folder…
        </Button>
        <div
          className={
            "flex-1 min-w-0 text-sm font-mono truncate px-2 py-1 rounded-md border " +
            (value
              ? "bg-bg border-border text-fg"
              : "bg-transparent border-transparent text-subtle")
          }
          title={value || "Defaults to your home folder"}
        >
          {value ? prettyPath(value) : "No folder selected — defaults to $HOME"}
        </div>
        {value && (
          <Button
            variant="ghost"
            size="sm"
            round
            onClick={() => onChange("")}
            aria-label="Clear"
            icon={<XMarkIcon className="w-4 h-4" />}
          />
        )}
      </div>
      {trackedRepos.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-0.5">
          <span className="text-xs uppercase tracking-wider text-subtle self-center mr-1">
            Tracked
          </span>
          {trackedRepos.map((r) => (
            <button
              key={r.repoId}
              type="button"
              onClick={() => onChange(r.localPath)}
              title={r.localPath}
              className="text-xs px-2 py-0.5 rounded-full bg-surface-alt hover:bg-surface-alt-hover border border-border cursor-pointer"
            >
              {r.fullName}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function prettyPath(p: string): string {
  const home = p.match(/^\/Users\/[^/]+(\/.*)?$/);
  if (home) return `~${home[1] ?? ""}`;
  return p;
}

export function McpServersField({
  servers,
  onAdd,
  onRemove,
}: {
  servers: McpServerInput[];
  onAdd: (s: McpServerInput) => void;
  onRemove: (name: string) => void;
}): JSX.Element {
  const [customName, setCustomName] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [customExpanded, setCustomExpanded] = useState(false);

  const presetsNotAdded = MCP_PRESETS.filter((p) => !servers.some((s) => s.name === p.name));

  const addCustom = (): void => {
    const n = customName.trim();
    const u = customUrl.trim();
    if (!n || !u) return;
    onAdd({ name: n, url: u });
    setCustomName("");
    setCustomUrl("");
    setCustomExpanded(false);
  };

  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wider text-subtle mb-1">
        MCP servers (optional)
      </div>
      {servers.length > 0 && (
        <div className="flex flex-col gap-1 mb-1">
          {servers.map((s) => (
            <div
              key={s.name}
              className="flex items-center gap-2 px-2 py-1 bg-bg rounded-md border border-border"
            >
              <span className="text-sm font-mono">{s.name}</span>
              <span className="text-xs text-subtle font-mono truncate flex-1">{s.url}</span>
              <Button
                variant="ghost"
                size="sm"
                round
                onClick={() => onRemove(s.name)}
                aria-label="Remove"
                icon={<XMarkIcon className="w-4 h-4" />}
              />
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-1">
        {presetsNotAdded.map((p) => (
          <button
            key={p.name}
            type="button"
            onClick={() => onAdd(p)}
            className="text-xs px-2 py-0.5 rounded-full bg-surface-alt hover:bg-surface-alt-hover border border-border cursor-pointer"
            title={p.url}
          >
            + {p.name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setCustomExpanded((v) => !v)}
          className="text-xs px-2 py-0.5 rounded-full bg-surface-alt hover:bg-surface-alt-hover border border-border cursor-pointer"
        >
          + custom
        </button>
      </div>

      {customExpanded && (
        <div className="flex gap-1 mt-1">
          <input
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
            placeholder="name"
            className="w-24 bg-bg border border-border rounded-md px-2 py-1 text-sm font-mono outline-none focus:border-primary"
          />
          <input
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
            placeholder="https://example.com/mcp"
            className="flex-1 bg-bg border border-border rounded-md px-2 py-1 text-sm font-mono outline-none focus:border-primary"
          />
          <Button
            variant="primary"
            size="sm"
            onClick={addCustom}
            disabled={!customName.trim() || !customUrl.trim()}
          >
            add
          </Button>
        </div>
      )}

      <div className="text-xs text-subtle mt-1">
        OAuth-protected servers (like github) will prompt for authorization the first time the agent
        uses them.
      </div>
    </div>
  );
}
