import { useEffect, useMemo, useRef, useState } from "react";
import type { OrgRepo, OrgSummary } from "@slashtalk/shared";
import type { BackendAuthState } from "../../shared/types";
import { useAutoResize } from "../shared/useAutoResize";

export function App(): JSX.Element {
  useAutoResize();

  const auth = useBackendAuth();
  const orgs = useOrgs();
  const activeOrgLogin = useActiveOrg();
  const repos = useOrgRepos();
  const selected = useRepoSelection();
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const activeOrg = useMemo(
    () => orgs.find((o) => o.login === activeOrgLogin) ?? null,
    [orgs, activeOrgLogin],
  );

  if (!auth.signedIn) {
    return (
      <Shell>
        <SignedOutPrompt />
        <Divider />
        <Footer />
      </Shell>
    );
  }

  return (
    <Shell>
      <OrgHeader
        orgs={orgs}
        active={activeOrg}
        open={dropdownOpen}
        onToggle={() => setDropdownOpen((v) => !v)}
        onPick={async (login) => {
          setDropdownOpen(false);
          await window.chatheads.orgs.setActive(login);
        }}
      />
      <Divider />
      <Body
        hasOrgs={orgs.length > 0}
        activeOrg={activeOrgLogin}
        repos={repos}
        selected={selected}
      />
      <Divider />
      <Footer />
    </Shell>
  );
}

// ---------- Layout shell ----------

function Shell({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="box-border p-lg flex flex-col gap-md">{children}</div>
  );
}

function Divider(): JSX.Element {
  return <div className="h-px bg-divider" />;
}

// ---------- Header + org switcher ----------

