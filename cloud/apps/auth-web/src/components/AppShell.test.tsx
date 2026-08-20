// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";
import { PublicShell } from "./PublicShell";

// The shells build absolute nav URLs from the deployment's origins.
vi.mock("../lib/env", () => ({
  getAccountBaseUrl: () => "https://cloud.example.net",
  getAccountUrl: (path?: string) =>
    `https://cloud.example.net${path ?? "/account"}`,
  getCloudBaseUrl: () => "https://cloud.example.net",
  getScenesBaseUrl: () => "https://scenes.example.net",
  // The shells render LegalFooter, which needs the cookie domain for the
  // "Cookie settings" button.
  getSessionCookieDomain: () => undefined,
}));

afterEach(() => {
  cleanup();
});

// `ph-no-capture` on <main> is what keeps frame names, other people's email
// addresses and private scene content out of PostHog autocapture. It is one
// word in a className, so it is exactly the kind of thing a later refactor
// drops without noticing.
describe("AppShell", () => {
  it("marks the page body as no-capture when asked", () => {
    const { container } = render(<AppShell noCapture>body</AppShell>);
    expect(container.querySelector("main")?.className).toContain(
      "ph-no-capture",
    );
  });

  it("leaves autocapture alone by default", () => {
    const { container } = render(<AppShell>body</AppShell>);
    expect(container.querySelector("main")?.className).not.toContain(
      "ph-no-capture",
    );
  });
});

describe("PublicShell", () => {
  it("marks the page body as no-capture when asked", () => {
    const { container } = render(
      <PublicShell noCapture signedIn={false}>
        body
      </PublicShell>,
    );
    expect(container.querySelector("main")?.className).toContain(
      "ph-no-capture",
    );
  });

  it("keeps the public store capturable by default", () => {
    const { container } = render(
      <PublicShell signedIn={false}>body</PublicShell>,
    );
    expect(container.querySelector("main")?.className).not.toContain(
      "ph-no-capture",
    );
  });
});

// The two shells draw one header: the wordmark sits inside the brand link
// on both (so it does not shift between scenes.* and cloud.*), the brand
// links to the workspace for anyone signed in, and Frames leads the nav.
function navLabels(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll(
      "nav[aria-label='Primary'] a, nav[aria-label='Primary'] button",
    ),
  ).map((node) => node.textContent?.trim());
}

function brand(container: HTMLElement) {
  const link = container.querySelector<HTMLAnchorElement>(
    ".frameos-account-header__brand",
  );
  return {
    href: link?.getAttribute("href"),
    name: link?.querySelector(".frameos-account-header__name")?.textContent,
  };
}

describe("the shared header", () => {
  it("reads FrameOS Cloud and leads to the workspace on the account pages", () => {
    const { container } = render(<AppShell title="Users">body</AppShell>);
    expect(brand(container)).toEqual({
      href: "https://cloud.example.net/frames",
      name: "FrameOS Cloud",
    });
    // A page title follows the wordmark instead of replacing it.
    expect(
      container.querySelector(".frameos-account-header__title")?.textContent,
    ).toBe("Users");
    expect(navLabels(container)).toEqual([
      "Frames",
      "Scenes",
      "Account",
      "Sign out",
    ]);
  });

  it("reads FrameOS Scenes with only Sign in for a signed-out store visitor", () => {
    const { container } = render(
      <PublicShell signedIn={false}>body</PublicShell>,
    );
    expect(brand(container)).toEqual({
      href: "https://scenes.example.net/",
      name: "FrameOS Scenes",
    });
    expect(navLabels(container)).toEqual(["Sign in"]);
  });

  it("shows the cloud header to a signed-in store visitor", () => {
    const { container } = render(<PublicShell signedIn>body</PublicShell>);
    expect(brand(container)).toEqual({
      href: "https://cloud.example.net/frames",
      name: "FrameOS Cloud",
    });
    expect(navLabels(container)).toEqual([
      "Frames",
      "Scenes",
      "Account",
      "Sign out",
    ]);
  });
});
