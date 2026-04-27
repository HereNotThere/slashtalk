import { useEffect, useState } from "react";
import type { BackendAuthState, GithubAppStatus, TrackedRepo } from "../../shared/types";
import { useAutoResize } from "../shared/useAutoResize";

export function App(): JSX.Element {
  useAutoResize();
  const [pinned, setPinned] = useState<boolean>(true);
  const [sessionOnly, setSessionOnly] = useState<boolean>(false);
  const [collapseInactive, setCollapseInactive] = useState<boolean>(false);
  const [showActivityTimestamps, setShowActivityTimestamps] = useState<boolean>(true);
  const [spotifySupported, setSpotifySupported] = useState<boolean>(false);
  const [spotifyShare, setSpotifyShare] = useState<boolean>(false);

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

  const auth = useBackendAuth();
  const repos = useTrackedRepos();
  const [githubAppRefreshKey, setGithubAppRefreshKey] = useState(0);
  const [githubAppWatch, setGithubAppWatch] = useState(false);
  const githubApp = useGithubAppStatus(auth.signedIn, githubAppRefreshKey, githubAppWatch);
  const selected = useSelection();
  const [busy, setBusy] = useState<null | "add" | "repoAccess">(null);
  const [addError, setAddError] = useState<string | null>(null);

  const onSpotifyShareChange = (v: boolean): void => {
    setSpotifyShare(v);
    void window.chatheads.spotifyShare.setEnabled(v);
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

  useEffect(() => {
    if (!auth.signedIn || githubApp?.connected) setGithubAppWatch(false);
  }, [auth.signedIn, githubApp?.connected]);

  useEffect(() => {
    if (!githubAppWatch) return;
    const timer = setTimeout(() => setGithubAppWatch(false), 121_000);
    return () => clearTimeout(timer);
  }, [githubAppWatch]);

  if (!auth.signedIn) {
    return (
      <Shell>
        <SignedOutPrompt />
        <Divider />
        <PinRow
          pinned={pinned}
          onChange={(v) => {
            setPinned(v);
            void window.chatheads.rail.setPinned(v);
          }}
        />
        <SessionOnlyRow enabled={sessionOnly} disabled={pinned} onChange={onSessionOnlyChange} />
        <CollapseInactiveRow enabled={collapseInactive} onChange={onCollapseInactiveChange} />
        <ShowActivityTimestampsRow
          shown={showActivityTimestamps}
          onChange={onShowActivityTimestampsChange}
        />
        {spotifySupported ? (
          <SpotifyShareRow enabled={spotifyShare} onChange={onSpotifyShareChange} />
        ) : null}
        <Divider />
        <Footer />
      </Shell>
    );
  }

  async function onAdd(): Promise<void> {
    if (busy) return;
    setBusy("add");
    setAddError(null);
    try {
      await window.chatheads.backend.addLocalRepo();
    } catch (err) {
      setAddError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onConnectRepoAccess(): Promise<void> {
    if (busy) return;
    setBusy("repoAccess");
    setAddError(null);
    try {
      await window.chatheads.backend.connectGithubApp();
      setGithubAppWatch(true);
    } catch (err) {
      setAddError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const needsRepoAccess = githubApp?.configured && !githubApp.connected;

  return (
    <Shell>
      <Header />
      <Divider />
      {needsRepoAccess ? (
        <RepoAccessPrompt
          busy={busy === "repoAccess"}
          watching={githubAppWatch}
          onConnect={onConnectRepoAccess}
          onRefresh={() => setGithubAppRefreshKey((value) => value + 1)}
        />
      ) : null}
      <Body
        repos={repos}
        selected={selected}
        onRemove={(repoId) => void window.chatheads.backend.removeLocalRepo(repoId)}
      />
      {addError ? <ErrorNote message={addError} /> : null}
      <AddButton
        busy={busy === "add" || busy === "repoAccess"}
        watchingRepoAccess={githubAppWatch}
        needsRepoAccess={needsRepoAccess === true}
        onClick={needsRepoAccess ? onConnectRepoAccess : onAdd}
      />
      <Divider />
      <PinRow
        pinned={pinned}
        onChange={(v) => {
          setPinned(v);
          void window.chatheads.rail.setPinned(v);
        }}
      />
      <SessionOnlyRow enabled={sessionOnly} disabled={pinned} onChange={onSessionOnlyChange} />
      <CollapseInactiveRow enabled={collapseInactive} onChange={onCollapseInactiveChange} />
      <ShowActivityTimestampsRow
        shown={showActivityTimestamps}
        onChange={onShowActivityTimestampsChange}
      />
      {spotifySupported ? (
        <SpotifyShareRow enabled={spotifyShare} onChange={onSpotifyShareChange} />
      ) : null}
      <Divider />
      <Footer />
    </Shell>
  );
}

// ---------- Layout shell ----------

function Shell({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="box-border p-4 flex flex-col gap-3">{children}</div>;
}

function Divider(): JSX.Element {
  return <div className="h-px bg-divider" />;
}

function Header(): JSX.Element {
  return <div className="px-1 py-0.5 text-xs uppercase tracking-wide text-fg/55">Your repos</div>;
}

// ---------- Body ----------

function Body({
  repos,
  selected,
  onRemove,
}: {
  repos: TrackedRepo[];
  selected: Set<number>;
  onRemove: (repoId: number) => void;
}): JSX.Element {
  if (repos.length === 0) {
    return (
      <div className="px-1.5 py-1 text-sm text-fg/55">
        No repos added yet. Click &ldquo;Add local repo&rdquo; below.
      </div>
    );
  }
  // Stable alpha order — repos don't reorder when selection flips.
  const sorted = [...repos].sort((a, b) => a.fullName.localeCompare(b.fullName));
  return (
    <div className="flex flex-col gap-0.5 max-h-[320px] overflow-y-auto">
      {sorted.map((r) => (
        <RepoRow
          key={r.repoId}
          repo={r}
          checked={selected.has(r.repoId)}
          onRemove={() => onRemove(r.repoId)}
        />
      ))}
    </div>
  );
}

function RepoRow({
  repo,
  checked,
  onRemove,
}: {
  repo: TrackedRepo;
  checked: boolean;
  onRemove: () => void;
}): JSX.Element {
  return (
    <div
      className="
        group w-full flex items-center gap-2 px-1.5 py-1 rounded-md
        hover:bg-surface-alt
      "
    >
      <button
        type="button"
        onClick={() => window.chatheads.trackedRepos.toggle(repo.repoId)}
        className="
          flex-1 min-w-0 flex items-center gap-2
          bg-transparent border-none text-fg cursor-pointer [font:inherit]
          text-left
        "
      >
        <Checkbox checked={checked} />
        <span className="flex-1 min-w-0 flex flex-col">
          <span className="truncate text-base leading-tight">{repo.fullName}</span>
          <span className="truncate text-xs text-fg/45 leading-tight">{repo.localPath}</span>
        </span>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        title="Remove repo"
        aria-label={`Remove ${repo.fullName}`}
        className="
          w-5 h-5 flex items-center justify-center rounded
          bg-transparent border-none text-fg/40 cursor-pointer [font:inherit]
          opacity-0 group-hover:opacity-100
          hover:bg-surface-alt-hover hover:text-fg
        "
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path
            d="M2 2 L8 8 M8 2 L2 8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}

function Checkbox({ checked }: { checked: boolean }): JSX.Element {
  return (
    <span
      className={`
        w-[14px] h-[14px] rounded-[3px] inline-flex items-center justify-center flex-shrink-0
        ${checked ? "bg-fg text-bg" : "bg-transparent border border-fg/40"}
      `}
    >
      {checked ? (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path
            d="M1.5 5 L4 7.5 L8.5 2.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </span>
  );
}

function AddButton({
  busy,
  watchingRepoAccess,
  needsRepoAccess,
  onClick,
}: {
  busy: boolean;
  watchingRepoAccess: boolean;
  needsRepoAccess: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || watchingRepoAccess}
      className="
        w-full px-2.5 py-1.5 rounded-md
        bg-surface-alt border-none text-fg cursor-pointer [font:inherit]
        text-base
        hover:bg-surface-alt-hover
        disabled:opacity-[0.5] disabled:cursor-default
      "
    >
      {needsRepoAccess
        ? busy
          ? "Opening GitHub..."
          : watchingRepoAccess
            ? "Waiting for GitHub..."
            : "Connect repo access"
        : busy
          ? "Choosing folder..."
          : "+ Add local repo"}
    </button>
  );
}

function RepoAccessPrompt({
  busy,
  watching,
  onConnect,
  onRefresh,
}: {
  busy: boolean;
  watching: boolean;
  onConnect: () => void;
  onRefresh: () => void;
}): JSX.Element {
  return (
    <div
      className="
        px-2.5 py-2 rounded-md border border-fg/10
        bg-surface-alt text-sm text-fg
      "
    >
      <div className="font-medium mb-0.5">Finish GitHub setup</div>
      <div className="text-fg/65 leading-snug">
        Connect repo access once, then choose your local repo folder.
      </div>
      <div className="flex gap-1.5 mt-2">
        <button
          type="button"
          onClick={onConnect}
          disabled={busy}
          className="
            px-2 py-1 rounded bg-surface-alt-hover border-none
            text-fg cursor-pointer [font:inherit]
            disabled:opacity-50 disabled:cursor-wait
          "
        >
          {busy ? "Opening..." : watching ? "Open again" : "Open GitHub"}
        </button>
        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          className="
            px-2 py-1 rounded bg-transparent border border-fg/10
            text-fg/70 cursor-pointer [font:inherit] hover:text-fg
            disabled:opacity-50 disabled:cursor-wait
          "
        >
          Refresh
        </button>
      </div>
      {watching ? <div className="text-fg/55 mt-2">Waiting for GitHub approval...</div> : null}
    </div>
  );
}

function ErrorNote({ message }: { message: string }): JSX.Element {
  const isGithubApp = message.includes("Slashtalk GitHub App");
  if (isGithubApp) {
    return (
      <div
        className="
          px-2.5 py-2 rounded-md border border-fg/10
          bg-surface-alt text-sm text-fg
        "
      >
        <div className="font-medium mb-0.5">Private repo access needed</div>
        <div className="text-fg/65">{message}</div>
      </div>
    );
  }

  return <div className="px-1.5 py-1 text-sm text-danger">{message}</div>;
}

// ---------- Pin toggle ----------

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
      <span className="flex-1 text-base">Keep rail on top</span>
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
      title={disabled ? "Turn off \u201cKeep rail on top\u201d to use this mode" : undefined}
      className={`
        w-full flex items-center gap-2 px-1.5 py-1 rounded-md
        bg-transparent border-none text-fg [font:inherit]
        text-left
        ${disabled ? "opacity-40 cursor-default" : "cursor-pointer hover:bg-surface-alt"}
      `}
    >
      <Checkbox checked={enabled} />
      <span className="flex-1 text-base">Show rail only during active sessions</span>
    </button>
  );
}

// ---------- Footer / signed-out CTA ----------

function SignedOutPrompt(): JSX.Element {
  return (
    <div className="flex flex-col gap-3 px-1 py-1">
      <div className="text-base text-fg">Sign in to add your repos.</div>
      <FooterButton onClick={() => window.chatheads.backend.signIn()}>
        Sign in with GitHub
      </FooterButton>
    </div>
  );
}

function Footer(): JSX.Element {
  return (
    <div className="flex gap-2">
      <FooterButton onClick={() => window.chatheads.openMain()}>Settings</FooterButton>
      <FooterButton onClick={() => window.chatheads.quit()}>Quit</FooterButton>
    </div>
  );
}

function FooterButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="
        flex-1 px-2.5 py-1.5 rounded-md
        bg-surface-alt border-none text-fg cursor-pointer [font:inherit]
        hover:bg-surface-alt-hover
        disabled:opacity-[0.35] disabled:cursor-default
      "
    >
      {children}
    </button>
  );
}

// ---------- Hooks ----------

function useBackendAuth(): BackendAuthState {
  const [state, setState] = useState<BackendAuthState>({ signedIn: false });
  useEffect(() => {
    void window.chatheads.backend.getAuthState().then(setState);
    return window.chatheads.backend.onAuthState(setState);
  }, []);
  return state;
}

function useTrackedRepos(): TrackedRepo[] {
  const [repos, setRepos] = useState<TrackedRepo[]>([]);
  useEffect(() => {
    void window.chatheads.backend.listTrackedRepos().then(setRepos);
    return window.chatheads.backend.onTrackedReposChange(setRepos);
  }, []);
  return repos;
}

function useGithubAppStatus(
  signedIn: boolean,
  refreshKey: number,
  watching: boolean,
): GithubAppStatus | null {
  const [status, setStatus] = useState<GithubAppStatus | null>(null);
  useEffect(() => {
    let alive = true;
    if (!signedIn) {
      setStatus(null);
      return () => {
        alive = false;
      };
    }
    void window.chatheads.backend
      .getGithubAppStatus()
      .then((next) => {
        if (alive) setStatus(next);
      })
      .catch(() => {
        if (alive) setStatus(null);
      });
    return () => {
      alive = false;
    };
  }, [signedIn, refreshKey]);

  useEffect(() => {
    if (!signedIn || !watching) return;

    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const poll = async (): Promise<void> => {
      attempts += 1;
      try {
        const next = await window.chatheads.backend.getGithubAppStatus();
        if (!alive) return;
        setStatus(next);
        if (next.connected) return;
      } catch {
        if (!alive) return;
      }

      if (attempts < 60) timer = setTimeout(() => void poll(), 2_000);
    };

    timer = setTimeout(() => void poll(), 1_000);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [signedIn, watching]);
  return status;
}

function useSelection(): Set<number> {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  useEffect(() => {
    void window.chatheads.trackedRepos.selection().then((list) => {
      setSelected(new Set(list));
    });
    return window.chatheads.trackedRepos.onSelectionChange((list) => setSelected(new Set(list)));
  }, []);
  return selected;
}
