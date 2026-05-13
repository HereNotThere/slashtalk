// Single source of truth for the "contact us" link rendered in the project
// info popover and onboarding screens. Owns the recipient address + the
// Electron-mailto routing so changing either is a one-file edit.

export function FeedbackLink({ className = "" }: { className?: string }): JSX.Element {
  return (
    <button
      type="button"
      onClick={(e) => {
        // Harmless outside a clickable parent; required inside the project
        // popover, where the surrounding card has its own click handlers.
        e.stopPropagation();
        // mailto in Electron must go through openExternal — plain `<a href>`
        // is either ignored or routed inside the BrowserWindow.
        void window.chatheads.openExternal("mailto:help@towns.com");
      }}
      className={className}
    >
      help@towns.com
    </button>
  );
}
