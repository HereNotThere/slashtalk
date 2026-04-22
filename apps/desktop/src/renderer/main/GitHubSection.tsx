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
      <div className="gh-header">
        <h2>GitHub</h2>
        <div className="right">
          {payload.state.kind === 'signedIn' && (
            <button className="link" onClick={signOut}>Sign out</button>
          )}
        </div>
      </div>

      {payload.state.kind === 'signedOut' && (
        <button className="primary" onClick={() => window.chatheads.github.startDeviceFlow()}>
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
          <div className="gh-row">
            <span className="label">Organization</span>
            {loadingOrgs ? (
              <span className="muted">loading…</span>
            ) : orgs.length === 0 ? (
              <span className="muted">No orgs found</span>
            ) : (
              <select
                value={selectedOrg ?? ''}
                onChange={(e) => {
                  const login = e.target.value || null;
                  setSelectedOrg(login);
                  if (login) localStorage.setItem(SELECTED_ORG_KEY, login);
                }}
              >
                <option value="">Select…</option>
                {orgs.map((org) => (
                  <option key={org.id} value={org.login}>{org.login}</option>
                ))}
              </select>
            )}
          </div>

          {loadError && <div className="error">{loadError}</div>}

          {loadingMembers ? (
            <div className="muted">Loading members…</div>
          ) : members.length > 0 ? (
            <div className="members">
              {members.map((member) => (
                <button
                  key={member.id}
                  className="member"
                  onClick={() =>
                    window.chatheads.spawn({
                      label: member.login,
                      tint: tintForUsername(member.login),
                      avatar: { type: 'remote', value: member.avatarURL },
                    })
                  }
                >
                  <img src={member.avatarURL} alt={member.login} />
                  <div className="login">{member.login}</div>
                </button>
              ))}
            </div>
          ) : selectedOrg ? (
            <div className="muted">
              No members visible (org may be private or you may lack read:org).
            </div>
          ) : null}
        </>
      )}

      {payload.errorMessage && <div className="error">{payload.errorMessage}</div>}
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
    <div className="device-flow">
      <div className="hint">Enter this code at {verificationURL}</div>
      <div className="actions">
        <div className="code-box">{userCode}</div>
        <button onClick={() => window.chatheads.copyText(userCode)}>Copy</button>
        <button onClick={() => window.chatheads.openExternal(verificationURL)}>Open browser</button>
        <button className="link" onClick={() => window.chatheads.github.cancelDeviceFlow()}>Cancel</button>
      </div>
    </div>
  );
}
