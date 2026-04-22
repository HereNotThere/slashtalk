import { useEffect, useRef } from 'react';
import type { ChatHead } from '../../shared/types';
import { useHeads } from '../shared/useHeads';

const DRAG_THRESHOLD = 4;

// Click-vs-drag discrimination + toggle-info, mirrors DraggableHostingView.swift.
// Below threshold on mouseUp = click (toggleInfo); above = start IPC-driven drag.
export function App(): JSX.Element {
  const heads = useHeads();
  const stackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let downPos: { x: number; y: number } | null = null;
    let downBubbleIndex: number | null = null;
    let dragging = false;

    const onDown = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      downPos = { x: e.screenX, y: e.screenY };
      const target = e.target instanceof Element ? e.target.closest('[data-bubble]') : null;
      downBubbleIndex = target && stackRef.current
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
      else if (downBubbleIndex !== null) void window.chatheads.toggleInfo(downBubbleIndex);
      downPos = null;
      downBubbleIndex = null;
      dragging = false;
    };

    const onBlur = (): void => {
      if (dragging) void window.chatheads.dragEnd();
      downPos = null;
      downBubbleIndex = null;
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
    </div>
  );
}

function Bubble({ head }: { head: ChatHead }): JSX.Element {
  return (
    <div
      data-bubble
      title={head.label}
      className="
        relative w-14 h-14 rounded-full cursor-pointer
        flex items-center justify-center text-[28px]
        bg-bubble
        backdrop-blur-[18px] backdrop-saturate-[1.4]
        outline outline-1 -outline-offset-1 outline-bubble-outline
        shadow-[0_2px_3px_rgba(0,0,0,0.15)]
        transition-transform duration-[180ms] ease-[cubic-bezier(0.2,0.9,0.3,1.2)]
        hover:scale-105
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
    </div>
  );
}
