import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ children }: { children: string }): JSX.Element {
  return (
    <div className="text-pretty leading-snug [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_code]:rounded [&_code]:bg-code [&_code]:px-1 [&_code]:py-px [&_code]:text-[0.92em] [&_code]:font-mono [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Hard-validate link schemes — no javascript:/data: URLs from
          // model-generated standup text. Safe schemes only; relative paths
          // (no scheme) also pass.
          a({ href, children: linkChildren, ...props }) {
            const safe = isSafeUrl(href);
            if (!safe) return <span>{linkChildren}</span>;
            return (
              <a href={href} target="_blank" rel="noreferrer" {...props}>
                {linkChildren}
              </a>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function isSafeUrl(href: string | undefined): boolean {
  if (!href) return false;
  if (href.startsWith("/") || href.startsWith("#")) return true;
  try {
    const u = new URL(href, window.location.origin);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:";
  } catch {
    return false;
  }
}
