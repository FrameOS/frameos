// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SceneMarkdown } from "./SceneMarkdown";

afterEach(cleanup);

describe("SceneMarkdown", () => {
  it("renders basic Markdown and safe external links", () => {
    render(
      <SceneMarkdown description="A **bird** with [source](https://example.com)." />,
    );

    expect(screen.getByText("bird").tagName).toBe("STRONG");
    const link = screen.getByRole("link", { name: "source" });
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("turns bare HTTP URLs into links", () => {
    render(
      <SceneMarkdown description="Sources: http://example.com and https://frameos.net/docs." />,
    );

    const httpLink = screen.getByRole("link", { name: "http://example.com" });
    expect(httpLink.getAttribute("href")).toBe("http://example.com");
    expect(httpLink.getAttribute("target")).toBe("_blank");
    expect(httpLink.getAttribute("node")).toBeNull();

    const httpsLink = screen.getByRole("link", { name: "https://frameos.net/docs" });
    expect(httpsLink.getAttribute("href")).toBe("https://frameos.net/docs");
    expect(httpsLink.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("fetches no image a description names: it is a link to open by choice", () => {
    const { container } = render(
      <SceneMarkdown description={"Before ![a bird](https://tracker.example/pixel.png?who=you) and ![](https://tracker.example/2.png) after."} />,
    );

    expect(container.querySelector("img")).toBeNull();
    const named = screen.getByRole("link", { name: "Image: a bird" });
    expect(named.getAttribute("href")).toBe("https://tracker.example/pixel.png?who=you");
    expect(named.getAttribute("target")).toBe("_blank");
    expect(named.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByRole("link", { name: "Image" }).getAttribute("href")).toBe("https://tracker.example/2.png");
    // An address the URL filter empties (no javascript:, no data:) is its label alone.
    cleanup();
    const unsafe = render(<SceneMarkdown description={"![x](javascript:alert(1))"} />);
    expect(unsafe.container.querySelector("img")).toBeNull();
    expect(unsafe.container.querySelector("a")).toBeNull();
    expect(unsafe.container.textContent).toContain("Image: x");
  });

  it("does not interpret raw HTML", () => {
    const { container } = render(
      <SceneMarkdown description={'<script>alert("nope")</script>'} />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain('<script>alert("nope")</script>');
  });
});
