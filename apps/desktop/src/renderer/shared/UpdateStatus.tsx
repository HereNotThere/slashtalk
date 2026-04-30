import { useEffect, useState } from "react";
import { ArrowDownTrayIcon, ArrowPathIcon } from "@heroicons/react/24/outline";
import type { UpdateState } from "../../shared/types";
import { Button } from "./Button";

interface UpdateStatusProps {
  compact?: boolean;
}

type Busy = null | "check" | "install";

export function UpdateStatus({ compact = false }: UpdateStatusProps): JSX.Element {
  const state = useUpdateState();
  const [busy, setBusy] = useState<Busy>(null);

  const check = async (): Promise<void> => {
    if (!state || state.kind === "disabled" || busy) return;
    setBusy("check");
    try {
      await window.chatheads.updates.check();
    } finally {
      setBusy(null);
    }
  };

  const install = async (): Promise<void> => {
    if (!state || state.kind !== "downloaded" || busy) return;
    setBusy("install");
    try {
      await window.chatheads.updates.install();
    } finally {
      setBusy(null);
    }
  };

  const status = state ? updateStatusText(state) : "Checking update status...";
  const disabled =
    !state ||
    state.kind === "disabled" ||
    state.kind === "checking" ||
    state.kind === "downloading" ||
    busy !== null;
  const body = (
    <>
      <div className="flex items-start justify-between gap-md">
        <div className="min-w-0">
          <div className="text-base font-medium">Updates</div>
          <div
            className={`text-sm leading-snug mt-xs ${
              state?.kind === "error" ? "text-danger" : "text-subtle"
            }`}
          >
            {status}
          </div>
        </div>
        {state?.kind === "downloaded" ? (
          <Button
            variant="primary"
            size="sm"
            icon={<ArrowDownTrayIcon className="w-4 h-4" />}
            onClick={install}
            disabled={busy !== null}
            className="shrink-0"
          >
            {busy === "install" ? "Restarting..." : "Restart"}
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            icon={<ArrowPathIcon className="w-4 h-4" />}
            onClick={check}
            disabled={disabled}
            className="shrink-0"
          >
            {state?.kind === "checking" || busy === "check" ? "Checking..." : "Check"}
          </Button>
        )}
      </div>
      {state?.kind === "downloading" ? <ProgressBar percent={state.percent} /> : null}
    </>
  );

  if (compact) {
    return <div className="px-xs flex flex-col gap-sm">{body}</div>;
  }

  return (
    <section className="bg-surface rounded-2xl p-lg mt-lg flex flex-col gap-md">{body}</section>
  );
}

function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    let alive = true;
    void window.chatheads.updates
      .getState()
      .then((next) => {
        if (alive) setState(next);
      })
      .catch(() => {
        if (alive) setState(null);
      });
    const unsubscribe = window.chatheads.updates.onState((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  return state;
}

function updateStatusText(state: UpdateState): string {
  switch (state.kind) {
    case "disabled":
      return state.reason;
    case "idle":
      return `Version ${state.currentVersion}`;
    case "checking":
      return "Checking for updates...";
    case "available":
      return `Version ${state.updateVersion} is available.`;
    case "downloading":
      return `Downloading version ${state.updateVersion} (${formatPercent(state.percent)}).`;
    case "downloaded":
      return `Version ${state.updateVersion} is ready to install.`;
    case "not-available":
      return `Version ${state.currentVersion} is current.`;
    case "error":
      return state.message;
  }
}

function ProgressBar({ percent }: { percent: number }): JSX.Element {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="h-1.5 rounded-full bg-surface-alt overflow-hidden" aria-hidden>
      <div
        className="h-full bg-primary transition-[width] duration-150"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

function formatPercent(percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  return `${Math.round(clamped)}%`;
}
