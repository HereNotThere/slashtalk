import { useEffect, useState } from "react";
import { Checkbox } from "./Checkbox";
import type { DashboardScope, McpInstallStatus, McpTarget, ThemeMode } from "../../shared/types";

const MCP_TARGETS: McpTarget[] = ["claude-code", "codex"];

export function RailPreferences(): JSX.Element {
  const [pinned, setPinned] = useState<boolean>(true);
  const [sessionOnly, setSessionOnly] = useState<boolean>(false);
  const [collapseInactive, setCollapseInactive] = useState<boolean>(false);
  const [showActivityTimestamps, setShowActivityTimestamps] = useState<boolean>(true);
  const [spotifySupported, setSpotifySupported] = useState<boolean>(false);
  const [spotifyShare, setSpotifyShare] = useState<boolean>(false);
  const [theme, setTheme] = useState<ThemeMode>("system");
  const [dashboardScope, setDashboardScope] = useState<DashboardScope>("today");

  useEffect(() => {
    let alive = true;
    void window.chatheads.rail.getPinned().then((v) => {
      if (alive) setPinned(v);
    });
    const off = window.chatheads.rail.onPinnedChange((v) => setPinned(v));
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void window.chatheads.rail.getSessionOnlyMode().then((v) => {
      if (alive) setSessionOnly(v);
    });
    const off = window.chatheads.rail.onSessionOnlyModeChange((v) => setSessionOnly(v));
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void window.chatheads.rail.getCollapseInactive().then((v) => {
      if (alive) setCollapseInactive(v);
    });
    const off = window.chatheads.rail.onCollapseInactiveChange((v) => setCollapseInactive(v));
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void window.chatheads.rail.getShowActivityTimestamps().then((v) => {
      if (alive) setShowActivityTimestamps(v);
    });
    const off = window.chatheads.rail.onShowActivityTimestampsChange((v) =>
      setShowActivityTimestamps(v),
    );
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void window.chatheads.spotifyShare.isSupported().then((v) => {
      if (alive) setSpotifySupported(v);
    });
    void window.chatheads.spotifyShare.getEnabled().then((v) => {
      if (alive) setSpotifyShare(v);
    });
    const off = window.chatheads.spotifyShare.onEnabledChange((v) => setSpotifyShare(v));
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void window.chatheads.theme.getMode().then((v) => {
      if (alive) setTheme(v);
    });
    const off = window.chatheads.theme.onModeChange((v) => setTheme(v));
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void window.chatheads.rail.getDashboardScope().then((v) => {
      if (alive) setDashboardScope(v);
    });
    const off = window.chatheads.rail.onDashboardScopeChange((v) => setDashboardScope(v));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const onPinnedChange = (v: boolean): void => {
    setPinned(v);
    void window.chatheads.rail.setPinned(v);
  };
  const onSessionOnlyChange = (v: boolean): void => {
    setSessionOnly(v);
    void window.chatheads.rail.setSessionOnlyMode(v);
  };
  const onCollapseInactiveChange = (v: boolean): void => {
    setCollapseInactive(v);
    void window.chatheads.rail.setCollapseInactive(v);
  };
  const onShowActivityTimestampsChange = (v: boolean): void => {
    setShowActivityTimestamps(v);
    void window.chatheads.rail.setShowActivityTimestamps(v);
  };
  const onSpotifyShareChange = (v: boolean): void => {
    setSpotifyShare(v);
    void window.chatheads.spotifyShare.setEnabled(v);
  };
  const onThemeChange = (mode: ThemeMode): void => {
    setTheme(mode);
    void window.chatheads.theme.setMode(mode);
  };
  const onDashboardScopeChange = (scope: DashboardScope): void => {
    setDashboardScope(scope);
    void window.chatheads.rail.setDashboardScope(scope);
  };

  return (
    <>
      <McpRow />
      <PinRow pinned={pinned} onChange={onPinnedChange} />
      <SessionOnlyRow enabled={sessionOnly} disabled={pinned} onChange={onSessionOnlyChange} />
      <CollapseInactiveRow enabled={collapseInactive} onChange={onCollapseInactiveChange} />
      <ShowActivityTimestampsRow
        shown={showActivityTimestamps}
        onChange={onShowActivityTimestampsChange}
      />
      {spotifySupported ? (
        <SpotifyShareRow enabled={spotifyShare} onChange={onSpotifyShareChange} />
      ) : null}
      <DashboardScopeRow value={dashboardScope} onChange={onDashboardScopeChange} />
      <ThemeRow value={theme} onChange={onThemeChange} />
    </>
  );
}

function McpRow(): JSX.Element {
  const [status, setStatus] = useState<McpInstallStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = async (
    shouldApply: () => boolean = () => true,
  ): Promise<McpInstallStatus | null> => {
    try {
      const next = await window.chatheads.mcp.status();
      if (shouldApply()) {
        setStatus(next);
        setError(null);
      }
      return next;
    } catch (err) {
      if (shouldApply()) setError((err as Error).message);
      return null;
    }
  };

  useEffect(() => {
    let cancelled = false;
    void refreshStatus(() => !cancelled);
    const off = window.chatheads.mcp.onStatusChange((next) => {
      if (!cancelled) {
        setStatus(next);
        setError(null);
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const connected = status ? status.claudeCode.installed || status.codex.installed : false;
  const disabled = busy;

  const onToggle = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    if (!status) {
      await refreshStatus();
      setBusy(false);
      return;
    }

    let opError: Error | null = null;
    const enabled = !connected;

    for (const target of MCP_TARGETS) {
      try {
        if (enabled) {
          await window.chatheads.mcp.install(target);
        } else {
          await window.chatheads.mcp.uninstall(target);
        }
      } catch (err) {
        opError ??= err as Error;
      }
    }

    try {
      const next = await window.chatheads.mcp.status();
      setStatus(next);
    } catch (err) {
      opError ??= err as Error;
    }
    if (opError) setError(opError.message);
    setBusy(false);
  };

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => void onToggle()}
        className={`
          w-full flex items-center gap-2 px-1.5 py-1 rounded-md
          bg-transparent border-none text-fg [font:inherit]
          text-left
          ${disabled ? "opacity-60 cursor-default" : "cursor-pointer hover:bg-surface-alt"}
        `}
      >
        <Checkbox checked={connected} />
        <span className="flex-1 text-base">Install MCP</span>
      </button>
      {error ? (
        <div className="text-sm px-1.5 -mt-0.5 mb-1 leading-snug text-danger">{error}</div>
      ) : null}
    </>
  );
}

function PinRow({
  pinned,
  onChange,
}: {
  pinned: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onChange(!pinned)}
      className="
        w-full flex items-center gap-2 px-1.5 py-1 rounded-md
        bg-transparent border-none text-fg cursor-pointer [font:inherit]
        hover:bg-surface-alt
        text-left
      "
    >
      <Checkbox checked={pinned} />
      <span className="flex-1 text-base">Keep dock on top</span>
    </button>
  );
}

function SessionOnlyRow({
  enabled,
  disabled,
  onChange,
}: {
  enabled: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      title={disabled ? "Turn off \u201cKeep dock on top\u201d to use this mode" : undefined}
      className={`
        w-full flex items-center gap-2 px-1.5 py-1 rounded-md
        bg-transparent border-none text-fg [font:inherit]
        text-left
        ${disabled ? "opacity-40 cursor-default" : "cursor-pointer hover:bg-surface-alt"}
      `}
    >
      <Checkbox checked={enabled} />
      <span className="flex-1 text-base">Show dock only during active sessions</span>
    </button>
  );
}

function CollapseInactiveRow({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onChange(!enabled)}
      className="
        w-full flex items-center gap-2 px-1.5 py-1 rounded-md
        bg-transparent border-none text-fg cursor-pointer [font:inherit]
        hover:bg-surface-alt
        text-left
      "
    >
      <Checkbox checked={enabled} />
      <span className="flex-1 text-base">Stack inactive teammates</span>
    </button>
  );
}

function ShowActivityTimestampsRow({
  shown,
  onChange,
}: {
  shown: boolean;
  onChange: (shown: boolean) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onChange(!shown)}
      className="
        w-full flex items-center gap-2 px-1.5 py-1 rounded-md
        bg-transparent border-none text-fg cursor-pointer [font:inherit]
        hover:bg-surface-alt
        text-left
      "
    >
      <Checkbox checked={shown} />
      <span className="flex-1 text-base">Show activity timestamps</span>
    </button>
  );
}

function SpotifyShareRow({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onChange(!enabled)}
      title={enabled ? undefined : "macOS will ask for automation permission"}
      className="
        w-full flex items-center gap-2 px-1.5 py-1 rounded-md
        bg-transparent border-none text-fg cursor-pointer [font:inherit]
        hover:bg-surface-alt
        text-left
      "
    >
      <Checkbox checked={enabled} />
      <span className="flex-1 text-base">Share Spotify Now Playing</span>
    </button>
  );
}

