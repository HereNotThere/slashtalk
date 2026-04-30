import { useState } from "react";
import { Button } from "../shared/Button";
import { CheckIcon, CopyIcon, SlashtalkLogo } from "../shared/icons";

const SHARE_URL = "https://slashtalk.com";

export function OnboardingShare({ onDone }: { onDone: () => void }): JSX.Element {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    await window.chatheads.copyText(SHARE_URL);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-[calc(100vh-48px)] flex flex-col items-center justify-center gap-8">
      <div className="flex flex-col items-center gap-4 text-center max-w-md">
        <SlashtalkLogo size={56} />
        <StepLabel current={2} total={2} />
        <h1 className="m-0 text-2xl font-bold leading-tight tracking-tight">
          Bring your teammates
        </h1>
        <p className="m-0 text-base text-muted leading-relaxed">
          Slashtalk only lights up when your team is on it too. Share the link so the people you
          work with can see what you&rsquo;re building — and you can see them.
        </p>
      </div>

      <div className="flex flex-col items-stretch gap-3 w-full max-w-[360px]">
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-surface-alt border border-border">
          <span className="flex-1 truncate text-base font-mono text-fg">{SHARE_URL}</span>
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={copied ? "Copied" : "Copy link"}
            className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-sm font-medium cursor-pointer border-none transition-colors ${
              copied
                ? "bg-primary-soft text-primary"
                : "bg-surface text-fg hover:bg-surface-alt-hover"
            }`}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>

        <Button variant="primary" size="lg" fullWidth onClick={onDone}>
          Done
        </Button>
      </div>
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
