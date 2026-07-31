// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RevokeLinkedClientButton } from "./RevokeLinkedClientButton";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("RevokeLinkedClientButton", () => {
  it("revokes the linked client and disables further clicks", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ status: "revoked" }));

    render(<RevokeLinkedClientButton linkedClientId="client-1" />);
    const button = screen.getByRole("button", { name: /revoke/i });
    fireEvent.click(button);

    expect(await screen.findByRole("button", { name: /revoked/i })).toBeDefined();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/device/revoke", {
      body: JSON.stringify({ linked_client_id: "client-1" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  });

  it("disables the button while the request is in flight", () => {
    fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}));

    render(<RevokeLinkedClientButton linkedClientId="client-1" />);
    const button = screen.getByRole("button", { name: /revoke/i });
    fireEvent.click(button);

    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("stays disabled after a failed request instead of retry-looping", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: "not_found" }, { status: 404 }),
    );

    render(<RevokeLinkedClientButton linkedClientId="client-1" />);
    const button = screen.getByRole("button", { name: /revoke/i });
    fireEvent.click(button);

    await vi.waitFor(() => {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    });
    expect(screen.getByRole("button", { name: /revoke/i })).toBeDefined();
  });
});