function DashboardScopeRow({
  value,
  onChange,
}: {
  value: DashboardScope;
  onChange: (scope: DashboardScope) => void;
}): JSX.Element {
  // Marked "experimental" until we've watched a few teams use the past24h
  // mode in mixed-tz situations and decide whether to flip the default.
  const opts: { scope: DashboardScope; label: string }[] = [
    { scope: "today", label: "Today" },
    { scope: "past24h", label: "Past 24h" },
  ];
  return (
    <div className="flex items-center gap-2 px-1.5 py-1">
      <span className="flex-1 text-base text-fg">
        Window <span className="text-xs text-subtle">(experimental)</span>
      </span>
      <div className="flex rounded-md bg-surface-alt p-0.5 gap-0.5">
        {opts.map((o) => {
          const active = value === o.scope;
          return (
            <button
              key={o.scope}
              type="button"
              onClick={() => onChange(o.scope)}
              aria-pressed={active}
              className={`
                px-2 py-0.5 rounded text-xs [font:inherit] cursor-pointer border-none
                ${active ? "bg-bg text-fg" : "bg-transparent text-fg/60 hover:text-fg"}
              `}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ThemeRow({
  value,
  onChange,
}: {
  value: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}): JSX.Element {
  const opts: { mode: ThemeMode; label: string }[] = [
    { mode: "system", label: "System" },
    { mode: "light", label: "Light" },
    { mode: "dark", label: "Dark" },
  ];
  return (
    <div className="flex items-center gap-2 px-1.5 py-1">
      <span className="flex-1 text-base text-fg">Theme</span>
      <div className="flex rounded-md bg-surface-alt p-0.5 gap-0.5">
        {opts.map((o) => {
          const active = value === o.mode;
          return (
            <button
              key={o.mode}
              type="button"
              onClick={() => onChange(o.mode)}
              aria-pressed={active}
              className={`
                px-2 py-0.5 rounded text-xs [font:inherit] cursor-pointer border-none
                ${active ? "bg-bg text-fg" : "bg-transparent text-fg/60 hover:text-fg"}
              `}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
