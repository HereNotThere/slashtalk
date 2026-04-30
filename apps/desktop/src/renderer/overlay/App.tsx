import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { ChatHead, DockConfig } from "../../shared/types";
import { useHeads } from "../shared/useHeads";
import { useActivityBadgeUpdate } from "../shared/useActivityBadgeUpdate";
import { MagnifyingGlassIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useNoTrackedRepos } from "../shared/useNoTrackedRepos";

const DRAG_THRESHOLD = 4;
const REORDER_ANIM_MS = 280;
const ENTER_ANIM_MS = 280;
const ENTER_EASE = "cubic-bezier(.25, .9, .3, 1.1)";
// Slightly longer than the longest CSS animation (last ring delay 0.4s + 1.4s)
// so the markup stays mounted until the animation visually finishes.
const PR_CELEBRATION_MS = 2000;
const SPARK_COUNT = 8;
const SPARK_DISTANCE_PX = 28;

// Hover-to-show timings. Enter-delay avoids showing during pass-through
// hovers; leave-delay gives the cursor time to reach the info panel (whose
// own hover handlers then cancel the scheduled hide in main).
const HOVER_SHOW_DELAY_MS = 80;

// Peers idle past this threshold collapse into a hover-expanding stack.
const INACTIVE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
// Bubble (45px) + py-[7px] padding both sides = 59px main-axis stride per wrapper.
const STACK_WRAPPER_PX = 59;
// How much of each collapsed stack item peeks past the previous one. Smaller =
// tighter stack. The bubble visible portion is roughly this much (zero would
// fully hide everything past the first bubble).
const STACK_PEEK_PX = 8;
// Negative margin needed to overlap wrappers down to the peek.
const STACK_COLLAPSED_OVERLAP_PX = STACK_WRAPPER_PX - STACK_PEEK_PX;

