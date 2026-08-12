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
import { StrictMode } from "react";
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

function mintCalls() {
  return fetchMock.mock.calls.filter(([input]) =>
    String(input).includes("/api/frames/claim-tokens"),
  );
}

// The panel opens on a chooser stage — one button per enrollment path — and
// the forms live behind them.
function openPath(name: RegExp) {
  fireEvent.click(screen.getByRole("button", { name }));
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
  // The install command is ready to copy on sight: opening the panel mints the
  // code. That was once forbidden — every open spent one of the account's 50
  // claim-code slots permanently, so browsing in and out of the panel locked
  // enrollment for a whole TTL — and it is allowed now only because the server
  // recycles: at the cap it deletes the oldest never-used single-use codes
  // (evictOldestUnusedClaimTokens) instead of refusing. Repeat opens churn one
  // slot rather than consuming many. If that recycling ever goes away, so must
  // this test.
  it("mints exactly one code when the panel opens", async () => {
    // Not at import time and not during render: the request belongs to a
    // mounted, visible panel, which is what keeps a closed drawer free.
    expect(fetchMock).not.toHaveBeenCalled();

    renderPanel();

    expect(screen.getByText("Add a frame")).toBeDefined();
    // Minted at mount — before any path is chosen — so the command is ready
    // the moment the script stage opens.
    expect(mintCalls()).toHaveLength(1);
    openPath(/install script/i);
    await screen.findByText(/FRAMEOS_CLAIM_TOKEN=FRCT_from_server/);
    expect(mintCalls()).toHaveLength(1);
    // Copyable straight away — no claim code to transcribe by hand, and no
    // button to press first.
    expect(
      screen.queryByRole("button", { name: /generate command/i }),
    ).toBeNull();
    expect(
      (screen.getByRole("button", { name: /copy command/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("mints once per opening, not once per render", async () => {
    const view = renderPanel();
    openPath(/install script/i);
    await screen.findByText(/FRAMEOS_CLAIM_TOKEN=FRCT_from_server/);

    view.rerender(
      <AddFramePanel
        claimTokenTtlHours={24}
        cloudOrigin="https://account.frameos.net"
        onClose={onClose}
      />,
    );

    expect(mintCalls()).toHaveLength(1);
  });

  // React strict mode mounts, unmounts and mounts again in development. The
  // guard is a ref for exactly this reason: a second POST would spend a second
  // code that nothing can ever hand back.
  it("mints once through a strict-mode double mount", async () => {
    render(
      <StrictMode>
        <AddFramePanel
          claimTokenTtlHours={24}
          cloudOrigin="https://account.frameos.net"
          onClose={onClose}
        />
      </StrictMode>,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mintCalls()).toHaveLength(1);
  });

  // While the code is in flight the command keeps its shape with the code
  // masked, so nothing jumps when the real one lands.
  it("shows the masked command while the code is still in flight", async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));
    renderPanel();
    openPath(/install script/i);

    await screen.findByText(/FRAMEOS_CLAIM_TOKEN=<claim code>/);
    expect(screen.getByText(/Creating a single-use claim code/)).toBeDefined();
    expect(
      (screen.getByRole("button", { name: /copy command/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  // The origin is written into SD images, ESP32 NVS and this command, so it is
  // the deployment's configured public URL — not window.location.origin, which
  // is whatever host the admin browsed through.
  it("builds the install command against the injected cloud origin", async () => {
    renderPanel();
    openPath(/install script/i);

    await screen.findByText(
      /curl -fsSL https:\/\/account\.frameos\.net\/install\.sh/,
    );
    expect(window.location.origin).not.toBe("https://account.frameos.net");
  });

  it("explains a claim-code quota rejection instead of blaming the frame limit", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: "claim_token_quota_exceeded" }, { status: 403 }),
    );
    renderPanel();

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

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("frame limit");
  });

  // A code that arrives after the panel closed belongs to the closed panel:
  // letting it land would show the reopened panel a code the account may
  // already have spent on an install, on top of the one it minted for itself.
  it("drops a mint that was still in flight when the panel closed", async () => {
    // One entry per request, because closing and reopening now makes two: the
    // stale one must not be able to land in the panel that replaced it.
    const pending: {
      deliver: (response: Response) => void;
      signal: AbortSignal | undefined;
    }[] = [];
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise<Response>((resolve) => {
          pending.push({ deliver: resolve, signal: init?.signal ?? undefined });
        }),
    );
    const view = renderPanel();
    expect(pending).toHaveLength(1);

    // Closing the drawer unmounts the panel; reopening mounts a fresh one.
    view.unmount();
    expect(pending[0]?.signal?.aborted).toBe(true);
    renderPanel();
    openPath(/install script/i);
    await act(async () => {
      pending[0]?.deliver(Response.json({ claim_token: "FRCT_stale" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByText(/FRCT_stale/)).toBeNull();
    // The reopened panel's own request is still in flight, so the command
    // still shows the placeholder rather than a code from the closed one.
    expect(pending[1]?.signal?.aborted).toBe(false);
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

  it("opens on a chooser stage and drills into one path at a time", async () => {
    renderPanel();

    // Stage one: all four paths as buttons, no forms yet.
    expect(screen.getByRole("button", { name: /install script/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /sd card image/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /link a frame/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /flash an esp32/i })).toBeDefined();
    expect(screen.queryByTestId("esp32-flasher")).toBeNull();
    expect(screen.queryByTestId("sd-builder")).toBeNull();
    expect(screen.queryByText(/FRAMEOS_CLAIM_TOKEN/)).toBeNull();

    // Stage two: only the chosen path's form.
    openPath(/flash an esp32/i);
    expect(screen.getByTestId("esp32-flasher")).toBeDefined();
    expect(screen.queryByTestId("sd-builder")).toBeNull();
    expect(screen.queryByText(/FRAMEOS_CLAIM_TOKEN/)).toBeNull();

    // Back to the chooser.
    fireEvent.click(
      screen.getByRole("button", { name: /all ways to add a frame/i }),
    );
    expect(screen.queryByTestId("esp32-flasher")).toBeNull();
    expect(screen.getByRole("button", { name: /sd card image/i })).toBeDefined();

    openPath(/sd card image/i);
    expect(screen.getByTestId("sd-builder")).toBeDefined();
    expect(screen.queryByTestId("esp32-flasher")).toBeNull();
  });

  it("closes through the drawer that owns its open state", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /close/i }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  // Re-enrollment used to live in the deploy drawer of the frame being
  // repaired, which meant finding the right frame first — backwards for the
  // actual situation ("I have a wiped board in my hand"). It is enrollment,
  // so it lives here: pick the frame, then the flasher runs with a claim
  // token bound to it.
  it("reconnects a wiped board through a frame picker", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/api/frames/claim-tokens")) {
        return Promise.resolve(
          Response.json({ claim_token: "FRCT_from_server" }),
        );
      }
      if (url.includes("/api/frames")) {
        return Promise.resolve(
          Response.json({
            frames: [
              // Only esp32 frames qualify — a Pi's identity is not in
              // flashable NVS, so it must not be offered.
              { id: "f-1", name: "Kitchen", hardware: { platform: "esp32-s3", panel: "EPD_7in3e" }, connected: false },
              { id: "f-2", name: "Hallway Pi", hardware: { platform: "pi-zero2w" }, connected: true },
            ],
          }),
        );
      }
      return Promise.resolve(Response.json({}));
    });
    renderPanel();

    openPath(/reconnect a board/i);
    // The flasher only mounts once a target frame is chosen: it mints a
    // token bound to that frame, so there is no meaningful "unbound" state.
    expect(screen.queryByTestId("esp32-flasher")).toBeNull();
    const kitchen = await screen.findByRole("button", { name: /Kitchen/ });
    expect(screen.queryByRole("button", { name: /Hallway Pi/ })).toBeNull();

    fireEvent.click(kitchen);
    expect(screen.getByTestId("esp32-flasher")).toBeDefined();
  });

  it("points a fleet with no esp32 frames at plain enrollment instead", async () => {
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/api/frames/claim-tokens")) {
        return Promise.resolve(
          Response.json({ claim_token: "FRCT_from_server" }),
        );
      }
      return Promise.resolve(Response.json({ frames: [] }));
    });
    renderPanel();

    openPath(/reconnect a board/i);
    await screen.findByText(/no ESP32 frames to reconnect to/i);
    expect(screen.queryByTestId("esp32-flasher")).toBeNull();
  });
});
