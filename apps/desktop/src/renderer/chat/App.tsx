import { useEffect, useRef, useState } from "react";
import { SearchIcon, SendIcon } from "../shared/icons";

// Pill-shaped input popover. Esc or blur (main handles blur) dismisses.
// No submit handling yet — this is the visual shell; backend integration lands
// with the chat/ask endpoint.
//
// `anchor` tracks which side of the pill the leading search-icon circle sits
// on, so the icon always overlaps the chat bubble on the rail regardless of
// which screen edge the rail is anchored to. Main sends this via `chat:config`.
export function App(): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [anchor, setAnchor] = useState<"left" | "right">("left");

  useEffect(() => {
    return window.chatheads.onChatConfig((cfg) => setAnchor(cfg.anchor));
  }, []);

  // Autofocus whenever the window becomes visible. Electron re-mounts only
  // when hot-reloaded, so we also refocus on window `focus` to cover
  // show-after-hide cycles (the window is hidden, not destroyed).
  useEffect(() => {
    const focus = (): void => inputRef.current?.focus();
    focus();
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      void window.chatheads.hideChat();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = (): void => {
    if (value.trim()) {
      void window.chatheads.openResponse(value);
      setValue("");
    }
  };

  const mirrored = anchor === "right";

  return (
    <div className="w-full h-full flex items-center justify-center p-sm">
      <div
        className={`
          w-full flex items-center gap-md h-14 rounded-full bg-card
          shadow-[0_8px_24px_rgba(0,0,0,0.22),0_2px_6px_rgba(0,0,0,0.12)]
          ${mirrored ? "flex-row-reverse pr-2 pl-md" : "pl-2 pr-md"}
        `}
      >
        <div className="w-10 h-10 rounded-full bg-surface flex items-center justify-center shrink-0 text-muted">
          <SearchIcon />
        </div>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about what your team has been doing..."
          className="
            flex-1 min-w-0 bg-transparent border-none outline-none
            text-[15px] text-fg placeholder:text-subtle
          "
        />
        {value.trim() ? (
          <button
            onClick={handleSend}
            className="
              w-10 h-10 rounded-full bg-chat flex items-center justify-center
              shrink-0 text-white shadow-[0_2px_4px_rgba(0,0,0,0.2)]
              hover:opacity-90 transition-opacity cursor-pointer
            "
            aria-label="Send"
          >
            <SendIcon />
          </button>
        ) : (
          <kbd
            className="
              px-1.5 py-0.5 rounded-md bg-surface text-subtle
              text-[11px] font-mono font-medium leading-none
              shrink-0
            "
          >
            esc
          </kbd>
        )}
      </div>
    </div>
  );
}

