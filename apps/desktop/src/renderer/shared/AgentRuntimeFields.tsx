import { useState } from 'react';
import type { McpServerInput, TrackedRepo } from '../../shared/types';

// Known MCP servers the user can one-click add. Covers common services that
// expose a hosted MCP endpoint — Anthropic handles OAuth discovery when the
// agent first calls a tool that needs it.
export const MCP_PRESETS: McpServerInput[] = [
  { name: 'github', url: 'https://api.githubcopilot.com/mcp/' },
  { name: 'linear', url: 'https://mcp.linear.app/mcp' },
  { name: 'sentry', url: 'https://mcp.sentry.dev/mcp' },
  { name: 'slack', url: 'https://mcp.slack.com/mcp' },
];

export function ModeButton({
  active,
  onClick,
  title,
  disabled = false,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  const base = 'text-[12px] px-3 py-1 rounded-md border transition-colors ';
  const state = disabled
    ? 'bg-button/40 border-border text-subtle cursor-not-allowed opacity-60'
    : active
      ? 'bg-accent/15 border-accent text-accent cursor-pointer'
      : 'bg-button border-border text-fg hover:bg-button-hover cursor-pointer';
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={base + state}
    >
      {children}
    </button>
  );
}

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
        <button
          onClick={choose}
          className="
            inline-flex items-center gap-1.5
            bg-button border border-border text-fg
            rounded-md px-2.5 py-1 text-xs cursor-pointer
            hover:bg-button-hover shrink-0
          "
        >
          <FolderIcon />
          Choose folder…
        </button>
        <div
          className={
            'flex-1 min-w-0 text-[12px] font-mono truncate px-2 py-1 rounded-md border ' +
            (value
              ? 'bg-bg border-border text-fg'
              : 'bg-transparent border-transparent text-subtle')
          }
          title={value || 'Defaults to your home folder'}
        >
          {value ? prettyPath(value) : 'No folder selected — defaults to $HOME'}
        </div>
        {value && (
          <button
            onClick={() => onChange('')}
            title="Clear"
            className="text-subtle hover:text-fg text-xs px-1 cursor-pointer bg-transparent border-none"
          >
            ✕
          </button>
        )}
      </div>
      {trackedRepos.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-0.5">
          <span className="text-[10px] uppercase tracking-wider text-subtle self-center mr-1">
            Tracked
          </span>
          {trackedRepos.map((r) => (
            <button
              key={r.repoId}
              onClick={() => onChange(r.localPath)}
              title={r.localPath}
              className="text-[11px] px-1.5 py-0.5 rounded-full bg-button hover:bg-button-hover border border-border cursor-pointer"
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
  if (home) return `~${home[1] ?? ''}`;
  return p;
}

function FolderIcon(): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2 4.5 Q2 3.5 3 3.5 H6.5 L8 5 H13 Q14 5 14 6 V11.5 Q14 12.5 13 12.5 H3 Q2 12.5 2 11.5 Z" />
    </svg>
  );
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
  const [customName, setCustomName] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [customExpanded, setCustomExpanded] = useState(false);

  const presetsNotAdded = MCP_PRESETS.filter(
    (p) => !servers.some((s) => s.name === p.name),
  );

  const addCustom = (): void => {
    const n = customName.trim();
    const u = customUrl.trim();
    if (!n || !u) return;
    onAdd({ name: n, url: u });
    setCustomName('');
    setCustomUrl('');
    setCustomExpanded(false);
  };

  return (
    <div>
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-subtle mb-1">
        MCP servers (optional)
      </div>
      {servers.length > 0 && (
        <div className="flex flex-col gap-1 mb-1">
          {servers.map((s) => (
            <div
              key={s.name}
              className="flex items-center gap-2 px-2 py-1 bg-bg rounded-md border border-border"
            >
              <span className="text-[12px] font-mono">{s.name}</span>
              <span className="text-[11px] text-subtle font-mono truncate flex-1">
                {s.url}
              </span>
              <button
                onClick={() => onRemove(s.name)}
                className="bg-transparent border-none text-subtle cursor-pointer hover:text-fg text-xs"
                title="Remove"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-1">
        {presetsNotAdded.map((p) => (
          <button
            key={p.name}
            onClick={() => onAdd(p)}
            className="text-[11px] px-2 py-0.5 rounded-full bg-button hover:bg-button-hover border border-border cursor-pointer"
            title={p.url}
          >
            + {p.name}
          </button>
        ))}
        <button
          onClick={() => setCustomExpanded((v) => !v)}
          className="text-[11px] px-2 py-0.5 rounded-full bg-button hover:bg-button-hover border border-border cursor-pointer"
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
            className="w-24 bg-bg border border-border rounded-md px-2 py-1 text-[12px] font-mono outline-none focus:border-accent"
          />
          <input
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
            placeholder="https://example.com/mcp"
            className="flex-1 bg-bg border border-border rounded-md px-2 py-1 text-[12px] font-mono outline-none focus:border-accent"
          />
          <button
            onClick={addCustom}
            disabled={!customName.trim() || !customUrl.trim()}
            className="text-[12px] px-2 py-1 rounded-md bg-fg text-bg cursor-pointer disabled:opacity-50"
          >
            add
          </button>
        </div>
      )}

      <div className="text-[11px] text-subtle mt-1">
        OAuth-protected servers (like github) will prompt for authorization the
        first time the agent uses them.
      </div>
    </div>
  );
}
