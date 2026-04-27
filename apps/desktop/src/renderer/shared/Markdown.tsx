import { Fragment } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const REMARK_PLUGINS = [remarkGfm];

const MARKDOWN_CLASSES =
  "prose prose-invert text-fg/90 break-words text-base leading-relaxed " +
  "[&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-0.5 " +
  "[&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-code [&_code]:text-[0.9em] " +
  "[&_pre]:bg-code [&_pre]:p-3 [&_pre]:rounded-md [&_pre]:overflow-auto " +
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 " +
  "[&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold " +
  "[&_a]:text-primary [&_a]:underline hover:[&_a]:text-primary-hover " +
  "[&_strong]:font-semibold [&_strong]:text-fg";

const INLINE_COMPONENTS = { p: Fragment };

export function Markdown({
  children,
  className,
  inline = false,
}: {
  children: string;
  className?: string;
  inline?: boolean;
}): JSX.Element {
  const merged = className ? `${MARKDOWN_CLASSES} ${className}` : MARKDOWN_CLASSES;
  const markdown = (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      components={inline ? INLINE_COMPONENTS : undefined}
    >
      {children}
    </ReactMarkdown>
  );
  return inline ? (
    <span className={merged}>{markdown}</span>
  ) : (
    <div className={merged}>{markdown}</div>
  );
}
