import type { CSSProperties } from "react";

/** Per-character shimmer animation used for "loading" placeholders inside
 *  the info card (e.g. "Fetching…", "working now…"). Each character runs the
 *  same `shimmer-char` keyframe with a small per-index delay so the wave
 *  visibly moves left-to-right. The keyframe lives in `tailwind.css`. */
export function ShimmerText({ text }: { text: string }): JSX.Element {
  const duration = 1.6;
  const step = 0.08;
  return (
    <span aria-label={text}>
      {Array.from(text).map((ch, i) => {
        const style: CSSProperties = {
          animation: `shimmer-char ${duration}s ease-in-out infinite`,
          animationDelay: `${i * step}s`,
          display: "inline-block",
          whiteSpace: "pre",
        };
        return (
          <span key={i} style={style} aria-hidden>
            {ch}
          </span>
        );
      })}
    </span>
  );
}
