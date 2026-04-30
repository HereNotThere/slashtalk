import { useEffect, useRef, useState, type ReactNode } from "react";
import { PrIcon } from "./icons";
import { PR_STATE_COLOR, PR_STATE_LABEL } from "./pr-state";
import { relativeTime } from "./relativeTime";

interface PrItemPr {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged";
  updatedAt: string;
}

/** One-line PR row used by both the user-card and project-card surfaces.
 *  Title truncates with an ellipsis; on a sustained hover (~500ms) it
 *  marquees left so an overlong title can be read in full. */
export function PrItem({
  pr,
  authorLogin,
  trailing,
}: {
  pr: PrItemPr;
  /** Project view shows the author in the meta line; user view omits it
   *  since the card itself is about that user. */
  authorLogin?: string;
  /** Right-edge slot — project view passes a `PersonAvatar`; user view
   *  passes an `AskTrigger` so a single click opens the inline AskInput. */
  trailing?: ReactNode;
}): JSX.Element {
  const openPr = (): void => {
    void window.chatheads.openExternal(pr.url);
  };
  return (
    <div className="px-4 py-2 group hover:bg-surface-alt/60 transition-colors">
      <div
        role="button"
        tabIndex={0}
        onClick={openPr}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openPr();
          }
        }}
        // State word lives in the native tooltip rather than the meta line —
        // the icon + #N color already encode state visually.
        title={PR_STATE_LABEL[pr.state]}
        className="flex items-center gap-2 cursor-pointer"
      >
        <PrIcon state={pr.state} className={`w-3.5 h-3.5 shrink-0 ${PR_STATE_COLOR[pr.state]}`} />
        <div className="flex-1 min-w-0">
          <MarqueeTitle text={pr.title} />
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-subtle">
            <span className={`font-medium ${PR_STATE_COLOR[pr.state]}`}>#{pr.number}</span>
            {authorLogin && (
              <>
                <span aria-hidden>·</span>
                <span>@{authorLogin}</span>
              </>
            )}
            <span aria-hidden>·</span>
            <span>{relativeTime(pr.updatedAt)}</span>
          </div>
        </div>
        {trailing}
      </div>
    </div>
  );
}

const HOVER_DELAY_MS = 500;
// Pixels per second the title scrolls. Slow enough to read; fast enough that
// a long title finishes before the user gives up and moves on.
const SCROLL_SPEED_PX_PER_S = 60;
const RETURN_TRANSITION_S = 0.4;

/** Title that ellipsizes by default and marquees left on sustained hover.
 *  Measures `scrollWidth` against `clientWidth` on hover so non-overflowing
 *  titles never animate (common case — most PR titles fit). */
function MarqueeTitle({ text }: { text: string }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);
  const [animating, setAnimating] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const onEnter = (): void => {
    const c = containerRef.current;
    const i = innerRef.current;
    if (!c || !i) return;
    const ov = i.scrollWidth - c.clientWidth;
    if (ov <= 1) return;
    setOverflow(ov);
    timerRef.current = setTimeout(() => setAnimating(true), HOVER_DELAY_MS);
  };

  const onLeave = (): void => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setAnimating(false);
  };

  const dur = animating ? Math.max(2, overflow / SCROLL_SPEED_PX_PER_S) : RETURN_TRANSITION_S;
  return (
    <div
      ref={containerRef}
      className="overflow-hidden whitespace-nowrap text-sm text-fg leading-snug group-hover:underline decoration-divider underline-offset-2"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <span
        ref={innerRef}
        className={animating ? "inline-block" : "block max-w-full overflow-hidden text-ellipsis"}
        style={{
          transform: animating ? `translateX(-${overflow}px)` : "translateX(0)",
          transition: `transform ${dur}s linear`,
        }}
      >
        {text}
      </span>
    </div>
  );
}
