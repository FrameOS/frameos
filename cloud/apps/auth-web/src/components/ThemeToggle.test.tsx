// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "./ThemeToggle";

function stubMatchMedia(prefersDark: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: prefersDark }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  document.cookie = "frameos_theme=; Path=/; Max-Age=0";
  document.documentElement.classList.remove("theme-dark");
  document.head.innerHTML = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ThemeToggle", () => {
  it("uses the stored theme over the system preference", () => {
    stubMatchMedia(false);
    window.localStorage.setItem("frameos-cloud-theme", "dark");

    render(<ThemeToggle />);

    expect(document.documentElement.classList.contains("theme-dark")).toBe(
      true,
    );
    expect(
      screen.getByRole("button", { name: "Use light theme" }),
    ).toBeDefined();
  });

  it("uses the shared cookie over origin-local storage", () => {
    stubMatchMedia(false);
    window.localStorage.setItem("frameos-cloud-theme", "light");
    document.cookie = "frameos_theme=dark; Path=/";

    render(<ThemeToggle />);

    expect(document.documentElement.classList.contains("theme-dark")).toBe(
      true,
    );
    expect(window.localStorage.getItem("frameos-cloud-theme")).toBe("dark");
  });

  it("falls back to the system preference when nothing is stored", () => {
    stubMatchMedia(true);

    render(<ThemeToggle />);

    expect(document.documentElement.classList.contains("theme-dark")).toBe(
      true,
    );
  });

  it("toggles the theme and persists the choice", () => {
    stubMatchMedia(false);

    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("button", { name: "Use dark theme" }));

    expect(document.documentElement.classList.contains("theme-dark")).toBe(
      true,
    );
    expect(window.localStorage.getItem("frameos-cloud-theme")).toBe("dark");
    expect(document.cookie).toContain("frameos_theme=dark");

    fireEvent.click(screen.getByRole("button", { name: "Use light theme" }));

    expect(document.documentElement.classList.contains("theme-dark")).toBe(
      false,
    );
    expect(window.localStorage.getItem("frameos-cloud-theme")).toBe("light");
    expect(document.cookie).toContain("frameos_theme=light");
  });

  it("picks up a cookie changed on another site when the tab regains focus", () => {
    stubMatchMedia(false);
    render(<ThemeToggle />);

    document.cookie = "frameos_theme=dark; Path=/";
    fireEvent.focus(window);

    expect(document.documentElement.classList.contains("theme-dark")).toBe(
      true,
    );
  });

  // The icon follows the browser chrome, not the page theme, and is owned by
  // exactly one <link> that ThemeToggle creates when the pre-paint script has
  // not — never a JSX placeholder, which React re-hoisted as a stale duplicate.
  // (jsdom runs on localhost, hence the -mono variants.)
  it("creates one favicon link and keeps it matched to the browser scheme", () => {
    stubMatchMedia(true);
    window.localStorage.setItem("frameos-cloud-theme", "light");

    render(<ThemeToggle />);

    const links = document.head.querySelectorAll("link[rel=icon]");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/logo-dark-mono.svg");

    fireEvent.click(screen.getByRole("button", { name: "Use dark theme" }));
    expect(document.head.querySelectorAll("link[rel=icon]")).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/logo-dark-mono.svg");
  });

  it("updates an existing favicon link instead of adding a second one", () => {
    stubMatchMedia(false);
    document.head.innerHTML =
      '<link data-frameos-favicon="" href="/logo-dark.svg" rel="icon" type="image/svg+xml">';

    render(<ThemeToggle />);

    const links = document.head.querySelectorAll("link[rel=icon]");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/logo-light-mono.svg");
  });
});
