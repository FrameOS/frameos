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
                {...(external ? { rel: "noopener noreferrer", target: "_blank" } : {})}
              >
                {children}
              </a>
            );
          },
          // A description is its author's text on everyone's page: an <img>
          // would be fetched from wherever it says the moment the listing is
          // drawn (who looked, from where). An image is a link to open by
          // choice; a scene's pictures are its cover and gallery.
          img: ({ alt, src }) => {
            const label = alt ? `Image: ${alt}` : "Image";
            return typeof src === "string" && src ? (
              <a href={src} rel="noopener noreferrer" target="_blank">
                {label}
              </a>
            ) : (
              <span>{label}</span>
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