function OrgHeader({
  orgs,
  active,
  open,
  onToggle,
  onPick,
}: {
  orgs: OrgSummary[];
  active: OrgSummary | null;
  open: boolean;
  onToggle: () => void;
  onPick: (login: string) => void;
}): JSX.Element {
  const multi = orgs.length > 1;

  if (orgs.length === 0) {
    return (
      <div className="px-1 py-1 text-[12px] text-fg/60">
        No GitHub orgs found.
      </div>
    );
  }

  const label = active?.name ?? active?.login ?? "Pick an org";
  const avatar = active?.avatarUrl ?? "";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={multi ? onToggle : undefined}
        disabled={!multi}
        className={`
          w-full flex items-center gap-2 px-1.5 py-1 rounded-md
          bg-transparent border-none text-fg cursor-${multi ? "pointer" : "default"} [font:inherit]
          ${multi ? "hover:bg-surface-strong" : ""}
        `}
      >
        <OrgAvatar src={avatar} />
        <span className="flex-1 text-left text-[13px] truncate">{label}</span>
        {multi ? (
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            className={`text-fg/50 transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden
          >
            <path
              d="M2 4 L5 7 L8 4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </button>
      {open && multi ? (
        <OrgDropdown
          orgs={orgs}
          activeLogin={active?.login ?? null}
          onPick={onPick}
        />
      ) : null}
    </div>
  );
}

function OrgAvatar({ src }: { src: string }): JSX.Element {
  return (
    <span className="w-5 h-5 rounded-full overflow-hidden inline-flex items-center justify-center bg-surface-strong">
      {src ? <img src={src} alt="" className="w-full h-full object-cover" /> : null}
    </span>
  );
}

function OrgDropdown({
  orgs,
  activeLogin,
  onPick,
}: {
  orgs: OrgSummary[];
  activeLogin: string | null;
  onPick: (login: string) => void;
}): JSX.Element {
  return (
    <div
      className="
        absolute left-0 right-0 top-full mt-1 z-10
        rounded-md bg-surface-strong shadow-lg
        max-h-[240px] overflow-y-auto
        py-1
      "
    >
      {orgs.map((o) => (
        <button
          key={o.login}
          type="button"
          onClick={() => onPick(o.login)}
          className={`
            w-full flex items-center gap-2 px-1.5 py-1.5
            bg-transparent border-none text-fg cursor-pointer [font:inherit]
            text-left
            ${o.login === activeLogin ? "bg-surface-strong-hover" : "hover:bg-surface-strong-hover"}
          `}
        >
          <OrgAvatar src={o.avatarUrl} />
          <span className="flex-1 text-[13px] truncate">
            {o.name ?? o.login}
          </span>
        </button>
      ))}
    </div>
  );
}

// ---------- Body ----------

function Body({
  hasOrgs,
  activeOrg,
  repos,
  selected,
}: {
  hasOrgs: boolean;
  activeOrg: string | null;
  repos: OrgRepo[];
  selected: Set<string>;
}): JSX.Element {
  if (!hasOrgs) {
    return (
      <div className="px-1.5 py-1 text-[12px] text-fg/55">
        Install slashtalk on a GitHub org to get started.
      </div>
    );
  }
  if (!activeOrg) {
    return (
      <div className="px-1.5 py-1 text-[12px] text-fg/55">
        Pick an org above.
      </div>
    );
  }
  if (repos.length === 0) {
    return (
      <div className="px-1.5 py-1 text-[12px] text-fg/55">Loading repos…</div>
    );
  }
  return <RepoList repos={repos} selected={selected} />;
}

function RepoList({
  repos,
  selected,
}: {
  repos: OrgRepo[];
  selected: Set<string>;
}): JSX.Element {
  const sorted = useMemo(() => {
    const rank: Record<OrgRepo["permission"], number> = {
      admin: 0,
      maintain: 1,
      push: 2,
      triage: 3,
      pull: 4,
    };
    return [...repos].sort((a, b) => {
      const r = rank[a.permission] - rank[b.permission];
      if (r !== 0) return r;
      return a.name.localeCompare(b.name);
    });
  }, [repos]);

  return (
    <div className="flex flex-col gap-0.5 max-h-[320px] overflow-y-auto">
      {sorted.map((r) => (
        <RepoRow key={r.fullName} repo={r} checked={selected.has(r.fullName)} />
      ))}
    </div>
  );
}

function RepoRow({
  repo,
  checked,
}: {
  repo: OrgRepo;
  checked: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => window.chatheads.repos.toggle(repo.fullName)}
      className="
        w-full flex items-center gap-2 px-1.5 py-1 rounded-md
        bg-transparent border-none text-fg cursor-pointer [font:inherit]
        hover:bg-surface-strong
        text-left
      "
    >
      <Checkbox checked={checked} />
      <span className="flex-1 min-w-0 flex items-center gap-1 text-[13px]">
        <span className="truncate">{repo.name}</span>
        {repo.private ? <LockGlyph /> : null}
      </span>
    </button>
  );
}

function Checkbox({ checked }: { checked: boolean }): JSX.Element {
  return (
    <span
      className={`
        w-[14px] h-[14px] rounded-[3px] inline-flex items-center justify-center
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

function LockGlyph(): JSX.Element {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      className="text-fg/45 flex-shrink-0"
      aria-hidden
    >
      <rect x="2" y="5" width="6" height="4" rx="0.8" fill="currentColor" />
      <path
        d="M3.2 5 V3.6 A1.8 1.8 0 0 1 6.8 3.6 V5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  );
}

// ---------- Footer / signed-out CTA ----------

function SignedOutPrompt(): JSX.Element {
  return (
    <div className="flex flex-col gap-md px-1 py-1">
      <div className="text-[13px] text-fg">Sign in to pick repos.</div>
      <FooterButton onClick={() => window.chatheads.backend.signIn()}>
        Sign in with GitHub
      </FooterButton>
    </div>
  );
}

function Footer(): JSX.Element {
  return (
    <div className="flex gap-2">
      <FooterButton onClick={() => window.chatheads.openMain()}>
        Settings
      </FooterButton>
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
        bg-surface-strong border-none text-fg cursor-pointer [font:inherit]
        hover:bg-surface-strong-hover
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

function useOrgs(): OrgSummary[] {
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  useEffect(() => {
    void window.chatheads.orgs.list().then(setOrgs);
    return window.chatheads.orgs.onListChange(setOrgs);
  }, []);
  return orgs;
}

function useActiveOrg(): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    void window.chatheads.orgs.activeOrg().then(setActive);
    return window.chatheads.orgs.onActiveChange(setActive);
  }, []);
  return active;
}

function useOrgRepos(): OrgRepo[] {
  const [repos, setRepos] = useState<OrgRepo[]>([]);
  useEffect(() => {
    void window.chatheads.repos.listForActiveOrg().then(setRepos);
    return window.chatheads.repos.onUpdate(setRepos);
  }, []);
  return repos;
}

function useRepoSelection(): Set<string> {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Track current invocation to avoid clobbering fresh pushes with a stale
  // promise resolution.
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    void window.chatheads.repos.selection().then((list) => {
      if (seq.current === mine) setSelected(new Set(list));
    });
    return window.chatheads.repos.onSelectionChange((list) =>
      setSelected(new Set(list)),
    );
  }, []);
  return selected;
}
