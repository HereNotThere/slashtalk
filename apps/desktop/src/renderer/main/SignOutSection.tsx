import { useState } from "react";
import { Button } from "../shared/Button";

// Caller is responsible for only rendering this section when the user is
// signed in — see `main/App.tsx`. We deliberately don't subscribe to auth
// here so this component doesn't briefly render `null` on mount.
export function SignOutSection(): JSX.Element {
  const [busy, setBusy] = useState<null | "signOut" | "signOutEverywhere">(null);
  const [error, setError] = useState<string | null>(null);

  const signOut = async (): Promise<void> => {
    setBusy("signOut");
    setError(null);
    try {
      await window.chatheads.backend.signOut();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const signOutEverywhere = async (): Promise<void> => {
    const ok = window.confirm(
      "Sign out on all devices? You'll need to sign in again everywhere you use Slashtalk. " +
        "Use this if a device is lost or stolen.",
    );
    if (!ok) return;
    setBusy("signOutEverywhere");
    setError(null);
    try {
      await window.chatheads.backend.signOutEverywhere();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="bg-surface rounded-2xl p-4 mt-4 flex flex-col gap-4">
      <Row
        title="Sign out"
        description="Sign out on this Mac. Your other devices stay signed in."
        action={
          <Button variant="secondary" size="sm" onClick={signOut} disabled={busy !== null}>
            {busy === "signOut" ? "Signing out..." : "Sign out"}
          </Button>
        }
      />
      <Row
        title="Sign out on all devices"
        description="Revoke access on every device you've signed in to. Use this if a device is lost or stolen."
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={signOutEverywhere}
            disabled={busy !== null}
            className="text-danger hover:text-danger"
          >
            {busy === "signOutEverywhere" ? "Signing out..." : "Sign out everywhere"}
          </Button>
        }
      />
      {error ? <div className="text-sm text-danger leading-snug">{error}</div> : null}
    </section>
  );
}

function Row({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-base font-medium">{title}</div>
        <div className="text-sm text-subtle leading-snug mt-0.5">{description}</div>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}
