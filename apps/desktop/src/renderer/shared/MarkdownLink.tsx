// react-markdown components map. Kept as a const object (not a component
// module) so consumers can spread it into other component maps.
// Without this, clicked anchors hijack the host BrowserWindow's location.
import type { MouseEvent, ReactNode } from "react";
import { PrIcon } from "./icons";
import { PR_STATE_COLOR, PR_STATE_LABEL } from "./pr-state";
import { usePrInfo } from "./PrLinkContext";

function MarkdownAnchor({
  href,
  children,
  ...rest
}: {
  href?: string;
  children?: ReactNode;
}): JSX.Element {
  const pr = usePrInfo(href);
  const open = (e: MouseEvent<HTMLAnchorElement>): void => {
    if (!href) return;
    e.preventDefault();
    void window.chatheads.openExternal(href);
  };
  if (pr) {
    // `!no-underline` beats the parent `[&_a]:underline` cascade in MARKDOWN_CLASSES.
    // PR links read as iconified state badges, not anchors — underline would
    // dominate visually next to the colored icon.
    return (
      <a
        href={href}
        onClick={open}
        title={PR_STATE_LABEL[pr.state]}
        className="!no-underline inline-flex items-center gap-0.5 align-text-bottom hover:opacity-80"
      >
        <PrIcon state={pr.state} className={`w-3.5 h-3.5 ${PR_STATE_COLOR[pr.state]}`} />
        <span className={`font-medium ${PR_STATE_COLOR[pr.state]}`}>#{pr.number}</span>
      </a>
    );
  }
  return (
    <a {...rest} href={href} onClick={open}>
      {children}
    </a>
  );
}

export const MARKDOWN_LINK_COMPONENT = { a: MarkdownAnchor };
