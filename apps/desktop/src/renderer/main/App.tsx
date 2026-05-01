import { useEffect, useState } from "react";
import { SlashtalkLogo } from "../shared/icons";
import { OnboardingAddRepo } from "./OnboardingAddRepo";
import { OnboardingShare } from "./OnboardingShare";
import type { BackendAuthState, TrackedRepo } from "../../shared/types";

// The main window is now a single-purpose first-run flow: sign-in, then
// onboarding. Settings live exclusively in the menubar tray popup
// (apps/desktop/src/renderer/statusbar/App.tsx) so we don't ship two
// different settings UIs. Once onboarding completes, this window closes
// itself and the user reaches the same popup by clicking the tray icon.

const ONBOARDING_DONE_KEY = "slashtalk.onboardingComplete";

function readOnboardingDone(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDING_DONE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeOnboardingDone(): void {
  try {
    window.localStorage.setItem(ONBOARDING_DONE_KEY, "1");
  } catch {
    /* ignore — storage may be disabled */
  }
}

export function App(): JSX.Element | null {
  const [auth, setAuth] = useState<BackendAuthState>({ signedIn: false });
  const [signingIn, setSigningIn] = useState(false);
  // null = first IPC fetch hasn't resolved yet. Without this sentinel a
  // signed-in user with repos sees AddRepo flash because tracked starts at
  // [], and tapping "Skip for now" during the flash permanently marks
  // onboarding done before the Share step ever renders.
  const [tracked, setTracked] = useState<TrackedRepo[] | null>(null);
  const [onboardingDone, setOnboardingDone] = useState<boolean>(readOnboardingDone);

  useEffect(() => {
    void window.chatheads.backend.getAuthState().then(setAuth);
    return window.chatheads.backend.onAuthState(setAuth);
  }, []);

  useEffect(() => {
    void window.chatheads.backend
      .listTrackedRepos()
      .then(setTracked)
      .catch(() => setTracked([]));
    return window.chatheads.backend.onTrackedReposChange(setTracked);
  }, []);

  // Returning user (already onboarded, signing back in after a sign-out, or
  // app launch with persisted auth): don't make them re-walk onboarding.
  // Surface the tray popup so they have a visible UI, then close this
  // window. openSettings() *before* close() — closing first races the
  // ipcRenderer call against window teardown.
  const nothingToShow = auth.signedIn && onboardingDone;
  useEffect(() => {
    if (!nothingToShow) return;
    void window.chatheads.openSettings();
    window.close();
  }, [nothingToShow]);
  if (nothingToShow) return null;

  if (!auth.signedIn) {
    const signIn = async (): Promise<void> => {
      setSigningIn(true);
      try {
        await window.chatheads.backend.signIn();
      } finally {
        setSigningIn(false);
      }
    };
    const cancel = async (): Promise<void> => {
      // Aborts the in-flight OAuth round-trip in the main process so the
      // user can re-click "Sign in" without waiting for the original
      // browser tab to time out.
      try {
        await window.chatheads.backend.cancelSignIn();
      } finally {
        setSigningIn(false);
      }
    };
    return (
      <div className="min-h-[calc(100vh-48px)] flex flex-col items-center justify-center gap-10 px-6 text-center">
        <SlashtalkLogo size={56} />
        <div className="flex flex-col items-center gap-3">
          <h1 className="m-0 text-[36px] font-semibold leading-[1.05] tracking-tight text-fg">
            Slash<span className="font-serif font-normal italic">talk</span>
          </h1>
          <p className="m-0 text-md text-muted leading-relaxed">
            A dock for your team&rsquo;s work.
          </p>
        </div>
        {signingIn ? (
          // OAuth round-trip happens in a real browser tab. Without a
          // visible explanation here the desktop window just looks frozen
          // — users hunt for a popup or close the window in confusion.
          <div className="flex flex-col items-center gap-3 max-w-sm">
            <p className="m-0 text-base font-medium text-fg">Finish signing in in your browser</p>
            <p className="m-0 text-sm text-muted leading-relaxed">
              We opened a GitHub tab for you. Approve Slashtalk there, then come back to this
              window.
            </p>
            <button
              type="button"
              onClick={cancel}
              className="mt-2 text-sm text-muted hover:text-fg underline underline-offset-4 transition-colors cursor-pointer bg-transparent border-none [font:inherit]"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={signIn}
            className="inline-flex items-center justify-center rounded-full bg-fg px-7 py-3 text-base font-medium text-bg transition-opacity hover:opacity-90 cursor-pointer"
          >
            Sign in with GitHub
          </button>
        )}
      </div>
    );
  }

  // Wait for the first listTrackedRepos resolution before deciding which
  // step to show — otherwise an existing user with repos briefly sees
  // AddRepo (Step 1) while tracked is still its loading sentinel.
  if (tracked === null) return null;

  // Both Skip-from-AddRepo and Done-from-Share land here so the
  // tray-popup reveal happens consistently — the user always learns
  // where settings live as they exit onboarding.
  const finishOnboarding = (): void => {
    writeOnboardingDone();
    setOnboardingDone(true);
    void window.chatheads.openSettings();
    window.close();
  };

  if (tracked.length === 0) {
    return <OnboardingAddRepo onSkip={finishOnboarding} />;
  }
  return <OnboardingShare onDone={finishOnboarding} />;
}
