import { useEffect, useState } from "react";

// True when the user has zero *selected* tracked repos (selection is the
// tray-popup checkbox state — repos can exist but be filtered out). The rail
// keys its add-repo bubble on this rather than total tracked count so a user
// with all-unchecked repos still sees the CTA. SLASHTALK_DEBUG_EMPTY forces
// true for previewing the empty state. Returns null until the first IPC
// resolves to avoid a one-frame flash on mount.
export function useNoSelectedRepos(): boolean | null {
  const [noSelected, setNoSelected] = useState<boolean | null>(
    window.chatheads.debug.emptyState ? true : null,
  );

  useEffect(() => {
    if (window.chatheads.debug.emptyState) return;
    let cancelled = false;
    void window.chatheads.trackedRepos.selection().then((ids) => {
      if (!cancelled) setNoSelected(ids.length === 0);
    });
    const off = window.chatheads.trackedRepos.onSelectionChange((ids) => {
      setNoSelected(ids.length === 0);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return noSelected;
}
