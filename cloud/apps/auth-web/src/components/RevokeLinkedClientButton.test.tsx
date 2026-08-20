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
  window.sessionStorage.clear();
});

const reauthRequired = () =>
  Response.json({ error: "reauth_required" }, { status: 403 });

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

  it("sends the user to /login/reauth and replays the revoke on return", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign, href: "https://cloud.test/account/installs" });
    fetchMock.mockResolvedValueOnce(reauthRequired());

    render(<RevokeLinkedClientButton linkedClientId="client-1" />);
    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));

    await vi.waitFor(() => {
      expect(assign).toHaveBeenCalledWith(
        "/login/reauth?return_to=https%3A%2F%2Fcloud.test%2Faccount%2Finstalls",
      );
    });
    cleanup();

    // Back on the page with a fresh proof: the revoke finishes by itself.
    fetchMock.mockResolvedValueOnce(Response.json({ status: "revoked" }));
    render(<RevokeLinkedClientButton linkedClientId="client-1" />);
    expect(await screen.findByRole("button", { name: /revoked/i })).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The stash is one-shot: a third mount does nothing.
    cleanup();
    render(<RevokeLinkedClientButton linkedClientId="client-1" />);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not bounce back to /login/reauth when the replay is still refused", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign, href: "https://cloud.test/account/installs" });
    fetchMock.mockResolvedValueOnce(reauthRequired());
    render(<RevokeLinkedClientButton linkedClientId="client-1" />);
    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));
    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    cleanup();

    // User pressed Cancel on the reauth page; the session is still stale.
    fetchMock.mockResolvedValueOnce(reauthRequired());
    render(<RevokeLinkedClientButton linkedClientId="client-1" />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("ignores a stash that belongs to another row", () => {
    window.sessionStorage.setItem(
      "frameos.reauth.pending",
      JSON.stringify({ action: "revoke-install:other", at: Date.now() }),
    );
    render(<RevokeLinkedClientButton linkedClientId="client-1" />);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
