import { useEffect, useState } from "react";
import { FolderIcon, PlusIcon } from "@heroicons/react/24/outline";
import { XMarkIcon } from "@heroicons/react/20/solid";
import { Button } from "../shared/Button";
import type { BackendAuthState, TrackedRepo } from "../../shared/types";

type Status = { kind: "ok" | "err"; text: string } | null;
type Busy = null | "signIn" | "add" | "globalSignOut";

export function SlashtalkSection(): JSX.Element {
  const [auth, setAuth] = useState<BackendAuthState>({ signedIn: false });
  const [tracked, setTracked] = useState<TrackedRepo[]>([]);
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
    <section className="bg-surface rounded-2xl p-4">
      {auth.signedIn ? (
        <div className="flex items-center justify-between mb-3">
          <span className="text-base font-medium">@{auth.user.githubLogin}</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={signOut}>
              Sign out
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={signOutEverywhere}
              disabled={busy === "globalSignOut"}
              className="text-danger hover:text-danger"
            >
              {busy === "globalSignOut" ? "Signing out..." : "Sign out everywhere"}
            </Button>
          </div>
        </div>
      ) : null}

      {!auth.signedIn ? (
        <Button variant="primary" size="md" fullWidth onClick={signIn} disabled={busy === "signIn"}>
          {busy === "signIn" ? "Waiting for browser…" : "→  Sign in to Slashtalk"}
        </Button>
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
          className={`text-sm mt-3 leading-snug ${
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
      <Button
        variant="secondary"
        size="md"
        icon={<PlusIcon className="w-4 h-4" />}
        onClick={onAdd}
        disabled={adding}
      >
        {adding ? "Adding..." : "Add local repo"}
      </Button>

      {tracked.length === 0 ? (
        <div className="text-sm text-subtle mt-3 leading-snug">
          No local repos tracked yet. Click &ldquo;Add local repo&rdquo; and pick a folder
          that&rsquo;s a clone of one of your GitHub repos.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 mt-3">
          {tracked.map((t) => (
            <div
              key={t.repoId}
              className="flex items-center gap-2.5 px-3 py-2 bg-surface-alt rounded-lg"
            >
              <FolderIcon className="w-4 h-4 text-subtle shrink-0" aria-hidden />
              <span className="text-base font-medium">{t.fullName}</span>
              <span className="text-sm text-subtle truncate">{t.localPath}</span>
              <Button
                variant="ghost"
                size="sm"
                round
                onClick={() => onRemove(t.repoId)}
                aria-label="Remove"
                className="ml-auto"
                icon={<XMarkIcon className="w-4 h-4" />}
              />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
