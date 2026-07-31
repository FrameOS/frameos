import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function SceneMarkdown({ description }: { description: string | null }) {
  if (!description) {
    return <p className="copy">No description.</p>;
  }

  return (
    <div className="markdown-description">
      <ReactMarkdown
        components={{
          a: ({ children, href, node, ...props }) => {
            void node;
            const external = href?.startsWith("https://") || href?.startsWith("http://");
            return (
              <a
                {...props}
                href={href}
                {...(external ? { rel: "noreferrer", target: "_blank" } : {})}
              >
                {children}
              </a>
            );
          },
        }}
        remarkPlugins={[remarkGfm]}
      >
        {description}
      </ReactMarkdown>
    </div>
  );
}
