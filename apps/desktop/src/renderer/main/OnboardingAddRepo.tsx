import { useState } from "react";
import { SlashtalkLogo } from "../shared/icons";
import { StepLabel } from "./StepLabel";

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
    <div className="min-h-[calc(100vh-48px)] flex flex-col items-center justify-center gap-10 px-6 text-center">
      <SlashtalkLogo size={48} />
      <div className="flex flex-col items-center gap-5 max-w-md">
        <StepLabel current={1} total={2} />
        <h1 className="m-0 text-[36px] font-semibold leading-[1.05] tracking-tight text-fg">
          Pick a <span className="font-serif font-normal text-muted italic">local</span> repo.
        </h1>
        <p className="m-0 text-md text-muted leading-relaxed">
          Choose a folder that&rsquo;s a git clone of a repo you share with your team. Slashtalk
          uses it to show what teammates working in the same repo are up to right now.
        </p>
      </div>

      <div className="flex flex-col items-center gap-4 w-full max-w-[320px]">
        <button
          type="button"
          onClick={addRepo}
          disabled={busy}
          className="w-full inline-flex items-center justify-center rounded-full bg-fg px-7 py-3 text-base font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {busy ? "Opening folder picker…" : "Choose a folder"}
        </button>
        <button
          type="button"
          onClick={onSkip}
          disabled={busy}
          className="text-sm text-subtle hover:text-fg cursor-pointer bg-transparent border-none [font:inherit] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Skip for now
        </button>
      </div>

      {error ? <div className="text-sm text-danger leading-snug">{error}</div> : null}
    </div>
  );
}
