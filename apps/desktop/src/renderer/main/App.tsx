import { useEffect, useState } from "react";
import { Button } from "../shared/Button";
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
  const [tracked, setTracked] = useState<TrackedRepo[]>([]);
  const [onboardingDone, setOnboardingDone] = useState<boolean>(readOnboardingDone);

  useEffect(() => {
    void window.chatheads.backend.getAuthState().then(setAuth);
    return window.chatheads.backend.onAuthState(setAuth);
  }, []);

  useEffect(() => {
    void window.chatheads.backend.listTrackedRepos().then(setTracked);
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
      <div className="min-h-[calc(100vh-48px)] flex flex-col items-center justify-center gap-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <SlashtalkLogo size={64} />
          <div>
            <h1 className="m-0 text-2xl font-bold leading-tight tracking-tight">Slashtalk</h1>
            <div className="text-subtle text-base mt-1.5">A dock for your team&rsquo;s work.</div>
          </div>
        </div>
        <Button
          variant="primary"
          size="lg"
          fullWidth
          onClick={signIn}
          disabled={signingIn}
          className="max-w-[320px]"
        >
          {signingIn ? "Waiting for browser…" : "→  Sign in to Slashtalk"}
        </Button>
      </div>
    );
  }

  if (tracked.length === 0) {
    return (
      <OnboardingAddRepo
        onSkip={() => {
          writeOnboardingDone();
          setOnboardingDone(true);
        }}
      />
    );
  }
  return (
    <OnboardingShare
      onDone={() => {
        writeOnboardingDone();
        setOnboardingDone(true);
        // Pop the tray popup as we exit onboarding so the user physically
        // sees the settings UI slide down from the menubar icon — telling
        // them where to find it later without a separate tooltip.
        void window.chatheads.openSettings();
        window.close();
      }}
    />
  );
}
