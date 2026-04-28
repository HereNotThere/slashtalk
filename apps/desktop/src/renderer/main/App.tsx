import { useEffect, useState } from "react";
import { Button } from "../shared/Button";
import { SlashtalkLogo } from "../shared/icons";
import { SlashtalkSection } from "./SlashtalkSection";
import { AgentsSection } from "./AgentsSection";
import type { BackendAuthState } from "../../shared/types";

export function App(): JSX.Element {
  const [auth, setAuth] = useState<BackendAuthState>({ signedIn: false });
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    void window.chatheads.backend.getAuthState().then(setAuth);
    return window.chatheads.backend.onAuthState(setAuth);
  }, []);

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
            <div className="text-subtle text-base mt-1.5">
              Floating bubbles that stay on top of everything.
            </div>
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

  return (
    <>
      <header className="mb-6">
        <h1 className="m-0 text-xl font-bold leading-tight tracking-tight">Settings</h1>
      </header>

      <SlashtalkSection />
      <AgentsSection />
    </>
  );
}
