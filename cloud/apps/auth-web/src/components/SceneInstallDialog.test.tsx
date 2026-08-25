// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SceneInstallDialog, type SceneInstallDialogProps } from "./SceneInstallDialog";

const fetchMock = vi.fn<typeof fetch>();

vi.mock("next/navigation", () => ({
  usePathname: () => "/s/clock",
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

vi.mock("posthog-js", () => ({
  default: { capture: vi.fn() },
}));

const props: SceneInstallDialogProps = {
  framesUrl: "https://cloud.frameos.net/frames/",
  installVersion: null,
  installableFrames: [{ connected: true, id: "f1", name: "Kitchen", status: "active" }],
  isPrivate: false,
  loginUrl: "https://cloud.frameos.net/login",
  onClose: vi.fn(),
  pageUrl: "https://scenes.frameos.net/s/clock?version=1&share=tok",
  returnTo: "/s/clock?share=tok#scene-editor-info",
  sceneId: "scene-1",
  sceneName: "Clock",
  signedIn: true,
  signupUrl: "https://cloud.frameos.net/signup",
};

function dialog() {
  return screen.getByRole("dialog", { name: "Install Clock" });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SceneInstallDialog", () => {
  it("offers a signed-in visitor their frames and the self-hosted link, pinning the version", () => {
    fetchMock.mockResolvedValueOnce(Response.json({ connected: true }));
    render(<SceneInstallDialog {...props} installVersion={1} isPrivate />);
    const box = dialog();
    expect(within(box).getByRole("heading", { name: "Install on a frame" })).toBeTruthy();
    expect(within(box).getByRole("heading", { name: "Install on a self-hosted FrameOS" })).toBeTruthy();
    expect((within(box).getByRole("textbox", { name: "URL to copy" }) as HTMLInputElement).value).toBe(
      "https://scenes.frameos.net/s/clock?version=1&share=tok",
    );
    expect(within(box).getByText(/carries a sharing secret/)).toBeTruthy();
    expect(within(box).queryByRole("link", { name: "Sign in" })).toBeNull();

    fireEvent.click(within(box).getByRole("button", { name: "Install" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/frames/f1/scenes/add",
      expect.objectContaining({ body: JSON.stringify({ scene_id: "scene-1", scene_version: 1 }) }),
    );
  });

  it("invites a signed-out visitor to sign in or join, coming back to this page", () => {
    render(<SceneInstallDialog {...props} installableFrames={null} signedIn={false} />);
    const box = dialog();
    expect(within(box).getByRole("heading", { name: "Install on a frame" })).toBeTruthy();
    expect(within(box).getByText(/one-click installs/)).toBeTruthy();
    expect(within(box).getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(
      "https://cloud.frameos.net/login?return_to=%2Fs%2Fclock%3Fshare%3Dtok%23scene-editor-info",
    );
    expect(within(box).getByRole("link", { name: "Create an account" }).getAttribute("href")).toBe(
      "https://cloud.frameos.net/signup",
    );
    expect(within(box).queryByRole("button", { name: "Install" })).toBeNull();
    // The self-hosted route is there for everyone; no secret to explain on a public scene.
    expect(within(box).getByRole("textbox", { name: "URL to copy" })).toBeTruthy();
    expect(within(box).queryByText(/sharing secret/)).toBeNull();
  });

  it("leaves out the cloud section for a signed-in visitor it is not on offer to (a pulled scene)", () => {
    render(<SceneInstallDialog {...props} installableFrames={null} />);
    expect(within(dialog()).queryByRole("heading", { name: "Install on a frame" })).toBeNull();
    expect(within(dialog()).getByRole("heading", { name: "Install on a self-hosted FrameOS" })).toBeTruthy();
  });

  it("closes on its ×, on the backdrop and on Esc, but not on a click inside", () => {
    const onClose = vi.fn();
    render(<SceneInstallDialog {...props} onClose={onClose} />);
    fireEvent.click(screen.getByRole("heading", { name: "Install Clock" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(dialog());
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
