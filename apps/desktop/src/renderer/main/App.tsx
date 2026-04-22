import { PRESETS } from '../shared/presets';
import { useHeads } from '../shared/useHeads';
import { GitHubSection } from './GitHubSection';
import type { ChatHead } from '../../shared/types';

export function App(): JSX.Element {
  const heads = useHeads();

  return (
    <>
      <h1>Chat Heads</h1>
      <div className="subtitle">Floating bubbles that stay on top of everything.</div>

      <h2>Presets</h2>
      <div className="presets">
        {PRESETS.map((p) => (
          <button key={p.label} onClick={() => window.chatheads.spawn(p)}>
            {p.avatar.type === 'emoji' ? p.avatar.value : null} {p.label}
          </button>
        ))}
      </div>

      <GitHubSection />

      <h2>Active ({heads.length})</h2>
      <div className="active-list">
        {heads.map((h) => (
          <ActiveRow key={h.id} head={h} />
        ))}
      </div>
    </>
  );
}

function ActiveRow({ head }: { head: ChatHead }): JSX.Element {
  return (
    <div className="active-row">
      <span className="dot" style={{ background: head.tint }}>
        {head.avatar.type === 'emoji' ? head.avatar.value : <img src={head.avatar.value} alt="" />}
      </span>
      <span>{head.label}</span>
      <button className="x" onClick={() => window.chatheads.close(head.id)}>✕</button>
    </div>
  );
}
