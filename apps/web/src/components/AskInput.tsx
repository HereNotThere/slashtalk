import { useEffect, useRef, useState } from "react";
import { PaperAirplaneIcon } from "@heroicons/react/24/solid";

interface AskInputProps {
  onSubmit: (text: string) => void;
  busy: boolean;
  /** Optional dynamic placeholder driven by gerund cycler when busy. */
  busyHint?: string | null;
  contextHint?: string | null;
}

export function AskInput({ onSubmit, busy, busyHint, contextHint }: AskInputProps): JSX.Element {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!busy) inputRef.current?.focus();
  }, [busy]);

  const submit = () => {
    const text = value.trim();
    if (!text || busy) return;
    setValue("");
    onSubmit(text);
  };

  const placeholder = busy
    ? busyHint
      ? `${busyHint}…`
      : "Thinking…"
    : contextHint
      ? `Ask about ${contextHint}…`
      : "Ask anything about your team's work…";

  return (
    <form
      className="ui-chrome flex items-center gap-2 border-t border-divider bg-surface px-3 pt-3"
      style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        // 16px font is required to stop iOS Safari from auto-zooming the
        // viewport on focus. Smaller and the page jumps every time the
        // keyboard opens.
        className="min-w-0 flex-1 rounded-full border border-divider bg-surface-alt px-4 py-2.5 text-[16px] text-fg placeholder:text-subtle focus:border-primary focus:outline-none disabled:opacity-60"
      />
      <button
        type="submit"
        disabled={busy || value.trim().length === 0}
        aria-label="Send"
        className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-primary text-primary-fg transition-colors hover:bg-primary-hover disabled:bg-surface-alt disabled:text-subtle"
      >
        <PaperAirplaneIcon className="h-4 w-4" />
      </button>
    </form>
  );
}
