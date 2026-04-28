import { useEffect, useState } from "react";
import { ClockIcon } from "@heroicons/react/24/outline";
import type { ChatThread } from "@slashtalk/shared";
import { relativeTime } from "../shared/relativeTime";

const PREVIEW_LIMIT = 8;

export function RecentQuestionsSection(): JSX.Element | null {
  const [threads, setThreads] = useState<ChatThread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void load();

    async function load(): Promise<void> {
      try {
        const res = await window.chatheads.fetchChatHistory();
        if (!cancelled) setThreads(res.threads);
      } catch (err) {
        if (!cancelled) setError((err as Error).message ?? "Failed to load");
      }
    }
    return () => {
      cancelled = true;
    };
  }, []);

  if (threads === null && !error) return null;

  if (error) {
    return (
      <section className="bg-surface rounded-2xl p-4 mt-4">
        <h2 className="text-base font-medium mb-2">Recent questions</h2>
        <div className="text-sm text-danger">{error}</div>
      </section>
    );
  }
  if (!threads || threads.length === 0) {
    return (
      <section className="bg-surface rounded-2xl p-4 mt-4">
        <h2 className="text-base font-medium mb-2">Recent questions</h2>
        <div className="text-sm text-subtle">
          Nothing yet. The questions you ask Slashtalk will show up here.
        </div>
      </section>
    );
  }

  const visible = showAll ? threads : threads.slice(0, PREVIEW_LIMIT);
  // Gate visibility on the total count, not the currently-visible slice —
  // otherwise expanding the list zeroes out the overflow and the toggle
  // disappears, stranding the user with no way to collapse back.
  const hasMore = threads.length > PREVIEW_LIMIT;
  const overflow = threads.length - PREVIEW_LIMIT;

  return (
    <section className="bg-surface rounded-2xl p-4 mt-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-medium">Recent questions</h2>
        <span className="text-xs text-subtle">{threads.length}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {visible.map((t) => (
          <button
            key={t.threadId}
            type="button"
            onClick={() => void window.chatheads.openThread(t)}
            className="text-left px-3 py-2 rounded-lg bg-surface-alt hover:bg-surface-alt-hover transition-colors"
          >
            <div className="text-sm text-fg line-clamp-2">{t.title}</div>
            <div className="flex items-center gap-1.5 text-xs text-subtle mt-1">
              <ClockIcon className="w-3 h-3" aria-hidden />
              <span>{relativeTime(t.updatedAt)}</span>
              {t.turns.length > 1 && <span>· {t.turns.length} turns</span>}
              {t.cards.length > 0 && <span>· {t.cards.length} sessions cited</span>}
            </div>
          </button>
        ))}
      </div>
      {hasMore && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-xs text-subtle hover:text-muted underline decoration-dotted underline-offset-2 mt-3"
        >
          {showAll ? "Show less" : `Show ${overflow} more`}
        </button>
      )}
    </section>
  );
}
