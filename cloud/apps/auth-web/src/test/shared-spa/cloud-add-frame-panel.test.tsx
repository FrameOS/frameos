// @vitest-environment jsdom
//
// The workspace's "Add frame" panel. It lives in cloud-frontend/, which has no
// test runner, so it is tested from auth-web's vitest across the package
// boundary (see the other shared-spa tests).
//
// The panel used to live in this app, at /account/frames, and kept its open
// state in the URL (?add=frame). In the workspace the drawer around it owns
// that — the panel is mounted only while it is open — so "opened" here means
// "rendered" and "closed" means "unmounted".
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddFramePanel } from "../../../../../../cloud-frontend/src/components/AddFramePanel";

vi.mock(
  "../../../../../../cloud-frontend/src/components/SdImageBuilder",
  () => ({
    SdImageBuilder: () => <div data-testid="sd-builder" />,
  }),
);
vi.mock(
  "../../../../../../cloud-frontend/src/components/Esp32CloudFlasher",
  () => ({
    Esp32CloudFlasher: () => <div data-testid="esp32-flasher" />,
  }),
);

const fetchMock = vi.fn<typeof fetch>();
const onClose = vi.fn();

function renderPanel() {
  return render(
    <AddFramePanel
      claimTokenTtlHours={24}
      cloudOrigin="https://account.frameos.net"
      onClose={onClose}
    />,
  );
}

beforeEach(() => {
  onClose.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    Response.json({
      claim_token: "FRCT_from_server",
      expires_at: "2030-01-01T00:00:00Z",
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AddFramePanel", () => {
  // Regression: the panel used to mint a single-use code on every open.
  // Nothing revokes an unused code, the account holds only a few at a time,
  // and re-opening the drawer is one click — so a couple of dozen open/close
  // cycles burned the whole quota for 24 hours.
  it("mints nothing when the panel opens", async () => {
    renderPanel();

    expect(screen.getByText("Add a frame")).toBeDefined();
    // The command is shown with the code masked, so it is clear what will run.
    await screen.findByText(/FRAMEOS_CLAIM_TOKEN=<claim code>/);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes("/api/frames/claim-tokens"),
      ),
    ).toHaveLength(0);
  });

  // The origin is written into SD images, ESP32 NVS and this command, so it is
  // the deployment's configured public URL — not window.location.origin, which
  // is whatever host the admin browsed through.
  it("builds the install command against the injected cloud origin", async () => {
    renderPanel();

    await screen.findByText(
      /curl -fsSL https:\/\/account\.frameos\.net\/install\.sh/,
    );
    expect(window.location.origin).not.toBe("https://account.frameos.net");
  });

  it("mints one code when the user asks for the install command", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /generate command/i }));

    await screen.findByText(/FRAMEOS_CLAIM_TOKEN=FRCT_from_server/);
    const minted = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("/api/frames/claim-tokens"),
    );
    expect(minted).toHaveLength(1);
    // The code becomes copyable; no raw claim code to transcribe by hand.
    expect(screen.getByRole("button", { name: /copy command/i })).toBeDefined();
    expect(screen.queryByText(/paste this one-time code/i)).toBeNull();
  });

  it("explains a claim-code quota rejection instead of blaming the frame limit", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: "claim_token_quota_exceeded" }, { status: 403 }),
    );
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /generate command/i }));

    const alert = await screen.findByRole("alert");
    // Unused single-use codes recycle automatically, so this error can only
    // mean the cap is full of SD-image codes — say that, not "wait 24 hours".
    expect(alert.textContent).toContain("SD-card image");
    expect(alert.textContent).not.toContain("frame limit");
  });

  it("names the frame limit when that is what was hit", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: "frame_quota_exceeded" }, { status: 403 }),
    );
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /generate command/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("frame limit");
  });

  // A code that arrives after the panel closed belongs to the closed panel:
  // letting it land would overwrite whatever the reopened panel holds, and the
  // reopened panel would show a code the account may already have spent.
  it("drops a mint that was still in flight when the panel closed", async () => {
    let deliver: ((response: Response) => void) | undefined;
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise<Response>((resolve) => {
          signal = init?.signal ?? undefined;
          deliver = resolve;
        }),
    );
    const view = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /generate command/i }));

    // Closing the drawer unmounts the panel; reopening mounts a fresh one.
    view.unmount();
    expect(signal?.aborted).toBe(true);
    renderPanel();
    await act(async () => {
      deliver?.(Response.json({ claim_token: "FRCT_stale" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByText(/FRCT_stale/)).toBeNull();
    expect(screen.getByText(/FRAMEOS_CLAIM_TOKEN=<claim code>/)).toBeDefined();
  });

  // The first-run screen (an account with no frames) renders the same panel as
  // the whole page, where there is nothing behind it to close back to.
  it("offers no close button when nothing owns it", () => {
    render(
      <AddFramePanel
        claimTokenTtlHours={24}
        cloudOrigin="https://account.frameos.net"
      />,
    );

    expect(screen.getByText("Add a frame")).toBeDefined();
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
  });

  it("closes through the drawer that owns its open state", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /close/i }));

    expect(onClose).toHaveBeenCalledOnce();
  });
});
