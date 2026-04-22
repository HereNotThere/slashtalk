import { useEffect, useState } from 'react';
import type { ChatHead } from '../../shared/types';

// Subscribes to main-process head updates. Used by every renderer that needs
// the live head list (main, overlay, statusbar).
export function useHeads(): ChatHead[] {
  const [heads, setHeads] = useState<ChatHead[]>([]);

  useEffect(() => {
    void window.chatheads.list().then(setHeads);
    return window.chatheads.onUpdate(setHeads);
  }, []);

  return heads;
}
