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
});
