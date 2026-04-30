import { useEffect, useState } from "react";

// True when the user has zero tracked repos OR the SLASHTALK_DEBUG_EMPTY=1
// override is active. Renderer surfaces use this to swap in their no-repo
// empty state. Returns null until the first list-query resolves so callers
// can avoid flashing the empty state during the IPC round-trip.
export function useNoTrackedRepos(): boolean | null {
  const [noRepos, setNoRepos] = useState<boolean | null>(
    window.chatheads.debug.emptyState ? true : null,
  );

  useEffect(() => {
    if (window.chatheads.debug.emptyState) return;
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const tracked = await window.chatheads.backend.listTrackedRepos();
        if (!cancelled) setNoRepos(tracked.length === 0);
      } catch {
        if (!cancelled) setNoRepos(false);
      }
    };
    void refresh();
    const off = window.chatheads.backend.onTrackedReposChange(() => void refresh());
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return noRepos;
}
