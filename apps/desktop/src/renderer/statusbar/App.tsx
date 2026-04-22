import type { ChatHead } from '../../shared/types';
import { PRESETS } from '../shared/presets';
import { useHeads } from '../shared/useHeads';

export function App(): JSX.Element {
  const heads = useHeads();

  return (
    <div className="box-border h-full p-lg flex flex-col gap-md">
      <div className="flex items-center gap-2 font-bold text-sm">💬 Chat Heads</div>
      <Divider />

      <SectionLabel>Spawn</SectionLabel>
      <div className="grid grid-cols-2 gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            onClick={() => window.chatheads.spawn(p)}
            className="
              flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer
              text-fg bg-surface border-none [font:inherit] text-left
              hover:bg-surface-hover
            "
          >
            <span className="text-base">
              {p.avatar.type === 'emoji' ? p.avatar.value : null}
            </span>
            <span>{p.label}</span>
          </button>
        ))}
      </div>

      <Divider />

      <div className="flex-1 min-h-0 flex flex-col gap-1.5">
        <SectionLabel>Active ({heads.length})</SectionLabel>
        <div className="overflow-y-auto flex flex-col gap-1">
          {heads.map((h) => (
            <ActiveRow key={h.id} head={h} />
          ))}
        </div>
      </div>

      <Divider />

      <div className="flex gap-2">
        <FooterButton onClick={() => window.chatheads.openMain()}>Open window</FooterButton>
        <FooterButton
          onClick={() => window.chatheads.closeAll()}
          disabled={heads.length === 0}
        >
          Close all
        </FooterButton>
        <FooterButton onClick={() => window.chatheads.quit()}>Quit</FooterButton>
      </div>
    </div>
  );
}

function ActiveRow({ head }: { head: ChatHead }): JSX.Element {
  return (
    <div className="flex items-center gap-2 px-1.5 py-1">
      <span
        className="w-5 h-5 rounded-full inline-flex items-center justify-center text-[13px] overflow-hidden"
        style={{ background: head.tint }}
      >
        {head.avatar.type === 'emoji' ? (
          head.avatar.value
        ) : (
          <img src={head.avatar.value} alt="" className="w-full h-full rounded-full object-cover" />
        )}
      </span>
      <span className="flex-1 text-[13px]">{head.label}</span>
      <button
        onClick={() => window.chatheads.close(head.id)}
        className="bg-transparent border-none text-fg/50 cursor-pointer text-[13px] hover:text-fg"
      >
        ✕
      </button>
    </div>
  );
}

function Divider(): JSX.Element {
  return <div className="h-px bg-divider" />;
}

function SectionLabel({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="text-[11px] text-fg/55 uppercase tracking-[0.3px]">{children}</div>
  );
}

function FooterButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="
        flex-1 px-2.5 py-1.5 rounded-md
        bg-surface-strong border-none text-fg cursor-pointer [font:inherit]
        hover:bg-surface-strong-hover
        disabled:opacity-[0.35] disabled:cursor-default
      "
    >
      {children}
    </button>
  );
}
