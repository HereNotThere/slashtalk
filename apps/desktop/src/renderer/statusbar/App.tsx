import type { ChatHead } from '../../shared/types';
import { useHeads } from '../shared/useHeads';
import { useAutoResize } from '../shared/useAutoResize';

export function App(): JSX.Element {
  const heads = useHeads();
  useAutoResize();

  return (
    <div className="box-border p-lg flex flex-col gap-md">
      <div className="flex flex-col gap-1.5">
        <SectionLabel>Active ({heads.length})</SectionLabel>
        <div className="flex flex-col gap-1">
          {heads.map((h) => (
            <ActiveRow key={h.id} head={h} />
          ))}
        </div>
      </div>

      <Divider />

      <div className="flex gap-2">
        <FooterButton onClick={() => window.chatheads.openMain()}>Open</FooterButton>
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
