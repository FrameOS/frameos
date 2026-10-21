// App- and scene-supplied markdown (field hints and markdown rows in app
// configs, AI chat output) renders through frontend/src/components/Markdown.
// The 2026-09 review found links opened with target=_blank and no rel, and
// an image in an app's markdown loaded from any host the moment the node
// rendered — a tracking pixel. Links now carry rel="noopener noreferrer" and
// images render as a link, never an <img>.
//
// The AI chat's frameos:// links to frames and scenes (utils/chatLinks.ts)
// are the one kind that stays in the app: the route, in this tab.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../../../../../../frontend/src/components/Markdown";
import { chatLinkRoute } from "../../../../../../frontend/src/utils/chatLinks";

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

describe("<Markdown inAppRoute>", () => {
  const render = (value: string) => renderToStaticMarkup(<Markdown inAppRoute={chatLinkRoute} value={value} />);

  it("links a frame and a scene to their pages in this tab", () => {
    const html = render("[Kitchen](frameos://frame/12) shows [Clock](frameos://frame/12/scene/clock-1).");
    expect(html).toContain('<a href="/frames/12" class="text-blue-400 hover:underline">Kitchen</a>');
    expect(html).toContain('href="/frames/12?drawer=scene&amp;sceneId=clock-1"');
    expect(html).not.toContain("target=");
    expect(html).not.toContain("frameos://");
  });

  it("keeps other links in a new tab and unsafe ones as text", () => {
    const html = render("[docs](https://example.com) [x](javascript:alert(1)) [y](frameos://frame/12/logs)");
    expect(html).toContain('href="https://example.com" target="_blank" rel="noopener noreferrer"');
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<span>x</span>");
    expect(html).toContain("<span>y</span>");
  });

  it("leaves frameos:// links alone where nobody resolves them", () => {
    const html = renderToStaticMarkup(<Markdown value="[Kitchen](frameos://frame/12)" />);
    expect(html).toContain("<span>Kitchen</span>");
    expect(html).not.toContain("<a");
  });
});
