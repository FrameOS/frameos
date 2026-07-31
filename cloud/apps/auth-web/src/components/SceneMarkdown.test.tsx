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
    expect(link.getAttribute("rel")).toBe("noreferrer");
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
    expect(httpsLink.getAttribute("rel")).toBe("noreferrer");
  });

  it("does not interpret raw HTML", () => {
    const { container } = render(
      <SceneMarkdown description={'<script>alert("nope")</script>'} />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain('<script>alert("nope")</script>');
  });
});
