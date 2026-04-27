import { useEffect, useRef, useState } from "react";
import { MagnifyingGlassIcon, PaperAirplaneIcon } from "@heroicons/react/24/outline";
import { Button } from "../shared/Button";

// Frost + rim are painted natively by main (vibrancy + setMacCornerRadius),
// so this renderer is just transparent content on top of that material.
export function App(): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");

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
    <div className="w-screen h-screen flex items-center gap-3 px-3">
      <Button
        variant="ghost"
        size="lg"
        round
        onClick={() => void window.chatheads.hideChat()}
        aria-label="Close search"
        icon={<MagnifyingGlassIcon className="w-5 h-5" />}
        className="bg-bubble text-fg outline-1 -outline-offset-1 outline-bubble-outline hover:bg-bubble"
      />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Ask about what your team has been doing..."
        className="flex-1 min-w-0 bg-transparent border-none outline-none text-md text-fg placeholder:text-subtle"
      />
      <Button
        variant="primary"
        size="lg"
        round
        onClick={handleSend}
        disabled={!value.trim()}
        aria-label="Send"
        icon={<PaperAirplaneIcon className="w-5 h-5" />}
      />
    </div>
  );
}
