// App- and scene-supplied markdown (field hints and markdown rows in app
// configs, AI chat output) renders through frontend/src/components/Markdown.
// The 2026-09 review found links opened with target=_blank and no rel, and
// an image in an app's markdown loaded from any host the moment the node
// rendered — a tracking pixel. Links now carry rel="noopener noreferrer" and
// images render as a link, never an <img>.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../../../../../../frontend/src/components/Markdown";

describe("<Markdown>", () => {
  it("opens links in a new tab without an opener or a referrer", () => {
    const html = renderToStaticMarkup(<Markdown value="See [the docs](https://example.com/docs)." />);
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("renders an image as a link instead of loading it", () => {
    const html = renderToStaticMarkup(<Markdown value="![pixel](https://tracker.example/p.gif)" />);
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://tracker.example/p.gif"');
    expect(html).toContain("Image: pixel");
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("drops a javascript: image source and keeps the alt text", () => {
    const html = renderToStaticMarkup(<Markdown value="![x](javascript:alert(1))" />);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("Image: x");
  });
});
