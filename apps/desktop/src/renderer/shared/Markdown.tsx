import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export const MARKDOWN_CLASSES =
  "prose prose-invert text-fg/90 break-words text-sm leading-relaxed " +
  "[&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-0.5 " +
  "[&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-code [&_code]:text-[0.9em] " +
  "[&_pre]:bg-code [&_pre]:p-3 [&_pre]:rounded-md [&_pre]:overflow-auto " +
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 " +
  "[&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold " +
  "[&_a]:text-link [&_a]:underline hover:[&_a]:text-link-hover";

export function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}): JSX.Element {
  return (
    <div className={className ?? MARKDOWN_CLASSES}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
