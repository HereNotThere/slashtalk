import { useEffect, useRef, useState } from 'react';
import type { ChatHead } from '../../shared/types';
import { useHeads } from '../shared/useHeads';
import { useActivityBadgeUpdate } from '../shared/useActivityBadgeUpdate';
import { SearchIcon } from '../shared/icons';

const DRAG_THRESHOLD = 4;

// Compact "time since" — "now" / "5m" / "3h" / "2d".
function formatAge(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return 'now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

// Click-vs-drag discrimination + toggle-info, mirrors DraggableHostingView.swift.
// Below threshold on mouseUp = click (toggleInfo); above = start IPC-driven drag.
export function App(): JSX.Element {
  const heads = useHeads();
  const stackRef = useRef<HTMLDivElement>(null);
  const [chatOpen, setChatOpen] = useState(false);

  useEffect(() => {
    return window.chatheads.onChatState(({ visible }) => setChatOpen(visible));
  }, []);

  useEffect(() => {
    let downPos: { x: number; y: number } | null = null;
    let downBubbleIndex: number | null = null;
    let downIsChat = false;
    let dragging = false;

    const onDown = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      downPos = { x: e.screenX, y: e.screenY };
      const target = e.target instanceof Element ? e.target.closest('[data-bubble]') : null;
      downIsChat = target?.hasAttribute('data-chat') ?? false;
      downBubbleIndex = target && !downIsChat && stackRef.current
        ? Array.prototype.indexOf.call(stackRef.current.children, target)
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
      else if (downIsChat) void window.chatheads.toggleChat();
      else if (downBubbleIndex !== null) void window.chatheads.toggleInfo(downBubbleIndex);
      downPos = null;
      downBubbleIndex = null;
      downIsChat = false;
      dragging = false;
    };

    const onBlur = (): void => {
      if (dragging) void window.chatheads.dragEnd();
      downPos = null;
      downBubbleIndex = null;
      downIsChat = false;
      dragging = false;
    };

    window.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  return (
    <div
      ref={stackRef}
      className="flex flex-col items-center gap-sm p-xl box-border"
    >
      {heads.map((h) => (
        <Bubble key={h.id} head={h} />
      ))}
      <ChatBubble hidden={chatOpen} />
    </div>
  );
}

function ChatBubble({ hidden }: { hidden: boolean }): JSX.Element {
  return (
    <div
      data-bubble
      data-chat
      title="Ask your team"
      className={`
        relative w-14 h-14 rounded-full cursor-pointer
        flex items-center justify-center
        bg-chat text-white
        outline outline-1 -outline-offset-1 outline-bubble-outline
        shadow-[0_2px_3px_rgba(0,0,0,0.15)]
        transition-transform duration-150 ease-out
        hover:scale-[1.03] hover:bg-chat-hover
        ${hidden ? "invisible" : ""}
      `}
    >
      <div className="pointer-events-none scale-125">
        <SearchIcon />
      </div>
    </div>
  );
}

function Bubble({ head }: { head: ChatHead }): JSX.Element {
  useActivityBadgeUpdate(head.lastActionAt ?? null);

  const handleMouseEnter = (): void => {
    void window.chatheads.preloadSessions(head.id);
  };

  return (
    <div
      data-bubble
      title={head.label}
      onMouseEnter={handleMouseEnter}
      className="
        relative w-14 h-14 rounded-full cursor-pointer
        flex items-center justify-center text-[28px]
        bg-bubble
        backdrop-blur-[18px] backdrop-saturate-[1.4]
        outline outline-1 -outline-offset-1 outline-bubble-outline
        shadow-[0_2px_3px_rgba(0,0,0,0.15)]
        transition-transform duration-150 ease-out
        hover:scale-[1.03]
      "
    >
      {head.avatar.type === 'emoji' ? (
        <>
          <div
            className="absolute inset-0 rounded-full opacity-[0.28] pointer-events-none"
            style={{ background: head.tint }}
          />
          <span className="relative z-[1] leading-none pointer-events-none">{head.avatar.value}</span>
        </>
      ) : (
        <img
          src={head.avatar.value}
          alt=""
          className="w-full h-full rounded-full object-cover pointer-events-none"
        />
      )}
      {head.lastActionAt != null && (
        <div
          className="
            absolute -bottom-0.5 -right-0.5 z-[2]
            px-1.5 py-px rounded-full
            bg-gray-700/85 text-white text-[9px] font-light leading-none
            border border-gray-600/60
            pointer-events-none
          "
        >
          {formatAge(Date.now() - head.lastActionAt)}
        </div>
      )}
    </div>
  );
}
