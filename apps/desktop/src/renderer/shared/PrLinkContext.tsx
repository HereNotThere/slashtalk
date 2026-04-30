import { createContext, useContext, useMemo, type ReactNode } from "react";

interface PrInfo {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
}

const PrLinkContext = createContext<Map<string, PrInfo> | null>(null);

/** Scopes a PR url→state map to a subtree so the shared `MarkdownLink`
 *  component can render GitHub PR links as `PrIcon` + colored `#N` instead
 *  of plain underlined links. The standup blurb and project pulse both
 *  emit PR references; wrap their `<Markdown>` in this provider with the
 *  PR list already on hand to enrich the rendering without re-fetching. */
export function PrLinkProvider({
  prs,
  children,
}: {
  prs: ReadonlyArray<PrInfo>;
  children: ReactNode;
}): JSX.Element {
  const prByUrl = useMemo(() => {
    const m = new Map<string, PrInfo>();
    for (const p of prs) m.set(p.url, p);
    return m;
  }, [prs]);
  return <PrLinkContext.Provider value={prByUrl}>{children}</PrLinkContext.Provider>;
}

export function usePrInfo(href: string | undefined): PrInfo | null {
  const map = useContext(PrLinkContext);
  if (!href || !map) return null;
  return map.get(href) ?? null;
}
