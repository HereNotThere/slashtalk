import { useCallback, useEffect, useState } from "react";
import type { BackendAuthState, GithubAppStatus, TrackedRepo } from "../../shared/types";

type Status = { kind: "ok" | "err"; text: string } | null;
type Busy = null | "signIn" | "repoAccess" | "add" | "globalSignOut";

const PRIMARY_GRADIENT = "var(--gradient-primary)";

export function SlashtalkSection(): JSX.Element {
  const [auth, setAuth] = useState<BackendAuthState>({ signedIn: false });
  const [tracked, setTracked] = useState<TrackedRepo[]>([]);
  const [githubApp, setGithubApp] = useState<GithubAppStatus | null>(null);
  const [repoAccessWatch, setRepoAccessWatch] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [status, setStatus] = useState<Status>(null);

  useEffect(() => {
    void window.chatheads.backend.getAuthState().then(setAuth);
    return window.chatheads.backend.onAuthState(setAuth);
  }, []);

  useEffect(() => {
    void window.chatheads.backend.listTrackedRepos().then(setTracked);
    return window.chatheads.backend.onTrackedReposChange(setTracked);
  }, []);

  const refreshGithubApp = useCallback(async (): Promise<GithubAppStatus | null> => {
    if (!auth.signedIn) {
      setGithubApp(null);
      return null;
    }
    try {
      const next = await window.chatheads.backend.getGithubAppStatus();
      setGithubApp(next);
      return next;
    } catch {
      setGithubApp(null);
      return null;
    }
  }, [auth.signedIn]);

  useEffect(() => {
    void refreshGithubApp();
  }, [refreshGithubApp]);

  useEffect(() => {
    if (!repoAccessWatch || !auth.signedIn) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const poll = async (): Promise<void> => {
      attempts += 1;
      const next = await refreshGithubApp();
      if (cancelled) return;

      if (next?.connected) {
        setRepoAccessWatch(false);
        setStatus({
          kind: "ok",
          text: "Repo access connected. You can add your local repo now.",
        });
        return;
      }

      if (attempts < 60) {
        timer = setTimeout(() => void poll(), 2_000);
        return;
      }

      setRepoAccessWatch(false);
      setStatus({
        kind: "ok",
        text: "Still waiting for GitHub approval. Finish it in your browser, then use Refresh if needed.",
      });
    };

    timer = setTimeout(() => void poll(), 1_000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [auth.signedIn, refreshGithubApp, repoAccessWatch]);

  const withBusy = async (
    kind: Exclude<Busy, null | "globalSignOut">,
    fn: () => Promise<Status>,
  ): Promise<void> => {
    setBusy(kind);
    setStatus(null);
    try {
      setStatus(await fn());
    } catch (err) {
      setStatus({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const signIn = (): Promise<void> =>
    withBusy("signIn", async () => {
      await window.chatheads.backend.signIn();
      return null;
    });

  const connectRepoAccess = (): Promise<void> =>
    withBusy("repoAccess", async () => {
      await window.chatheads.backend.connectGithubApp();
      setRepoAccessWatch(true);
      return {
        kind: "ok",
        text: "Waiting for GitHub approval...",
      };
    });

  const refreshRepoAccess = (): Promise<void> =>
    withBusy("repoAccess", async () => {
      const next = await refreshGithubApp();
      if (next?.connected) {
        setRepoAccessWatch(false);
        return {
          kind: "ok",
          text: "Repo access connected. You can add your local repo now.",
        };
      }
      return {
        kind: "ok",
        text: "Still waiting for GitHub approval.",
      };
    });

  const signOut = async (): Promise<void> => {
    setStatus(null);
    await window.chatheads.backend.signOut();
  };

  const signOutEverywhere = async (): Promise<void> => {
    if (
      !window.confirm(
        "Sign out everywhere? This revokes all Slashtalk device keys and MCP OAuth sessions.",
      )
    ) {
      return;
    }

    setBusy("globalSignOut");
    setStatus(null);
    try {
      await window.chatheads.backend.signOutEverywhere();
    } catch (err) {
      setStatus({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const addRepo = (): Promise<void> =>
    withBusy("add", async () => {
      const repo = await window.chatheads.backend.addLocalRepo();
      return repo ? { kind: "ok", text: `Added ${repo.fullName}` } : null;
    });

  const removeRepo = async (repoId: number): Promise<void> => {
    setStatus(null);
    try {
      await window.chatheads.backend.removeLocalRepo(repoId);
    } catch (err) {
      setStatus({ kind: "err", text: (err as Error).message });
    }
  };

  return (
    <section className="bg-card rounded-2xl p-4">
      {auth.signedIn ? (
        <div className="flex items-center justify-between mb-3">
          <span className="text-[13px] font-medium">@{auth.user.githubLogin}</span>
          <div className="flex items-center gap-2">
            <LinkButton onClick={signOut}>Sign out</LinkButton>
            <LinkButton onClick={signOutEverywhere} disabled={busy === "globalSignOut"} danger>
              {busy === "globalSignOut" ? "Signing out..." : "Sign out everywhere"}
            </LinkButton>
          </div>
        </div>
      ) : null}

      {!auth.signedIn ? (
        <button
          onClick={signIn}
          disabled={busy === "signIn"}
          style={{ background: PRIMARY_GRADIENT }}
          className="
            w-full border-0 text-white font-medium
            rounded-xl px-4 py-2.5 text-[13px] cursor-pointer
            shadow-[0_1px_0_rgba(255,255,255,0.2)_inset,0_1px_2px_rgba(0,0,0,0.1)]
            hover:brightness-105 active:brightness-95
            disabled:opacity-60 disabled:cursor-wait
            transition-[filter]
          "
        >
          {busy === "signIn" ? "Waiting for browser…" : "→  Sign in to Slashtalk"}
        </button>
      ) : (
        <SignedInBody
          tracked={tracked}
          githubApp={githubApp}
          adding={busy === "add"}
          connectingRepoAccess={busy === "repoAccess"}
          watchingRepoAccess={repoAccessWatch}
          onConnectRepoAccess={connectRepoAccess}
          onRefreshRepoAccess={refreshRepoAccess}
          onAdd={addRepo}
          onRemove={removeRepo}
        />
      )}

      {status && (
        <div
          className={`text-[12px] mt-3 leading-snug ${
            status.kind === "ok" ? "text-success" : "text-danger"
          }`}
        >
          {status.text}
        </div>
      )}
    </section>
  );
}

function SignedInBody({
  tracked,
  githubApp,
  adding,
  connectingRepoAccess,
  watchingRepoAccess,
  onConnectRepoAccess,
  onRefreshRepoAccess,
  onAdd,
  onRemove,
}: {
  tracked: TrackedRepo[];
  githubApp: GithubAppStatus | null;
  adding: boolean;
  connectingRepoAccess: boolean;
  watchingRepoAccess: boolean;
  onConnectRepoAccess: () => void;
  onRefreshRepoAccess: () => void;
  onAdd: () => void;
  onRemove: (repoId: number) => void;
}): JSX.Element {
  const needsRepoAccess = githubApp?.configured && !githubApp.connected;
  return (
    <>
      {needsRepoAccess ? (
        <RepoAccessPanel
          busy={connectingRepoAccess}
          watching={watchingRepoAccess}
          onConnect={onConnectRepoAccess}
          onRefresh={onRefreshRepoAccess}
        />
      ) : (
        <RepoAccessConnected connected={githubApp?.connected === true} />
      )}

      <button
        onClick={needsRepoAccess ? onConnectRepoAccess : onAdd}
        disabled={adding || connectingRepoAccess || watchingRepoAccess}
        className="
          self-start bg-button border border-border text-fg
          rounded-lg px-3.5 py-2 text-[13px] font-medium cursor-pointer
          hover:bg-button-hover disabled:opacity-60 disabled:cursor-wait
        "
      >
        {needsRepoAccess
          ? connectingRepoAccess || watchingRepoAccess
            ? "Waiting for GitHub..."
            : "Connect repo access"
          : adding
            ? "Adding..."
            : "+ Add local repo"}
      </button>

      {tracked.length === 0 ? (
        <div className="text-[12px] text-subtle mt-3 leading-snug">
          {needsRepoAccess
            ? "Connect repo access once, then pick a folder that's a clone of one of your GitHub repos."
            : 'No local repos tracked yet. Click "Add local repo" and pick a folder that\'s a clone of one of your GitHub repos.'}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 mt-3">
          {tracked.map((t) => (
            <div
              key={t.repoId}
              className="flex items-center gap-2.5 px-3 py-2 bg-surface rounded-lg"
            >
              <span className="text-[13px] font-medium">{t.fullName}</span>
              <span className="text-[12px] text-subtle truncate">{t.localPath}</span>
              <button
                onClick={() => onRemove(t.repoId)}
                className="ml-auto bg-transparent border-none text-subtle cursor-pointer hover:text-fg"
                title="Remove"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function RepoAccessPanel({
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
    <div className="bg-surface border border-border rounded-xl p-3 mb-3">
      <div className="flex items-start gap-2.5">
        <StepBadge value="2" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">Connect repo access</div>
          <div className="text-[12px] text-subtle leading-snug mt-0.5">
            Approve the Slashtalk GitHub App once so private repos can be verified without granting
            broad OAuth repo access.
          </div>
          <div className="flex items-center gap-2 mt-2">
            <InlineButton onClick={onConnect} disabled={busy}>
              {busy ? "Opening..." : watching ? "Open again" : "Open GitHub"}
            </InlineButton>
            <InlineButton onClick={onRefresh} disabled={busy} secondary>
              Refresh
            </InlineButton>
          </div>
          {watching ? (
            <div className="text-[11px] text-subtle mt-2">Waiting for GitHub approval...</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function RepoAccessConnected({ connected }: { connected: boolean }): JSX.Element {
  if (!connected) return <StepBadgeRow value="2" label="Repo access" state="Optional" />;
  return <StepBadgeRow value="2" label="Repo access" state="Connected" success />;
}

function StepBadgeRow({
  value,
  label,
  state,
  success = false,
}: {
  value: string;
  label: string;
  state: string;
  success?: boolean;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 mb-3 text-[12px] text-subtle">
      <StepBadge value={value} success={success} />
      <span>{label}</span>
      <span className={success ? "text-success" : undefined}>{state}</span>
    </div>
  );
}

function StepBadge({ value, success = false }: { value: string; success?: boolean }): JSX.Element {
  return (
    <span
      className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-semibold shrink-0 ${
        success ? "bg-success/15 text-success" : "bg-surface text-subtle"
      }`}
    >
      {success ? "✓" : value}
    </span>
  );
}

function InlineButton({
  children,
  onClick,
  disabled,
  secondary = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  secondary?: boolean;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`border border-border rounded-lg px-2.5 py-1.5 text-[12px] cursor-pointer disabled:opacity-60 disabled:cursor-wait ${
        secondary
          ? "bg-transparent text-subtle hover:text-fg"
          : "bg-button text-fg hover:bg-button-hover"
      }`}
    >
      {children}
    </button>
  );
}

function LinkButton({
  onClick,
  children,
  disabled = false,
  danger = false,
}: {
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`bg-transparent border-none text-[12px] px-1 py-0.5 cursor-pointer disabled:opacity-60 disabled:cursor-wait ${
        danger ? "text-danger hover:text-danger" : "text-link hover:text-link-hover"
      }`}
    >
      {children}
    </button>
  );
}
