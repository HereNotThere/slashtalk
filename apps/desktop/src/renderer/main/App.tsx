import { useHeads } from '../shared/useHeads';
import { SlashtalkSection } from './SlashtalkSection';
import { InstallSection } from './InstallSection';
import type { ChatHead } from '../../shared/types';

// Hides the slashtalk backend sign-in panel. Chatheads presence is independent
// of the slashtalk service, so this defaults off for the demo. Flip to `true`
// (or set VITE_SHOW_SLASHTALK=true) to show it.
const SHOW_SLASHTALK = import.meta.env.VITE_SHOW_SLASHTALK === 'true';

export function App(): JSX.Element {
  const heads = useHeads();

  return (
    <>
      <h1 className="m-0 mb-1 text-[28px]">Chat Heads</h1>
      <div className="text-subtle mb-5">Floating bubbles that stay on top of everything.</div>

      <InstallSection />

      {SHOW_SLASHTALK && <SlashtalkSection />}

      <SectionHeading>Active ({heads.length})</SectionHeading>
      <div className="flex flex-col gap-1.5">
        {heads.map((h) => (
          <ActiveRow key={h.id} head={h} />
        ))}
      </div>
    </>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <h2 className="text-[14px] text-muted mt-5 mb-2 uppercase tracking-[0.5px]">
      {children}
    </h2>
  );
}

function ActiveRow({ head }: { head: ChatHead }): JSX.Element {
  return (
    <div className="flex items-center gap-2.5 px-2.5 py-1.5 bg-card rounded-md">
      <span
        className="w-5 h-5 rounded-full inline-flex items-center justify-center text-[14px] overflow-hidden"
        style={{ background: head.tint }}
      >
        {head.avatar.type === 'emoji' ? (
          head.avatar.value
        ) : (
          <img src={head.avatar.value} alt="" className="w-full h-full rounded-full object-cover" />
        )}
      </span>
      <span>{head.label}</span>
    </div>
  );
}
