import { useState } from "react";
import { Button } from "../shared/Button";
import { SlashtalkLogo } from "../shared/icons";

export function OnboardingAddRepo({ onSkip }: { onSkip: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addRepo = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      // The folder picker returns null if the user cancels — they stay on this
      // step. On success the tracked-repos subscription in App.tsx flips us
      // forward to the share step automatically.
      await window.chatheads.backend.addLocalRepo();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-48px)] flex flex-col items-center justify-center gap-8">
      <div className="flex flex-col items-center gap-4 text-center max-w-md">
        <SlashtalkLogo size={56} />
        <StepLabel current={1} total={2} />
        <h1 className="m-0 text-2xl font-bold leading-tight tracking-tight">Pick a local repo</h1>
        <p className="m-0 text-base text-muted leading-relaxed">
          Choose a folder that&rsquo;s a git clone of a repo you share with your team. Slashtalk
          uses it to show you what teammates working in the same repo are up to right now.
        </p>
      </div>

      <div className="flex flex-col items-center gap-3 w-full max-w-[320px]">
        <Button variant="primary" size="lg" fullWidth onClick={addRepo} disabled={busy}>
          {busy ? "Opening folder picker…" : "Choose a folder"}
        </Button>
        <button
          type="button"
          onClick={onSkip}
          className="text-sm text-subtle hover:text-fg cursor-pointer bg-transparent border-none [font:inherit]"
        >
          Skip for now
        </button>
      </div>

      {error ? <div className="text-sm text-danger leading-snug">{error}</div> : null}
    </div>
  );
}

function StepLabel({ current, total }: { current: number; total: number }): JSX.Element {
  return (
    <div className="text-xs uppercase tracking-wider text-subtle">
      Step {current} of {total}
    </div>
  );
}
