import { useEffect, useState } from "react";
import type { ChatHead } from "../../shared/types";

// Subscribes to main-process head updates. Used by every renderer that needs
// the live head list (main, overlay, statusbar).
//
// Agent surfaces are hidden for now — agent heads are filtered out at the
// source so no rail bubble, info panel, or pop-out window opens for them.
// Reverse by removing the filter.
export function useHeads(): ChatHead[] {
  const [heads, setHeads] = useState<ChatHead[]>([]);

  useEffect(() => {
    void window.chatheads.list().then(setHeads);
    return window.chatheads.onUpdate(setHeads);
  }, []);

  return heads.filter((h) => h.kind !== "agent");
}