// Compact "time since" — "now" / "5m" / "3h" / "2d".
function formatAge(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

// Mouse handling:
// - Below DRAG_THRESHOLD on mouseUp = click (chat bubble only) / no-op for
//   avatar bubbles — info is hover-driven, not click-driven.
// - Above threshold = start an IPC drag of the rail.
// - Hover enter/leave on avatar bubbles drives info window show/hide through
//   main, with a short enter delay and a longer leave grace (main-side).
export function App(): JSX.Element {
  const heads = useHeads();
  const stackRef = useRef<HTMLDivElement>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [dock, setDock] = useState<DockConfig>({
    orientation: "vertical",
    side: "end",
  });
  const hoverShowTimer = useRef<number | null>(null);
  const [stackExpanded, setStackExpanded] = useState(false);
  const [infoOpenHeadId, setInfoOpenHeadId] = useState<string | null>(null);
  // Mirror main's default (`getRailCollapseInactive` returns true unless the
  // user opted out). Matching here avoids a false→true flip on first paint
  // when settings load asynchronously, which read as an expand/collapse yoyo.
  const [collapseInactive, setCollapseInactive] = useState(true);
  const [showActivityTimestamps, setShowActivityTimestamps] = useState(true);
  // Repo the SearchBubble's project-card hover targets. Resolved from the
  // tray's repo-selection (∩ tracked) — null when nothing is picked, in which
  // case hover falls through and only click-to-search remains.
  const [projectRepoFullName, setProjectRepoFullName] = useState<string | null>(null);
  const bubbleRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // FLIP "previous position" cache, keyed on id. We store the main-axis coord
  // (top for vertical rail, left for horizontal) so a reorder that moves a
  // bubble along the rail can animate from its old position.
  const prevPos = useRef<Map<string, number>>(new Map());
  const prevIds = useRef<Set<string>>(new Set());
  const [replayToken, setReplayToken] = useState(0);
  const isHorizontal = dock.orientation === "horizontal";

  // FLIP reorder + enter animation. Self (index 0) is tracked too now so it can
  // play its enter animation on first mount (or when replayed via debug); after
  // first paint its id is in prevIds so reorder/enter won't re-fire unless the
  // replay signal clears prevIds first.
  //
  // Axis-aware: for a vertical rail we track/animate `top`; for a horizontal
  // rail we track/animate `left`. The enter animation uses the same axis so
  // new bubbles slide in from the "upstream" direction of the rail.
  useLayoutEffect(() => {
    const forceAllEnter = replayToken > 0 && prevIds.current.size === 0;
    const axis = isHorizontal ? "X" : "Y";
    const enterOffset = isHorizontal ? "translateX(-6px)" : "translateY(-6px)";

    const newPos = new Map<string, number>();
    for (const [id, el] of bubbleRefs.current) {
      const rect = el.getBoundingClientRect();
      newPos.set(id, isHorizontal ? rect.left : rect.top);
    }

    for (const [id, el] of bubbleRefs.current) {
      const isNew = forceAllEnter || !prevIds.current.has(id);
      if (isNew) {
        el.style.transition = "none";
        el.style.transform = `scale(.4) ${enterOffset}`;
        el.style.opacity = "0";
        void el.getBoundingClientRect();
        requestAnimationFrame(() => {
          el.style.transition = `transform ${ENTER_ANIM_MS}ms ${ENTER_EASE}, opacity ${ENTER_ANIM_MS}ms ease-out`;
          el.style.transform = "scale(1) translateY(0)";
          el.style.opacity = "1";
        });
        continue;
      }
      const prev = prevPos.current.get(id);
      const next = newPos.get(id);
      if (prev == null || next == null || prev === next) continue;
      const delta = prev - next;
      el.style.transition = "none";
      el.style.transform = `translate${axis}(${delta}px)`;
      void el.getBoundingClientRect();
      requestAnimationFrame(() => {
        el.style.transition = `transform ${REORDER_ANIM_MS}ms cubic-bezier(.2,.7,.2,1)`;
        el.style.transform = "translate" + axis + "(0)";
      });
    }

    prevPos.current = newPos;
    prevIds.current = new Set(bubbleRefs.current.keys());
  }, [heads, replayToken, isHorizontal]);

  useEffect(() => {
    return window.chatheads.onOverlayConfig((cfg) => {
      // Orientation flip — reset FLIP caches so the first frame in the new
      // layout doesn't try to animate bubbles from irrelevant prev positions.
      setDock((prev) => {
        if (prev.orientation !== cfg.orientation) {
          prevPos.current.clear();
          prevIds.current = new Set(bubbleRefs.current.keys());
        }
        return cfg;
      });
    });
  }, []);

  // Debug: main tells us to replay the mount animation on all current heads.
  useEffect(() => {
    return window.chatheads.onDebugReplayEnter(() => {
      prevIds.current.clear();
      prevPos.current.clear();
      setReplayToken((n) => n + 1);
    });
  }, []);

  useEffect(() => {
    return window.chatheads.onChatState(({ visible }) => setChatOpen(visible));
  }, []);

  useEffect(() => {
    return window.chatheads.onInfoState(({ visible, headId }) => {
      setInfoOpenHeadId(visible ? headId : null);
    });
  }, []);

  useEffect(() => {
    let alive = true;
    void window.chatheads.rail.getCollapseInactive().then((v) => {
      if (alive) setCollapseInactive(v);
    });
    const off = window.chatheads.rail.onCollapseInactiveChange((v) => setCollapseInactive(v));
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void window.chatheads.rail.getShowActivityTimestamps().then((v) => {
      if (alive) setShowActivityTimestamps(v);
    });
    const off = window.chatheads.rail.onShowActivityTimestampsChange((v) =>
      setShowActivityTimestamps(v),
    );
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    let downPos: { x: number; y: number } | null = null;
    let downAction: "search" | "add-repo" | null = null;
    let dragging = false;

    const onDown = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      downPos = { x: e.screenX, y: e.screenY };
      const target = e.target instanceof Element ? e.target.closest("[data-bubble]") : null;
      downAction = target?.hasAttribute("data-search")
        ? "search"
        : target?.hasAttribute("data-add-repo")
          ? "add-repo"
          : null;
      dragging = false;
    };

    const onMove = (e: MouseEvent): void => {
      if (!downPos || dragging) return;
      const dx = e.screenX - downPos.x;
      const dy = e.screenY - downPos.y;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        dragging = true;
        void window.chatheads.dragStart();
      }
    };

    const onUp = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      if (dragging) void window.chatheads.dragEnd();
      else if (downAction === "search") void window.chatheads.showAsk();
      else if (downAction === "add-repo") void window.chatheads.openSettings();
      downPos = null;
      downAction = null;
      dragging = false;
    };

    const onBlur = (): void => {
      if (dragging) void window.chatheads.dragEnd();
      downPos = null;
      downAction = null;
      dragging = false;
    };

    window.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Resolve which repo the SearchBubble's project-card hover targets. Pick
  // the first selected tracked repo (intersection of `trackedRepos.selection`
  // and `backend.listTrackedRepos`); fall back to the first tracked repo when
  // selection is empty so a fresh sign-in still shows a card. Null when
  // nothing is tracked yet.
  useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const [selectedIds, tracked] = await Promise.all([
          window.chatheads.trackedRepos.selection(),
          window.chatheads.backend.listTrackedRepos(),
        ]);
        if (cancelled) return;
        const selected = new Set(selectedIds);
        const first = tracked.find((r) => selected.has(r.repoId)) ?? tracked[0] ?? null;
        setProjectRepoFullName(first?.fullName ?? null);
      } catch {
        if (!cancelled) setProjectRepoFullName(null);
      }
    };
    void refresh();
    const offSel = window.chatheads.trackedRepos.onSelectionChange(() => void refresh());
    const offTracked = window.chatheads.backend.onTrackedReposChange(() => void refresh());
    return () => {
      cancelled = true;
      offSel();
      offTracked();
    };
  }, []);

  const hoverEnterBubble = (headId: string, bubbleScreen: { x: number; y: number }): void => {
    if (hoverShowTimer.current != null) {
      window.clearTimeout(hoverShowTimer.current);
    }
    // Cancel main-side hide immediately so switching between bubbles keeps
    // the window open; the delayed show then fires if the cursor settles.
    void window.chatheads.infoHoverEnter();
    hoverShowTimer.current = window.setTimeout(() => {
      hoverShowTimer.current = null;
      void window.chatheads.showInfo(headId, bubbleScreen);
    }, HOVER_SHOW_DELAY_MS);
  };

  const hoverEnterSearch = (repoFullName: string, bubbleScreen: { x: number; y: number }): void => {
    if (hoverShowTimer.current != null) {
      window.clearTimeout(hoverShowTimer.current);
    }
    void window.chatheads.infoHoverEnter();
    hoverShowTimer.current = window.setTimeout(() => {
      hoverShowTimer.current = null;
      void window.chatheads.showProjectInfo(repoFullName, bubbleScreen);
    }, HOVER_SHOW_DELAY_MS);
  };

  const hoverLeaveBubble = (): void => {
    if (hoverShowTimer.current != null) {
      window.clearTimeout(hoverShowTimer.current);
      hoverShowTimer.current = null;
    }
    void window.chatheads.infoHoverLeave();
  };

  const registerBubble =
    (id: string) =>
    (el: HTMLDivElement | null): void => {
      if (el) bubbleRefs.current.set(id, el);
      else bubbleRefs.current.delete(id);
    };

  const handleBubbleEnter = (headId: string, e: React.MouseEvent<HTMLDivElement>): void => {
    // The wrapper has padding around the bubble; report the inner bubble's
    // rect so the info window anchors to the avatar, not the padding box.
    const inner = e.currentTarget.querySelector<HTMLElement>("[data-bubble]");
    const rect = (inner ?? e.currentTarget).getBoundingClientRect();
    const screenX = Math.round(rect.left + window.screenX);
    const screenY = Math.round(rect.top + window.screenY);
    hoverEnterBubble(headId, { x: screenX, y: screenY });
  };

  const handleSearchBubbleEnter = (e: React.MouseEvent<HTMLDivElement>): void => {
    // Project card needs a target repo. We anchor the popover off the inner
    // SearchBubble rect (same math as user bubbles), and bail when the user
    // hasn't picked a repo yet — falling through to no card is friendlier
    // than guessing.
    if (!projectRepoFullName) return;
    const inner = e.currentTarget.querySelector<HTMLElement>("[data-bubble]");
    const rect = (inner ?? e.currentTarget).getBoundingClientRect();
    const screenX = Math.round(rect.left + window.screenX);
    const screenY = Math.round(rect.top + window.screenY);
    hoverEnterSearch(projectRepoFullName, { x: screenX, y: screenY });
  };

  // Self is the first user-kind head — rail.ts orders self before peers
  // within the user-kind block. Everything else (agents + peers) renders in
  // the peer column below self.
  const self = heads.find((h) => h.kind === "user") ?? null;
  const allPeers = heads.filter((h) => h !== self);
  const now = Date.now();
  // Inactivity is a property of the peer's last action — independent of the
  // tray toggle. The toggle only controls whether inactive peers get split
  // into a stack; the pale ("bleak") treatment follows them regardless.
  const isPeerInactive = (h: ChatHead): boolean => {
    if (h.live === true) return false;
    if (h.lastActionAt == null) return true;
    return now - h.lastActionAt > INACTIVE_THRESHOLD_MS;
  };
  const shouldStack = (h: ChatHead): boolean => collapseInactive && isPeerInactive(h);
  const activePeers = allPeers.filter((h) => !shouldStack(h));
  const inactivePeers = allPeers.filter(shouldStack);
  // When the user has zero tracked repos, the rail collapses to self + search
  // with no signal that more was supposed to appear. Slip an "+ add repo"
  // bubble between them — clicks open the tray for the actual flow. Peer
  // guards keep it from firing when the rail still has teammates; under
  // SLASHTALK_DEBUG_EMPTY we skip them so the bubble is previewable against
  // a real account that already has peers loaded.
  const noTrackedRepos = useNoTrackedRepos();
  const debugEmptyState = window.chatheads.debug.emptyState;
  const showAddRepoHint =
    noTrackedRepos === true &&
    (debugEmptyState || (activePeers.length === 0 && inactivePeers.length === 0));
  const stackPinnedByInfo =
    infoOpenHeadId != null && inactivePeers.some((p) => p.id === infoOpenHeadId);
  const stackVisuallyExpanded = stackExpanded || stackPinnedByInfo;

  // Tell main how tall (vertical) / wide (horizontal) the rail wants to be so
  // the BrowserWindow can grow/shrink with the inactive-stack expand/collapse.
  // The constants here mirror the layout below — keep in sync. Main applies
  // the value with `setBounds(animate=true)` so the window animation runs in
  // parallel with the renderer's margin transition.
  //
  // Skip reporting until heads are populated. `useHeads` starts at [] and
  // resolves async, so a first effect with empty heads would report a tiny
  // length and shrink the window before the real data arrives — read as a
  // collapse/expand yoyo on first open. Main closes the overlay outright
  // when heads are genuinely empty, so this gate is safe.
  const headsLoaded = heads.length > 0;
  const activeCount = activePeers.length;
  const inactiveCount = inactivePeers.length;
  useEffect(() => {
    if (!headsLoaded) return;
    const RAIL_OUTER_PAD_PX = 16; // py-4 / px-4 main-axis padding on the rail
    // search + self + active peers (+ optional add-repo bubble)
    const wrapperCount = 2 + activeCount + (showAddRepoHint ? 1 : 0);
    let length = wrapperCount * STACK_WRAPPER_PX;
    if (inactiveCount > 0) {
      length += stackVisuallyExpanded
        ? inactiveCount * STACK_WRAPPER_PX
        : STACK_WRAPPER_PX + (inactiveCount - 1) * STACK_PEEK_PX;
    }
    length += RAIL_OUTER_PAD_PX * 2;
    void window.chatheads.setOverlayLength(length);
  }, [headsLoaded, activeCount, inactiveCount, stackVisuallyExpanded, showAddRepoHint]);

  // Outer fills the window exactly along the rail's main axis (height for
  // vertical, width for horizontal). Self + chat are shrink-0; the peer list
  // is a flex-1 scroll container that takes whatever's left. Using flex sizing
  // instead of fixed maxs avoids sub-pixel rounding that otherwise clipped the
  // last peer by 1-2px and left a scroll stub.
  //
  // Spacing between adjacent bubbles is per-bubble padding (7px each side, so
  // the gap reads as 14px between bubbles) rather than container `gap`. This
  // makes adjacent wrappers touch — the cursor never crosses an empty area
  // between bubbles, which was causing the hover/info-card to flicker.
  // Cross-axis padding lives on each bubble wrapper (not the rail container)
  // so the hit area extends to the window edge — moving the cursor near the
  // edge still triggers the bubble's hover. Main-axis padding (`py-4`) stays
  // on the rail so first/last bubbles get breathing room above/below.
  const stackClass = isHorizontal
    ? "flex flex-row items-center px-4 box-border w-screen"
    : "flex flex-col items-center py-4 box-border h-screen";
  const peersClass = isHorizontal
    ? "h-full flex-1 min-w-0 flex flex-row items-center overflow-x-auto overflow-y-hidden no-scrollbar"
    : "w-full flex-1 min-h-0 flex flex-col items-center overflow-y-auto overflow-x-hidden no-scrollbar";
  const bubblePadClass = isHorizontal ? "shrink-0 px-[7px] py-3" : "shrink-0 py-[7px] px-3";
  return (
    <div ref={stackRef} className={stackClass}>
      {self && (
        <div
          key={self.id}
          ref={registerBubble(self.id)}
          className={bubblePadClass}
          onMouseEnter={(e) => handleBubbleEnter(self.id, e)}
          onMouseLeave={hoverLeaveBubble}
        >
          <Bubble
            head={self}
            onHoverEnter={() => {}}
            onHoverLeave={() => {}}
            hideAge={!showActivityTimestamps}
          />
        </div>
      )}
      {(activePeers.length > 0 || inactivePeers.length > 0) && (
        <div className={peersClass}>
          {activePeers.map((h) => (
            <div
              key={h.id}
              ref={registerBubble(h.id)}
              className={bubblePadClass}
              onMouseEnter={(e) => handleBubbleEnter(h.id, e)}
              onMouseLeave={hoverLeaveBubble}
            >
              <Bubble
                head={h}
                onHoverEnter={() => {}}
                onHoverLeave={() => {}}
                pale={isPeerInactive(h)}
                hideAge={!showActivityTimestamps}
              />
            </div>
          ))}
          {inactivePeers.length > 0 && (
            <div
              className={`flex items-center shrink-0 ${isHorizontal ? "flex-row" : "flex-col"}`}
              onMouseEnter={() => setStackExpanded(true)}
              onMouseLeave={() => setStackExpanded(false)}
            >
              {inactivePeers.map((h, i) => {
                // Each wrapper is STACK_WRAPPER_PX on the main axis.
                // Expanded margin 0 → wrappers touch, bubbles are 14px apart
                // via padding. Collapsed margin -STACK_COLLAPSED_OVERLAP_PX
                // → wrappers overlap so each bubble peeks STACK_PEEK_PX
                // past the previous.
                const offset =
                  i === 0 ? 0 : stackVisuallyExpanded ? 0 : -STACK_COLLAPSED_OVERLAP_PX;
                const style: CSSProperties = {
                  zIndex: inactivePeers.length - i,
                  transition:
                    "margin 280ms cubic-bezier(.2,.7,.2,1), filter 280ms cubic-bezier(.2,.7,.2,1)",
                  transitionDelay: `${i * 20}ms`,
                  // Drop a small shadow on each stacked bubble while collapsed
                  // so the layered cards effect reads visually. drop-shadow
                  // follows the bubble's alpha shape (the 45px circle), not
                  // the wrapper's box. Skip the first (nothing peeks past it
                  // — would just halo the top) and the last (no bubble below
                  // it; the shadow would float out into empty space).
                  filter:
                    !stackVisuallyExpanded && i < inactivePeers.length - 1
                      ? "drop-shadow(0 1px 0px rgba(255,255,255,0.15))"
                      : undefined,
                  ...(isHorizontal ? { marginLeft: offset } : { marginTop: offset }),
                };
                // Intentionally not registered in bubbleRefs: FLIP would
                // overwrite el.style.transition on enter/reorder and kill the
                // stack expand/collapse animation. Stacked peers overlap each
                // other anyway, so reorder animations would be invisible.
                return (
                  <div
                    key={h.id}
                    onMouseEnter={(e) => handleBubbleEnter(h.id, e)}
                    onMouseLeave={hoverLeaveBubble}
                    style={style}
                    className={bubblePadClass}
                  >
                    <Bubble
                      head={h}
                      onHoverEnter={() => {}}
                      onHoverLeave={() => {}}
                      hideAge={!showActivityTimestamps || !stackVisuallyExpanded}
                      pale
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {showAddRepoHint && (
        <div className={bubblePadClass}>
          <AddRepoBubble />
        </div>
      )}
      <div
        className={bubblePadClass}
        onMouseEnter={handleSearchBubbleEnter}
        onMouseLeave={hoverLeaveBubble}
      >
        <SearchBubble open={chatOpen} />
      </div>
    </div>
  );
}

function AddRepoBubble(): JSX.Element {
  // Click is dispatched by the global mouseup handler (after the drag-vs-click
  // discriminator), not by React onClick — otherwise dragging the rail from
  // this bubble would fire openMain on release.
  return (
    <div
      data-bubble
      data-add-repo
      title="Add a repo to see your team"
      className="
        relative w-11.25 h-11.25 rounded-full cursor-pointer
        flex items-center justify-center
        bg-primary/85 text-primary-fg
        outline-1 -outline-offset-1 outline-white/25
        transition-transform duration-150 ease-out
        hover:scale-[1.05] hover:bg-primary
      "
    >
      <PlusIcon className="w-5 h-5 pointer-events-none" />
    </div>
  );
}

function SearchBubble({ open }: { open: boolean }): JSX.Element {
  return (
    <div
      data-bubble
      data-search
      title={open ? "Close search" : "Search your team"}
      className="
        relative w-11.25 h-11.25 rounded-full cursor-pointer
        flex items-center justify-center
        bg-black/15 text-white
        outline-1 -outline-offset-1 outline-white/20
        transition-transform duration-150 ease-out
        hover:scale-[1.03] hover:bg-black/20
      "
    >
      <div className="pointer-events-none">
        {open ? <XMarkIcon className="w-5 h-5" /> : <MagnifyingGlassIcon className="w-5 h-5" />}
      </div>
    </div>
  );
}

function Bubble({
  head,
  onHoverEnter,
  onHoverLeave,
  hideAge = false,
  pale = false,
}: {
  head: ChatHead;
  onHoverEnter: () => void;
  onHoverLeave: () => void;
  hideAge?: boolean;
  pale?: boolean;
}): JSX.Element {
  useActivityBadgeUpdate(head.lastActionAt ?? null);
  const celebrating = usePrCelebration(head.prActivityAt ?? null);
  const colliding = head.collisionAt != null;

  const handleMouseEnter = (): void => {
    void window.chatheads.preloadSessions(head.id);
    onHoverEnter();
  };

  const tooltip =
    colliding && head.collisionFile
      ? `${head.label} — also editing ${head.collisionFile}`
      : head.label;

  return (
    <div
      data-bubble
      title={tooltip}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={onHoverLeave}
      style={{
        transition: "transform 150ms ease-out, filter 280ms cubic-bezier(.2,.7,.2,1)",
        filter: pale ? "saturate(0.5) contrast(0.5)" : undefined,
      }}
      className="
        relative w-11.25 h-11.25 rounded-full cursor-pointer
        flex items-center justify-center text-[28px]
        bg-bubble
        backdrop-blur-[18px] backdrop-saturate-[1.4]
        hover:scale-[1.03]
      "
    >
      {head.avatar.type === "emoji" ? (
        <>
          <div
            className="absolute inset-0 rounded-full opacity-[0.28] pointer-events-none"
            style={{ background: head.tint }}
          />
          <span className="relative z-1 leading-none pointer-events-none">{head.avatar.value}</span>
        </>
      ) : (
        <img
          src={head.avatar.value}
          alt=""
          className="w-full h-full rounded-full object-cover pointer-events-none"
        />
      )}
      {!hideAge && head.lastActionAt != null && !head.live && (
        <div
          className="
            absolute bottom-0 right-0 z-2
            px-1.5 py-0.5 rounded-full
            bg-black/30 backdrop-blur-md backdrop-saturate-[1.4]
            text-white text-[9px] font-light leading-none
            border border-white/10
            pointer-events-none
          "
        >
          {formatAge(Date.now() - head.lastActionAt)}
        </div>
      )}
      {/* Suppress the live (blue) ring when a collision is showing — only one
       *  status ring at a time keeps the bubble legible. Uses `border-info`
       *  (blue) rather than `border-primary` (green) so the rail signal
       *  visually matches the info card's blue "working now" label. */}
      {head.live === true && !colliding && (
        <div
          aria-hidden
          className="
            absolute -inset-0.5 rounded-full
            border-2 border-info pointer-events-none z-3
          "
          style={{ animation: "live-ring 1.6s ease-in-out infinite" }}
        />
      )}
      {colliding && (
        <div
          aria-hidden
          className="absolute inset-[-2px] rounded-full border-2 pointer-events-none"
          style={{
            borderColor: "#fb7185", // rose-400 — matches the popover banner dot
            animation: "live-ring 1.6s ease-in-out infinite",
            // Below the timestamp chip (z-2) so the chip stays readable.
            zIndex: 1,
          }}
        />
      )}
      {celebrating != null && <PrCelebration key={celebrating} />}
    </div>
  );
}

// Returns the timestamp to use as a remount key while the celebration is
// active, or null when it should not render. Bound to prActivityAt so a new
// PR (different timestamp) restarts the animation cleanly.
function usePrCelebration(prActivityAt: number | null): number | null {
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    if (prActivityAt == null) {
      setActive(null);
      return;
    }
    const elapsed = Date.now() - prActivityAt;
    if (elapsed >= PR_CELEBRATION_MS) {
      setActive(null);
      return;
    }
    setActive(prActivityAt);
    const t = setTimeout(() => setActive(null), PR_CELEBRATION_MS - elapsed);
    return () => clearTimeout(t);
  }, [prActivityAt]);
  return active;
}

function PrCelebration(): JSX.Element {
  return (
    <div className="pr-celebration">
      <div className="pr-ring" />
      <div className="pr-ring" />
      <div className="pr-ring" />
      {Array.from({ length: SPARK_COUNT }).map((_, i) => {
        const angle = (i / SPARK_COUNT) * Math.PI * 2;
        const dx = Math.cos(angle) * SPARK_DISTANCE_PX;
        const dy = Math.sin(angle) * SPARK_DISTANCE_PX;
        return (
          <span
            key={i}
            className="pr-spark"
            style={
              {
                animationDelay: `${i * 0.04}s`,
                "--dx": `${dx.toFixed(1)}px`,
                "--dy": `${dy.toFixed(1)}px`,
              } as CSSProperties
            }
          />
        );
      })}
    </div>
  );
}
