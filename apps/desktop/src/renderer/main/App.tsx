import { useHeads } from "../shared/useHeads";
import { SlashtalkSection } from "./SlashtalkSection";
import { AgentsSection } from "./AgentsSection";
import type { ChatHead } from "../../shared/types";

export function App(): JSX.Element {
  const heads = useHeads();

  return (
    <>
      <header className="flex items-center gap-3 mb-6">
        <SlashtalkLogo size={44} />
        <div className="flex-1 min-w-0">
          <h1 className="m-0 text-[24px] font-bold leading-tight tracking-tight">
            Slashtalk
          </h1>
          <div className="text-subtle text-[12.5px] mt-0.5">
            Floating bubbles that stay on top of everything.
          </div>
        </div>
      </header>

      <SlashtalkSection />
      <AgentsSection />

      <SectionHeading>Active ({heads.length})</SectionHeading>
      <div className="flex flex-col gap-1.5">
        {heads.map((h) => (
          <ActiveRow key={h.id} head={h} />
        ))}
      </div>
    </>
  );
}

function SectionHeading({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  return (
    <h2 className="text-[11px] font-semibold text-subtle mt-6 mb-2 uppercase tracking-[0.08em]">
      {children}
    </h2>
  );
}

function ActiveRow({ head }: { head: ChatHead }): JSX.Element {
  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-card rounded-xl">
      <span
        className="w-6 h-6 rounded-full inline-flex items-center justify-center text-[14px] overflow-hidden shrink-0"
        style={{ background: head.tint }}
      >
        {head.avatar.type === "emoji" ? (
          head.avatar.value
        ) : (
          <img
            src={head.avatar.value}
            alt=""
            className="w-full h-full rounded-full object-cover"
          />
        )}
      </span>
      <span className="text-[13px]">{head.label}</span>
      {head.kind === "agent" && (
        <span className="ml-auto text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-border text-muted">
          Agent
        </span>
      )}
    </div>
  );
}

function SlashtalkLogo({ size = 44 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className="shrink-0"
    >
      <rect width="48" height="48" rx="12" fill="url(#slashtalkLogoGradient)" />
      <circle cx="13" cy="11" r="5" fill="white" />
      <circle cx="13" cy="24" r="5" fill="white" />
      <circle cx="13" cy="37" r="5" fill="white" />
      <defs>
        <linearGradient
          id="slashtalkLogoGradient"
          x1="24"
          y1="0"
          x2="24"
          y2="48"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#2ECF81" />
          <stop offset="1" stopColor="#0BB764" />
        </linearGradient>
      </defs>
    </svg>
  );
}
