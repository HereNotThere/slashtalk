import { useEffect, useState } from "react";
import type { BackendAuthState, TrackedRepo } from "../../shared/types";

type Status = { kind: "ok" | "err"; text: string } | null;

const PRIMARY_GRADIENT = "var(--gradient-primary)";

export function SlashtalkSection(): JSX.Element {
  const [auth, setAuth] = useState<BackendAuthState>({ signedIn: false });
  const [tracked, setTracked] = useState<TrackedRepo[]>([]);
  const [busy, setBusy] = useState<null | "signIn" | "add">(null);
  const [status, setStatus] = useState<Status>(null);

  useEffect(() => {
    void window.chatheads.backend.getAuthState().then(setAuth);
    return window.chatheads.backend.onAuthState(setAuth);
  }, []);

  useEffect(() => {
    void window.chatheads.backend.listTrackedRepos().then(setTracked);
    return window.chatheads.backend.onTrackedReposChange(setTracked);
  }, []);

  const withBusy = async (
    kind: "signIn" | "add",
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

  const signOut = async (): Promise<void> => {
    setStatus(null);
    await window.chatheads.backend.signOut();
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
          <span className="text-[13px] font-medium">
            @{auth.user.githubLogin}
          </span>
          <LinkButton onClick={signOut}>Sign out</LinkButton>
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
          {busy === "signIn"
            ? "Waiting for browser…"
            : "→  Sign in to Slashtalk"}
        </button>
      ) : (
        <SignedInBody
          tracked={tracked}
          adding={busy === "add"}
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
  adding,
  onAdd,
  onRemove,
}: {
  tracked: TrackedRepo[];
  adding: boolean;
  onAdd: () => void;
  onRemove: (repoId: number) => void;
}): JSX.Element {
  return (
    <>
      <button
        onClick={onAdd}
        disabled={adding}
        className="
          self-start bg-button border border-border text-fg
          rounded-lg px-3.5 py-2 text-[13px] font-medium cursor-pointer
          hover:bg-button-hover disabled:opacity-60 disabled:cursor-wait
        "
      >
        {adding ? "Adding…" : "+ Add local repo"}
      </button>

      {tracked.length === 0 ? (
        <div className="text-[12px] text-subtle mt-3 leading-snug">
          No local repos tracked yet. Click &ldquo;Add local repo&rdquo; and
          pick a folder that&rsquo;s a clone of one of your GitHub repos.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 mt-3">
          {tracked.map((t) => (
            <div
              key={t.repoId}
              className="flex items-center gap-2.5 px-3 py-2 bg-surface rounded-lg"
            >
              <span className="text-[13px] font-medium">{t.fullName}</span>
              <span className="text-[12px] text-subtle truncate">
                {t.localPath}
              </span>
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

function LinkButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className="bg-transparent border-none text-link text-[12px] px-1 py-0.5 cursor-pointer hover:text-link-hover"
    >
      {children}
    </button>
  );
}
