import type { ReactNode } from "react";

export function SectionLabel({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="text-xs font-semibold tracking-wider uppercase text-subtle">{children}</span>
  );
}
