import { useEffect, useState } from "react";

// SLASHTALK_DEBUG_EMPTY forces true for previewing the empty state. Returns
// null until the first IPC resolves so callers can avoid a one-frame flash.
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
