import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import type { CarouselHead } from "../lib/recency";
import { Avatar } from "./Avatar";

interface HeadsCarouselProps {
  heads: CarouselHead[];
  selectedLogin: string | null;
  onSelect: (login: string) => void;
  onSearch: () => void;
}

export function HeadsCarousel({
  heads,
  selectedLogin,
  onSelect,
  onSearch,
}: HeadsCarouselProps): JSX.Element {
  return (
    <div className="border-t border-divider bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/80">
      <div className="no-scrollbar flex items-center gap-3 overflow-x-auto px-3 py-3">
        <button
          type="button"
          onClick={onSearch}
          aria-label="Search teammates"
          className="flex w-14 flex-none flex-col items-center gap-1"
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-full ring-1 ring-divider">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-alt text-fg transition-colors hover:bg-surface-alt-hover">
              <MagnifyingGlassIcon className="h-5 w-5" />
            </span>
          </span>
          <span className="text-[10px] text-subtle">Search</span>
        </button>

        {heads.map((h) => {
          const selected = h.login === selectedLogin;
          return (
            <button
              key={h.login}
              type="button"
              onClick={() => onSelect(h.login)}
              className="flex w-14 flex-none flex-col items-center gap-1"
            >
              <span
                className={[
                  "relative flex h-12 w-12 items-center justify-center rounded-full",
                  selected
                    ? "ring-2 ring-primary ring-offset-2 ring-offset-surface"
                    : h.live
                      ? "ring-2 ring-success ring-offset-2 ring-offset-surface"
                      : "ring-1 ring-divider",
                ].join(" ")}
              >
                <Avatar src={h.avatarUrl} login={h.login} size={44} />
                {h.live ? (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-success/60"
                    style={{ animation: "live-ring 1.6s ease-in-out infinite" }}
                  />
                ) : null}
              </span>
              <span className="max-w-[56px] truncate text-[10px] text-subtle">
                {h.isSelf ? "you" : h.login}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
