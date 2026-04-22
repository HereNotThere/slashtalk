import { useEffect, useState } from 'react';
import type { GitHubOrg, GitHubPayload, GitHubUser } from '../../shared/types';
import { tintForUsername } from '../shared/presets';

const SELECTED_ORG_KEY = 'chatheads.github.selectedOrg';

export function GitHubSection(): JSX.Element {
  const [payload, setPayload] = useState<GitHubPayload>({ state: { kind: 'signedOut' }, errorMessage: null });
  const [orgs, setOrgs] = useState<GitHubOrg[]>([]);
  const [members, setMembers] = useState<GitHubUser[]>([]);
  const [selectedOrg, setSelectedOrg] = useState<string | null>(
    () => localStorage.getItem(SELECTED_ORG_KEY),
  );
  const [loadingOrgs, setLoadingOrgs] = useState(false);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Subscribe to auth state
  useEffect(() => {
    void window.chatheads.github.getState().then(setPayload);
    return window.chatheads.github.onState(setPayload);
  }, []);

  // Load orgs when we become signed-in
  useEffect(() => {
    if (payload.state.kind !== 'signedIn') return;
    let cancelled = false;
    setLoadingOrgs(true);
    setLoadError(null);
    window.chatheads.github
      .listOrgs()
      .then((fetched) => {
        if (cancelled) return;
        setOrgs(fetched);
        const saved = localStorage.getItem(SELECTED_ORG_KEY);
        if (saved && fetched.some((o) => o.login === saved)) setSelectedOrg(saved);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(`Couldn't load orgs: ${err.message}`);
      })
      .finally(() => {
        if (!cancelled) setLoadingOrgs(false);
      });
    return () => {
      cancelled = true;
    };
  }, [payload.state.kind]);

  // Load members on org change
  useEffect(() => {
    if (!selectedOrg || payload.state.kind !== 'signedIn') {
      setMembers([]);
      return;
    }
    let cancelled = false;
    setLoadingMembers(true);
    setLoadError(null);
    window.chatheads.github
      .listMembers(selectedOrg)
      .then((fetched) => {
        if (!cancelled) setMembers(fetched);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(`Couldn't load members: ${err.message}`);
      })
      .finally(() => {
        if (!cancelled) setLoadingMembers(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedOrg, payload.state.kind]);

  const signOut = (): void => {
    setOrgs([]);
    setMembers([]);
    setSelectedOrg(null);
    localStorage.removeItem(SELECTED_ORG_KEY);
    void window.chatheads.github.signOut();
  };

  return (
    <>
      <div className="flex items-center gap-2 mt-5 mb-2">
        <h2 className="m-0 text-[14px] text-muted uppercase tracking-[0.5px]">GitHub</h2>
        <div className="ml-auto">
          {payload.state.kind === 'signedIn' && (
            <LinkButton onClick={signOut}>Sign out</LinkButton>
          )}
        </div>
      </div>

      {payload.state.kind === 'signedOut' && (
        <button
          onClick={() => window.chatheads.github.startDeviceFlow()}
          className="
            self-start bg-accent border border-accent text-accent-fg
            rounded-md px-3.5 py-2 text-[13px] cursor-pointer
            hover:bg-accent-hover
          "
        >
          →  Sign in with GitHub
        </button>
      )}

      {payload.state.kind === 'awaitingUserCode' && (
        <DeviceFlow
          userCode={payload.state.userCode}
          verificationURL={payload.state.verificationURL}
        />
      )}

      {payload.state.kind === 'signedIn' && (
        <>
          <div className="flex items-center gap-2.5">
            <span className="text-xs text-subtle">Organization</span>
            {loadingOrgs ? (
              <span className="text-xs text-subtle">loading…</span>
            ) : orgs.length === 0 ? (
              <span className="text-xs text-subtle">No orgs found</span>
            ) : (
              <select
                value={selectedOrg ?? ''}
                onChange={(e) => {
                  const login = e.target.value || null;
                  setSelectedOrg(login);
                  if (login) localStorage.setItem(SELECTED_ORG_KEY, login);
                }}
                className="
                  bg-button text-fg border border-border
                  rounded-md px-2 py-1 [font:inherit] max-w-[240px]
                "
              >
                <option value="">Select…</option>
                {orgs.map((org) => (
                  <option key={org.id} value={org.login}>{org.login}</option>
                ))}
              </select>
            )}
          </div>

          {loadError && <ErrorText>{loadError}</ErrorText>}

          {loadingMembers ? (
            <div className="text-xs text-subtle">Loading members…</div>
          ) : members.length > 0 ? (
            <div className="grid grid-cols-4 gap-2 max-h-[260px] overflow-y-auto p-0.5">
              {members.map((member) => (
                <button
                  key={member.id}
                  onClick={() =>
                    window.chatheads.spawn({
                      label: member.login,
                      tint: tintForUsername(member.login),
                      avatar: { type: 'remote', value: member.avatarURL },
                    })
                  }
                  className="
                    flex flex-col items-center gap-1 px-1 py-2 rounded-lg cursor-pointer
                    bg-tile border-none text-fg [font:inherit]
                    hover:bg-tile-hover
                  "
                >
                  <img src={member.avatarURL} alt={member.login} className="w-12 h-12 rounded-full object-cover" />
                  <div className="text-[11px] max-w-full overflow-hidden text-ellipsis whitespace-nowrap">
                    {member.login}
                  </div>
                </button>
              ))}
            </div>
          ) : selectedOrg ? (
            <div className="text-xs text-subtle">
              No members visible (org may be private or you may lack read:org).
            </div>
          ) : null}
        </>
      )}

      {payload.errorMessage && <ErrorText>{payload.errorMessage}</ErrorText>}
    </>
  );
}

function DeviceFlow({
  userCode,
  verificationURL,
}: {
  userCode: string;
  verificationURL: string;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11px] text-subtle">Enter this code at {verificationURL}</div>
      <div className="flex gap-2 items-center">
        <div className="inline-block font-mono text-xl font-bold px-3.5 py-2 bg-code rounded-lg select-text">
          {userCode}
        </div>
        <button
          onClick={() => window.chatheads.copyText(userCode)}
          className="bg-button border border-border text-fg rounded-md px-3.5 py-2 text-[13px] cursor-pointer hover:bg-button-hover"
        >
          Copy
        </button>
        <button
          onClick={() => window.chatheads.openExternal(verificationURL)}
          className="bg-button border border-border text-fg rounded-md px-3.5 py-2 text-[13px] cursor-pointer hover:bg-button-hover"
        >
          Open browser
        </button>
        <LinkButton onClick={() => window.chatheads.github.cancelDeviceFlow()}>Cancel</LinkButton>
      </div>
    </div>
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
      className="bg-transparent border-none text-link px-1.5 py-1 cursor-pointer hover:text-link-hover hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function ErrorText({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="text-danger text-xs">{children}</div>;
}
