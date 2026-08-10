// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceApprovalPanel } from "./DeviceApprovalPanel";

const fetchMock = vi.fn<typeof fetch>();

function deviceRequestPayload(overrides: Record<string, unknown> = {}) {
  return {
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    local_origin: "http://192.168.1.50:8989",
    public_display_name: "Kitchen frame backend",
    requested_scopes: ["backend:link"],
    signed_in: true,
    status: "pending",
    user_code: "H7LU-JLWN",
    ...overrides,
  };
}

async function lookupCode(code = "H7LUJLWN") {
  fireEvent.change(screen.getByLabelText("Code from backend or frame"), {
    target: { value: code },
  });
  fireEvent.click(screen.getByRole("button", { name: /find device/i }));
  await screen.findByText("FrameOS backend");
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("DeviceApprovalPanel", () => {
  it("shows an error when submitting without a code", () => {
    render(<DeviceApprovalPanel />);

    fireEvent.click(screen.getByRole("button", { name: /find device/i }));

    expect(
      screen.getByText("Enter the code shown by your FrameOS backend or frame."),
    ).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("looks up a code and renders the pending request", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(deviceRequestPayload()));

    render(<DeviceApprovalPanel />);
    await lookupCode();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/device/request?user_code=H7LUJLWN",
    );
    expect(screen.getByText("Kitchen frame backend")).toBeDefined();
    expect(screen.getByText("Waiting for approval")).toBeDefined();
    expect(
      screen.getByRole("button", { name: /connect backend/i }),
    ).toBeDefined();
  });

  it("speaks of a frame when the request came from one", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        deviceRequestPayload({
          client_kind: "frame",
          public_display_name: "Kitchen frame",
          requested_scopes: ["frame:link", "auth:login"],
        }),
      ),
    );

    render(<DeviceApprovalPanel />);
    fireEvent.change(screen.getByLabelText("Code from backend or frame"), {
      target: { value: "H7LUJLWN" },
    });
    fireEvent.click(screen.getByRole("button", { name: /find device/i }));
    await screen.findByText("FrameOS frame");

    expect(screen.getByText("Enabled features")).toBeDefined();
    expect(
      screen.getByRole("button", { name: /connect frame/i }),
    ).toBeDefined();
    expect(
      screen.getByText("Approve only if this is the frame you just opened."),
    ).toBeDefined();
  });

  it("shows the requested scopes with their descriptions", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        deviceRequestPayload({
          requested_scopes: ["backend:link", "auth:login", "mystery:scope"],
        }),
      ),
    );

    render(<DeviceApprovalPanel />);
    await lookupCode();

    // Baseline linking scopes are implied by connecting and stay hidden.
    expect(screen.queryByText("Backend link")).toBe(null);
    expect(screen.getByText("Cloud login")).toBeDefined();
    expect(
      screen.getByText(
        "Sign users in to this backend with their FrameOS Cloud account",
      ),
    ).toBeDefined();
    // Unknown scopes still show a generic line instead of disappearing.
    expect(screen.getByText("mystery:scope")).toBeDefined();
    expect(
      screen.getByText("Use the mystery:scope permission"),
    ).toBeDefined();
  });

  it("shows a plain note when only baseline scopes were requested", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        deviceRequestPayload({
          requested_scopes: ["backend:link", "backend:read"],
        }),
      ),
    );

    render(<DeviceApprovalPanel />);
    await lookupCode();

    expect(
      screen.getByText("None — just the basic cloud connection."),
    ).toBeDefined();
    expect(screen.queryByText("Backend link")).toBe(null);
    expect(screen.queryByText("Backend details")).toBe(null);
  });

  it("hides the code form when the code came from the URL", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(deviceRequestPayload()));

    render(<DeviceApprovalPanel initialUserCode="H7LU-JLWN" />);
    await screen.findByText("Kitchen frame backend");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/device/request?user_code=H7LU-JLWN",
    );
    expect(screen.queryByLabelText("Code from backend or frame")).toBe(null);
    expect(screen.queryByRole("button", { name: /find device/i })).toBe(null);
  });

  it("requires confirmation before approving a request opened from a link", async () => {
    // device/start is unauthenticated and everything shown on this screen is
    // written by the caller, so a link must not put approval one click away.
    fetchMock.mockResolvedValueOnce(Response.json(deviceRequestPayload()));

    render(<DeviceApprovalPanel initialUserCode="H7LU-JLWN" />);
    await screen.findByText("Kitchen frame backend");

    const connect = screen.getByRole("button", { name: /connect backend/i });
    expect((connect as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(
      screen.getByLabelText(/I started this connection on my own/i),
    );
    expect((connect as HTMLButtonElement).disabled).toBe(false);
  });

  it("approves without a confirmation step when the code was typed in", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(deviceRequestPayload()));

    render(<DeviceApprovalPanel />);
    fireEvent.change(screen.getByLabelText("Code from backend or frame"), {
      target: { value: "H7LU-JLWN" },
    });
    fireEvent.click(screen.getByRole("button", { name: /find device/i }));
    await screen.findByText("Kitchen frame backend");

    const connect = screen.getByRole("button", { name: /connect backend/i });
    expect((connect as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the code form again when the URL code lookup fails", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: "invalid_user_code" }, { status: 404 }),
    );

    render(<DeviceApprovalPanel initialUserCode="QWBN-CLLX" />);

    expect(await screen.findByText("invalid_user_code")).toBeDefined();
    const input = screen.getByLabelText<HTMLInputElement>(
      "Code from backend or frame",
    );
    expect(input.value).toBe("QWBN-CLLX");
    expect(
      screen.getByRole("button", { name: /find device/i }),
    ).toBeDefined();
  });

  it("shows the server error when the lookup fails", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: "invalid_user_code" }, { status: 404 }),
    );

    render(<DeviceApprovalPanel />);
    fireEvent.change(screen.getByLabelText("Code from backend or frame"), {
      target: { value: "WRONGCOD" },
    });
    fireEvent.click(screen.getByRole("button", { name: /find device/i }));

    expect(await screen.findByText("invalid_user_code")).toBeDefined();
  });

  it("asks the user to sign in before deciding", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(deviceRequestPayload({ signed_in: false })),
    );

    render(<DeviceApprovalPanel />);
    await lookupCode();

    expect(screen.getByRole("link", { name: /sign in/i })).toBeDefined();
    expect(screen.queryByRole("button", { name: /connect backend/i })).toBe(
      null,
    );
  });

  it("approves a request and shows the connected state", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(deviceRequestPayload()))
      .mockResolvedValueOnce(Response.json({ status: "approved" }));

    render(<DeviceApprovalPanel />);
    await lookupCode();
    fireEvent.click(screen.getByRole("button", { name: /connect backend/i }));

    expect(await screen.findByText("Backend connected")).toBeDefined();
    expect(screen.getByText("Connected")).toBeDefined();
    expect(fetchMock).toHaveBeenLastCalledWith("/api/device/authorize", {
      body: JSON.stringify({ user_code: "H7LU-JLWN" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  });

  it("denies a request and shows the canceled state", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(deviceRequestPayload()))
      .mockResolvedValueOnce(Response.json({ status: "denied" }));

    render(<DeviceApprovalPanel />);
    await lookupCode();
    fireEvent.click(screen.getByRole("button", { name: /don.t connect/i }));

    expect(await screen.findByText("Connection canceled")).toBeDefined();
    expect(screen.getByText("Canceled")).toBeDefined();
  });

  it("falls back to the expected status when the decision response is malformed", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(deviceRequestPayload()))
      .mockResolvedValueOnce(Response.json({ status: "garbage" }));

    render(<DeviceApprovalPanel />);
    await lookupCode();
    fireEvent.click(screen.getByRole("button", { name: /connect backend/i }));

    expect(await screen.findByText("Backend connected")).toBeDefined();
    expect(screen.getByText("Connected")).toBeDefined();
  });

  it("ignores a stale lookup response that resolves after a newer one", async () => {
    let resolveSlow: (response: Response) => void = () => {};
    fetchMock
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveSlow = resolve;
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          deviceRequestPayload({ public_display_name: "Newer backend" }),
        ),
      );

    render(<DeviceApprovalPanel />);
    fireEvent.change(screen.getByLabelText("Code from backend or frame"), {
      target: { value: "FIRSTCOD" },
    });
    fireEvent.click(screen.getByRole("button", { name: /find device/i }));
    fireEvent.change(screen.getByLabelText("Code from backend or frame"), {
      target: { value: "SECONDCO" },
    });
    fireEvent.click(screen.getByRole("button", { name: /find device/i }));
    await screen.findByText("Newer backend");

    resolveSlow(
      Response.json(
        deviceRequestPayload({ public_display_name: "Stale backend" }),
      ),
    );
    await Promise.resolve();

    expect(screen.getByText("Newer backend")).toBeDefined();
    expect(screen.queryByText("Stale backend")).toBe(null);
  });
});
