import { useEffect, useRef, useState } from "react";
import { SearchIcon, SendIcon } from "../shared/icons";

// Search input pill. Visually a stretched dock bubble: the BrowserWindow paints
// the frosted background + rim natively (vibrancy "popover" + setMacCornerRadius
// in main), so this renderer is just transparent content laid over that frost.
// Esc, blur (main handles blur), or clicking the leading magnifying glass all
// dismiss; main re-shows the dock on hide.
export function App(): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");

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

  return (
    <div className="w-screen h-screen flex items-center gap-md px-md">
      <button
        onClick={() => void window.chatheads.hideChat()}
        className="
          relative w-11.25 h-11.25 rounded-full cursor-pointer shrink-0
          flex items-center justify-center
          bg-black/15 text-white
          outline-1 -outline-offset-1 outline-bubble-outline
          transition-transform duration-150 ease-out
          hover:scale-[1.03] hover:bg-black/20
        "
        aria-label="Close search"
      >
        <div className="pointer-events-none scale-125">
          <SearchIcon />
        </div>
      </button>
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
      <button
        onClick={handleSend}
        disabled={!value.trim()}
        className="
          w-10 h-10 rounded-full flex items-center justify-center shrink-0
          bg-bg text-fg cursor-pointer
          transition-[background-color,opacity] duration-150 ease-out
          hover:bg-button
          disabled:opacity-30 disabled:cursor-default disabled:hover:bg-bg
        "
        aria-label="Send"
      >
        <span className="-rotate-90">
          <SendIcon />
        </span>
      </button>
    </div>
  );
}
