// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";
import { PublicShell } from "./PublicShell";

// The shells build absolute nav URLs from the deployment's origins.
vi.mock("../lib/env", () => ({
  getAccountBaseUrl: () => "https://cloud.example.net",
  getAccountUrl: (path?: string) => `https://cloud.example.net${path ?? "/account"}`,
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
