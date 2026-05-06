// Recovery action shown alongside a `no_access` add-repo error: opens
// GitHub's authorized-OAuth-apps page for slashtalk so the user can grant
// or request OAuth access for the repo's owning org. Lives outside the
// error component so the tray popup (compact `xs`) and the onboarding
// screen (`sm`) can share the styling but pick their own padding.

export function GrantOrgAccessButton({
  size = "xs",
  className = "",
}: {
  size?: "xs" | "sm";
  className?: string;
}): JSX.Element {
  const padding = size === "xs" ? "px-2 py-1" : "px-3 py-1.5";
  return (
    <button
      type="button"
      onClick={() => void window.chatheads.openGithubOAuthAppSettings()}
      className={`inline-flex items-center rounded-md border border-danger/40 bg-danger/5 ${padding} text-xs font-medium text-danger hover:bg-danger/15 cursor-pointer [font:inherit] ${className}`.trim()}
    >
      Grant access on GitHub →
    </button>
  );
}
