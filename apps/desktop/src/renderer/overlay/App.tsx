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
      const target = e.target instanceof Element ? e.target.closest('.bubble') : null;
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
    <div ref={stackRef} className="stack">
      {heads.map((h) => (
        <Bubble key={h.id} head={h} />
      ))}
    </div>
  );
}

function Bubble({ head }: { head: ChatHead }): JSX.Element {
  return (
    <div
      className="bubble"
      title={head.label}
      onContextMenu={(e) => {
        e.preventDefault();
        void window.chatheads.close(head.id);
      }}
    >
      <div className="tint" style={{ background: head.tint }} />
      {head.avatar.type === 'emoji' ? (
        <span className="emoji">{head.avatar.value}</span>
      ) : (
        <img src={head.avatar.value} alt="" />
      )}
    </div>
  );
}
