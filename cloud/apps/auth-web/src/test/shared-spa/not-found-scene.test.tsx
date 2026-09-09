// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NotFound, NotFoundContent } from "../../../../../../frontend/src/scenes/NotFound";

// Both scene tables (frontend/src/scenes/scenes.tsx and
// cloud-frontend/src/scenes/scenes.tsx) used to map `error404` to a bare
// `<div>404</div>`. The shared page names the path that failed and offers a
// way back; under the cloud's /frames mount the way back is the SPA's own
// frames URL.

function withAppConfig<T>(config: Record<string, unknown>, run: () => T): T {
  (window as unknown as { FRAMEOS_APP_CONFIG?: unknown }).FRAMEOS_APP_CONFIG = config;
  try {
    return run();
  } finally {
    delete (window as unknown as { FRAMEOS_APP_CONFIG?: unknown }).FRAMEOS_APP_CONFIG;
  }
}

afterEach(() => {
  delete (window as unknown as { FRAMEOS_APP_CONFIG?: unknown }).FRAMEOS_APP_CONFIG;
});

describe("<NotFound>", () => {
  it("says which path failed and links back to the frames list", () => {
    const html = renderToStaticMarkup(<NotFound path="/frames/7/nonsense" />);
    expect(html).toContain("Page not found");
    expect(html).toContain("/frames/7/nonsense");
    expect(html).toContain("Back to your frames");
    // Self-hosted, the frames list is the SPA's root.
    expect(html).toMatch(/<a [^>]*href="\/"/);
    expect(html).not.toBe("<div>404</div>");
  });

  it("links to the cloud's /frames mount under the cloud SPA config", () => {
    const html = withAppConfig({ cloudMode: true, route_base_path: "/frames", ingress_path: "" }, () =>
      renderToStaticMarkup(<NotFound path="/frames/x/terminal" />),
    );
    expect(html).toMatch(/<a [^>]*href="\/frames"/);
  });

  it("takes an explanation and a way out of its own for a tool the frame lacks", () => {
    const html = renderToStaticMarkup(
      <NotFoundContent
        title="Terminal is not available for this frame"
        message="This frame does not have a shell."
        link={{ href: "/frames/7", label: "Back to the frame" }}
      />,
    );
    expect(html).toContain("Terminal is not available for this frame");
    expect(html).toContain("This frame does not have a shell.");
    expect(html).toMatch(/<a [^>]*href="\/frames\/7"[^>]*>Back to the frame<\/a>/);
    expect(html).not.toContain("There is nothing at");
  });
});
