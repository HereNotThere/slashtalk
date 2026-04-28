import { useEffect, useRef, useState } from "react";
import { PaperAirplaneIcon, XMarkIcon } from "@heroicons/react/24/outline";

export function AskInput({
  contextLabel,
  placeholder,
  onClose,
}: {
  contextLabel: string;
  placeholder?: string;
  onClose: () => void;
}): JSX.Element {
  const [value, setValue] = useState("");
  const [sent, setSent] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (): void => {
    const q = value.trim();
    if (!q) return;
    void window.chatheads.openResponse(`${contextLabel}\n\n${q}`);
    setValue("");
    setSent(true);
    setTimeout(onClose, 1200);
  };

  if (sent) {
    return (
      <div className="mt-2 flex justify-end" onClick={(e) => e.stopPropagation()}>
        <span className="text-[11px] text-success">Asked — opening chat…</span>
      </div>
    );
  }

  return (
    <div className="mt-2 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <div className="flex-1 flex items-center gap-1 h-9 pl-3.5 pr-1 rounded-full bg-surface-alt border border-divider">
        <input
          ref={inputRef}
          type="text"
          value={value}
          placeholder={placeholder ?? "Ask a question…"}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          className="flex-1 min-w-0 bg-transparent border-none outline-none text-sm text-fg placeholder:text-subtle"
        />
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            submit();
          }}
          disabled={!value.trim()}
          aria-label="Send (Enter)"
          title="Send (Enter)"
          className="shrink-0 inline-flex items-center justify-center h-7 w-7 rounded-full bg-primary text-primary-fg hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98] cursor-pointer"
        >
          <PaperAirplaneIcon className="w-3.5 h-3.5" />
        </button>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Cancel"
        title="Cancel"
        className="shrink-0 p-1 rounded-full text-subtle hover:text-fg hover:bg-surface-alt-hover transition-colors cursor-pointer"
      >
        <XMarkIcon className="w-4 h-4" />
      </button>
    </div>
  );
}
