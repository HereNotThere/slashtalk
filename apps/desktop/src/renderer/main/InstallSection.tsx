import { useEffect, useState } from 'react';
import type { McpInstallStatus } from '../../shared/types';

type Toast = { kind: 'ok' | 'err'; text: string } | null;

export function InstallSection(): JSX.Element {
  const [status, setStatus] = useState<McpInstallStatus | null>(null);
  const [mcpUrl, setMcpUrl] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast>(null);

  const refresh = async (): Promise<void> => {
    setStatus(await window.chatheads.mcp.status());
  };

  useEffect(() => {
    void refresh();
    void window.chatheads.mcp.url().then(setMcpUrl);
  }, []);

  const toggleClaudeCode = async (currently: boolean): Promise<void> => {
    setBusy(true);
    setToast(null);
    try {
      const result = currently
        ? await window.chatheads.mcp.uninstall('claude-code')
        : await window.chatheads.mcp.install('claude-code');
      await refresh();
      setToast({
        kind: 'ok',
        text: currently
          ? `Removed from ${result.path}`
          : `Wrote ${result.path} — restart Claude Code to load it.`,
      });
    } catch (err) {
      setToast({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const copyUrl = async (label: string): Promise<void> => {
    if (!mcpUrl) return;
    await window.chatheads.copyText(mcpUrl);
    setToast({ kind: 'ok', text: `Copied ${mcpUrl} — paste into ${label}.` });
  };

  const claudeCodeInstalled = status?.claudeCode.installed ?? false;

  return (
    <>
      <h2 className="m-0 text-[14px] text-muted mt-5 mb-2 uppercase tracking-[0.5px]">
        Install MCP
      </h2>
      <div className="text-xs text-subtle mb-2">
        Claude Code installs automatically. For Claude Desktop and claude.ai, copy the URL and paste into their &ldquo;Add connector&rdquo; dialog.
      </div>

      <div className="flex flex-col gap-1.5">
        {/* Claude Code — automated */}
        <div className="flex items-center gap-2.5 px-2.5 py-1.5 bg-card rounded-md">
          <span className="text-[13px]">Claude Code</span>
          <span className={`text-xs ${claudeCodeInstalled ? 'text-success' : 'text-subtle'}`}>
            {status === null ? 'checking…' : claudeCodeInstalled ? 'installed' : 'not installed'}
          </span>
          <button
            onClick={() => toggleClaudeCode(claudeCodeInstalled)}
            disabled={busy || status === null}
            className={`
              ml-auto rounded-md px-2.5 py-1 text-xs cursor-pointer
              border border-border
              disabled:opacity-60 disabled:cursor-wait
              ${
                claudeCodeInstalled
                  ? 'bg-button text-fg hover:bg-button-hover'
                  : 'bg-accent text-accent-fg hover:bg-accent-hover border-accent'
              }
            `}
          >
            {busy
              ? claudeCodeInstalled
                ? 'Removing…'
                : 'Installing…'
              : claudeCodeInstalled
                ? 'Remove'
                : 'Install'}
          </button>
        </div>

        {/* Claude Desktop — manual */}
        <CopyRow
          label="Claude Desktop"
          hint="click + in Connectors"
          onCopy={() => copyUrl('Claude Desktop → Connectors → +')}
          disabled={!mcpUrl}
        />

        {/* claude.ai — manual */}
        <CopyRow
          label="claude.ai"
          hint="Settings → Connectors"
          onCopy={() => copyUrl('claude.ai custom connector')}
          disabled={!mcpUrl}
        />
      </div>

      {toast && (
        <div
          className={`text-xs mt-2 ${
            toast.kind === 'ok' ? 'text-success' : 'text-danger'
          }`}
        >
          {toast.text}
        </div>
      )}
    </>
  );
}

function CopyRow({
  label,
  hint,
  onCopy,
  disabled,
}: {
  label: string;
  hint: string;
  onCopy: () => void;
  disabled: boolean;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2.5 px-2.5 py-1.5 bg-card rounded-md">
      <span className="text-[13px]">{label}</span>
      <span className="text-xs text-subtle">{hint}</span>
      <button
        onClick={onCopy}
        disabled={disabled}
        className="
          ml-auto bg-button border border-border text-fg
          rounded-md px-2.5 py-1 text-xs cursor-pointer
          hover:bg-button-hover disabled:opacity-60
        "
      >
        Copy URL
      </button>
    </div>
  );
}
