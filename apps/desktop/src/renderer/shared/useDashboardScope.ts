import { useEffect, useState } from "react";
import type { DashboardScope } from "../../shared/types";

/** Read + write the global dashboard time-window pref from any renderer.
 *  Subscribes so a flip on one card updates every other open surface
 *  without a remount. The setter dispatches optimistically, then awaits
 *  the IPC round-trip; the broadcast on the way back is a no-op since
 *  the local state is already current. */
export function useDashboardScope(): {
  scope: DashboardScope;
  setScope: (next: DashboardScope) => void;
} {
  const [scope, setScopeState] = useState<DashboardScope>("today");

  useEffect(() => {
    let alive = true;
    void window.chatheads.rail.getDashboardScope().then((v) => {
      if (alive) setScopeState(v);
    });
    const off = window.chatheads.rail.onDashboardScopeChange((v) => setScopeState(v));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const setScope = (next: DashboardScope): void => {
    setScopeState(next);
    void window.chatheads.rail.setDashboardScope(next);
  };

  return { scope, setScope };
}
