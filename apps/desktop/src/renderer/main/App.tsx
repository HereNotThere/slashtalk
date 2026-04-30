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

  // If the window somehow ends up open while we have nothing to show
  // (signed in + onboarded), close it so the tray popup is the only
  // settings surface the user sees.
  const nothingToShow = auth.signedIn && onboardingDone;
  useEffect(() => {
    if (nothingToShow) window.close();
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
        <button
          type="button"
          onClick={signIn}
          disabled={signingIn}
          className="inline-flex items-center justify-center rounded-full bg-fg px-7 py-3 text-base font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {signingIn ? "Waiting for browser…" : "Sign in with GitHub"}
        </button>
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
