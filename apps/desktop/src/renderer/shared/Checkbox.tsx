export function Checkbox({ checked }: { checked: boolean }): JSX.Element {
  return (
    <span
      className={`
        w-[14px] h-[14px] rounded-[3px] inline-flex items-center justify-center flex-shrink-0
        ${checked ? "bg-fg text-bg" : "bg-transparent border border-fg/40"}
      `}
    >
      {checked ? (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path
            d="M1.5 5 L4 7.5 L8.5 2.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </span>
  );
}
