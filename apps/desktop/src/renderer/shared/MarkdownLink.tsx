// react-markdown components map. Kept as a const object (not a component
// module) so consumers can spread it into other component maps.
// Without this, clicked anchors hijack the host BrowserWindow's location.
import type { ReactNode } from "react";

export const MARKDOWN_LINK_COMPONENT = {
  a: ({ href, children, ...rest }: { href?: string; children?: ReactNode }) => (
    <a
      {...rest}
      href={href}
      onClick={(e) => {
        if (!href) return;
        e.preventDefault();
        void window.chatheads.openExternal(href);
      }}
    >
      {children}
    </a>
  ),
};
