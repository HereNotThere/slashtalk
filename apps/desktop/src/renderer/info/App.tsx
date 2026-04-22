import { useEffect, useState } from "react";

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

  useEffect(() => {
    return window.chatheads.onInfoShow(({ label }) => setLabel(label));
  }, []);

  return (
    <>
      <div className="header">
        <div className="label">{label}</div>
        <div className="status-row">
          <span className="icon" style={{ color: "#ff8c1a" }}>
            🔥
          </span>
          <span>4 sessions running</span>
        </div>
        <div className="status-row">
          <span className="icon" style={{ color: "#ffd84d" }}>
            ☀️
          </span>
          <span>San Francisco · 2:31 PM</span>
        </div>
        <div className="status-row">
          <span className="icon" style={{ color: "#37c76a" }}>
            🎵
          </span>
          <span>(Sittin&apos; on) the dock of the bay</span>
        </div>
      </div>

      <div className="divider" />

      <div className="sessions">
        {SESSIONS.map((s) => (
          <div key={s.title} className="session-row">
            <div>
              <div className="session-title">
                {s.title}{" "}
                <span className={`dot ${s.active ? "active" : "inactive"}`} />
              </div>
              <div className="subtitle">{s.subtitle}</div>
            </div>
            <div className="chev">›</div>
          </div>
        ))}
      </div>
    </>
  );
}
