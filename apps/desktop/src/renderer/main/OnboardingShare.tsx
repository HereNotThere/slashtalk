import { useState } from "react";
import { CheckIcon, CopyIcon, SlashtalkLogo } from "../shared/icons";
import { StepLabel } from "./StepLabel";

const SHARE_URL = "https://slashtalk.com";

export function OnboardingShare({ onDone }: { onDone: () => void }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  const copy = async (): Promise<void> => {
    setCopyError(false);
    try {
      await window.chatheads.copyText(SHARE_URL);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError(true);
    }
  };

  return (
    <div className="min-h-[calc(100vh-48px)] flex flex-col items-center justify-center gap-10 px-6 text-center">
      <SlashtalkLogo size={48} />
      <div className="flex flex-col items-center gap-5 max-w-md">
        <StepLabel current={2} total={2} />
        <h1 className="m-0 text-[36px] font-semibold leading-[1.05] tracking-tight text-fg">
          Bring your <span className="font-serif font-normal text-muted italic">team</span>.
        </h1>
        <p className="m-0 text-md text-muted leading-relaxed">
          Slashtalk only lights up when your teammates are on it too. Share the link so the people
          you work with can see what you&rsquo;re building — and you can see them.
        </p>
      </div>

      <div className="flex flex-col items-stretch gap-4 w-full max-w-[360px]">
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-full bg-surface-alt border border-border">
          <span className="flex-1 truncate text-base font-mono text-fg text-left">{SHARE_URL}</span>
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={copied ? "Copied" : "Copy link"}
            className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium cursor-pointer border-none transition-colors ${
              copied ? "bg-primary-soft text-primary" : "bg-fg text-bg hover:opacity-90"
            }`}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>

        <button
          type="button"
          onClick={onDone}
          className="w-full inline-flex items-center justify-center rounded-full bg-fg px-7 py-3 text-base font-medium text-bg transition-opacity hover:opacity-90 cursor-pointer"
        >
          Done
        </button>

        {copyError ? (
          <div className="text-sm text-danger leading-snug text-center">
            Couldn&rsquo;t copy — select the link and copy manually.
          </div>
        ) : null}
      </div>
    </div>
  );
}
