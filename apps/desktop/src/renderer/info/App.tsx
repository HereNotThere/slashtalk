import { useEffect, useState } from "react";
import { useAutoResize } from "../shared/useAutoResize";

// Sessions are hard-coded placeholders — mirrors the SwiftUI stub. Real data
// comes from a future GitHub activity pass.
const SESSIONS = [
  {
    title: "Simplifying the sign up flow",
    subtitle: "towns-app · feat/auth-cleanup",
    active: true,
  },
  { title: "Redesigning the home page", subtitle: "user/fei", active: false },
  {
    title: "Cleaning up the style guide",
    subtitle: "towns-app · feat/auth-cleanup",
    active: true,
  },
];

export function App(): JSX.Element {
  const [label, setLabel] = useState("—");
  useAutoResize();

  useEffect(() => {
    return window.chatheads.onInfoShow(({ label }) => setLabel(label));
  }, []);

  return (
    <>
      <div className="px-lg pt-lg pb-3.5">
        <div className="text-xl font-bold mb-2.5">{label}</div>
        <StatusRow color="#ff8c1a" icon="🔥">4 sessions running</StatusRow>
        <StatusRow color="#ffd84d" icon="☀️">San Francisco · 2:31 PM</StatusRow>
        <StatusRow color="#37c76a" icon="🎵">(Sittin&apos; on) the dock of the bay</StatusRow>
      </div>

      <div className="h-px bg-divider" />

      <div className="py-1.5">
        {SESSIONS.map((s) => (
          <div key={s.title} className="flex items-center px-lg py-sm gap-2.5">
            <div>
              <div className="text-[13px] font-semibold flex items-center gap-1.5">
                {s.title}{" "}
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    s.active ? "bg-success" : "bg-subtle/60"
                  }`}
                />
              </div>
              <div className="text-[11px] text-fg/60 mt-0.5">{s.subtitle}</div>
            </div>
            <div className="ml-auto text-fg/35 text-[11px] font-bold">›</div>
          </div>
        ))}
      </div>
    </>
  );
}

function StatusRow({
  color,
  icon,
  children,
}: {
  color: string;
  icon: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 text-[13px] leading-[1.4] text-fg/75">
      <span className="w-4 text-center" style={{ color }}>
        {icon}
      </span>
      <span>{children}</span>
    </div>
  );
}
