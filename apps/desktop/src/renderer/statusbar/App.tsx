import { useEffect, useState } from "react";
import type { BackendAuthState, TrackedRepo } from "../../shared/types";
import { useAutoResize } from "../shared/useAutoResize";
import { Checkbox } from "../shared/Checkbox";
import { RailPreferences } from "../shared/RailPreferences";
import { UpdateStatus } from "../shared/UpdateStatus";

export function App(): JSX.Element {
  useAutoResize();

  const auth = useBackendAuth();
  const repos = useTrackedRepos();
  const selected = useSelection();
  const [busy, setBusy] = useState<null | "add">(null);
  const [addError, setAddError] = useState<string | null>(null);

  if (!auth.signedIn) {
    // Settings are only meaningful once you're signed in — the dock,
    // teammate stack, MCP install, etc. all key off auth. Keep this popup
    // minimal so the only obvious action is to sign in.
    return (
      <Shell>
        <SignedOutPrompt />
        <Divider />
        <Footer signedIn={false} />
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

  return (
    <Shell>
      <Header />
      <Divider />
      <Body
        repos={repos}
        selected={selected}
        onRemove={(repoId) => void window.chatheads.backend.removeLocalRepo(repoId)}
      />
      {addError ? <ErrorNote message={addError} /> : null}
      <AddButton busy={busy === "add"} onClick={onAdd} />
      <Divider />
      <RailPreferences />
      <Divider />
      <UpdateStatus compact />
      <Divider />
      <Footer signedIn />
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

function AddButton({ busy, onClick }: { busy: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="
        w-full px-2.5 py-1.5 rounded-md
        bg-surface-alt border-none text-fg cursor-pointer [font:inherit]
        text-base
        hover:bg-surface-alt-hover
        disabled:opacity-[0.5] disabled:cursor-default
      "
    >
      {busy ? "Choosing folder..." : "+ Add local repo"}
    </button>
  );
}

function ErrorNote({ message }: { message: string }): JSX.Element {
  return <div className="px-1.5 py-1 text-sm text-danger">{message}</div>;
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

function Footer({ signedIn }: { signedIn: boolean }): JSX.Element {
  const [busy, setBusy] = useState<null | "signOut" | "signOutEverywhere">(null);
  // Inline confirm instead of window.confirm() — a native modal triggers
  // browser-window-blur on the tray popup, which auto-hides it (see
  // apps/desktop/src/main/windows/tray.ts blur listener). The user would
  // never see the dialog.
  const [confirmingEverywhere, setConfirmingEverywhere] = useState(false);

  const onSignOut = async (): Promise<void> => {
    if (busy) return;
    setBusy("signOut");
    try {
      await window.chatheads.backend.signOut();
    } finally {
      setBusy(null);
    }
  };

  const onSignOutEverywhere = async (): Promise<void> => {
    if (busy) return;
    setBusy("signOutEverywhere");
    setConfirmingEverywhere(false);
    try {
      await window.chatheads.backend.signOutEverywhere();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        {signedIn ? (
          <FooterButton onClick={() => void onSignOut()} disabled={busy !== null}>
            {busy === "signOut" ? "Signing out…" : "Sign out"}
          </FooterButton>
        ) : null}
        <FooterButton onClick={() => window.chatheads.quit()}>Quit</FooterButton>
      </div>
      {signedIn ? (
        confirmingEverywhere ? (
          <div className="flex flex-col gap-1.5 px-1.5 py-1.5 rounded-md bg-surface-alt">
            <div className="text-xs text-fg/70 leading-snug">
              Sign out on all devices? You&rsquo;ll need to sign in again everywhere. Use this if a
              device is lost or stolen.
            </div>
            <div className="flex gap-2">
              <FooterButton onClick={() => setConfirmingEverywhere(false)} disabled={busy !== null}>
                Cancel
              </FooterButton>
              <FooterButton onClick={() => void onSignOutEverywhere()} disabled={busy !== null}>
                {busy === "signOutEverywhere" ? "Signing out…" : "Sign out everywhere"}
              </FooterButton>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingEverywhere(true)}
            disabled={busy !== null}
            className="
              self-center px-1.5 py-0.5 text-xs text-subtle hover:text-danger
              bg-transparent border-none cursor-pointer [font:inherit]
              disabled:opacity-[0.35] disabled:cursor-default
            "
          >
            Sign out on all devices
          </button>
        )
      ) : null}
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
