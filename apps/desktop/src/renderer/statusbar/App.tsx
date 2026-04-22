import type { ChatHead } from '../../shared/types';
import { PRESETS } from '../shared/presets';
import { useHeads } from '../shared/useHeads';

export function App(): JSX.Element {
  const heads = useHeads();

  return (
    <div className="card">
      <div className="title">💬 Chat Heads</div>
      <div className="divider" />

      <div className="section-label">Spawn</div>
      <div className="presets">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            className="preset"
            onClick={() => window.chatheads.spawn(p)}
          >
            <span className="e">
              {p.avatar.type === 'emoji' ? p.avatar.value : null}
            </span>
            <span>{p.label}</span>
          </button>
        ))}
      </div>

      <div className="divider" />

      <div className="active">
        <div className="section-label">Active ({heads.length})</div>
        <div className="list">
          {heads.map((h) => (
            <ActiveRow key={h.id} head={h} />
          ))}
        </div>
      </div>

      <div className="divider" />

      <div className="footer">
        <button onClick={() => window.chatheads.openMain()}>Open window</button>
        <button
          onClick={() => window.chatheads.closeAll()}
          disabled={heads.length === 0}
        >
          Close all
        </button>
        <button onClick={() => window.chatheads.quit()}>Quit</button>
      </div>
    </div>
  );
}

function ActiveRow({ head }: { head: ChatHead }): JSX.Element {
  return (
    <div className="row">
      <span className="dot" style={{ background: head.tint }}>
        {head.avatar.type === 'emoji' ? head.avatar.value : <img src={head.avatar.value} alt="" />}
      </span>
      <span className="name">{head.label}</span>
      <button className="x" onClick={() => window.chatheads.close(head.id)}>✕</button>
    </div>
  );
}
