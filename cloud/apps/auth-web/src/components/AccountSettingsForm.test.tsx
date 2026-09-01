// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storableAccountSettingsFields } from "../lib/account-settings";
import {
  serviceSettingsFrom,
  serviceSettingsGroups,
  sshKeysFrom,
} from "../lib/account-settings-form";
import { AccountSettingsForm } from "./AccountSettingsForm";
import { AccountSshKeys } from "./AccountSshKeys";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("account settings page", () => {
  it("edits only groups and fields the cloud can store", () => {
    for (const group of serviceSettingsGroups) {
      const allowed = storableAccountSettingsFields.get(group.key);
      expect(allowed, group.key).toBeDefined();
      for (const field of group.fields) {
        expect(allowed?.has(field.name), `${group.key}.${field.name}`).toBe(true);
      }
    }
  });

  it("builds every group with every field, '' when unset", () => {
    const values = serviceSettingsFrom({
      openAI: { apiKey: "sk-frames", chatModel: 7 },
      unsplash: "not an object",
    });
    expect(values.openAI).toEqual({
      apiKey: "sk-frames",
      backendApiKey: "",
      chatModel: "",
      chatReasoningEffort: "",
    });
    expect(values.unsplash).toEqual({ accessKey: "" });
    expect(Object.keys(values)).toEqual(serviceSettingsGroups.map((group) => group.key));
  });

  it("posts every service group wholesale and resets from the answer", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      // The route answers with what it stored (an extra group the form does
      // not edit rides along, as ssh_keys does in production).
      return jsonResponse({ ...body, ssh_keys: { keys: [] } });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AccountSettingsForm
        initial={serviceSettingsFrom({ unsplash: { accessKey: "old-key" } })}
      />,
    );
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Access key"), { target: { value: "new-key" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await screen.findByRole("status");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/settings");
    expect(init?.method).toBe("POST");
    const posted = JSON.parse(String(init?.body)) as Record<string, Record<string, string>>;
    expect(Object.keys(posted).sort()).toEqual(
      serviceSettingsGroups.map((group) => group.key).sort(),
    );
    expect(posted.unsplash).toEqual({ accessKey: "new-key" });
    // Untouched groups go along in full — POST replaces groups wholesale, so
    // leaving one out would not "keep" it, and a missing field would clear it.
    expect(posted.homeAssistant).toEqual({ url: "", accessToken: "" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the route's refusal and keeps the edit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "settings_value_too_large" }, 400)),
    );
    render(<AccountSettingsForm initial={serviceSettingsFrom({})} />);
    fireEvent.change(screen.getByLabelText("API key for frames"), {
      target: { value: "sk-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/too long/);
    expect((screen.getByLabelText("API key for frames") as HTMLInputElement).value).toBe("sk-1");
  });

  it("keeps the model settings folded unless one is set", () => {
    const { unmount } = render(<AccountSettingsForm initial={serviceSettingsFrom({})} />);
    expect(screen.queryByLabelText("Chat model")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show model settings" }));
    expect(screen.getByLabelText("Chat model")).toBeTruthy();
    unmount();

    render(
      <AccountSettingsForm
        initial={serviceSettingsFrom({ openAI: { chatReasoningEffort: "high" } })}
      />,
    );
    expect((screen.getByLabelText("Reasoning effort") as HTMLSelectElement).value).toBe("high");
  });
});

describe("account SSH keys", () => {
  const line = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGxhcHRvcC1rZXktZm9yLXRlc3Rz you@laptop";

  it("reads the stored group and skips what is not a key", () => {
    expect(
      sshKeysFrom({
        ssh_keys: {
          keys: [
            { id: "a", name: "Laptop", public: line, use_for_new_frames: true },
            { id: "b", name: "Empty", public: "" },
            "junk",
          ],
        },
      }),
    ).toEqual([{ id: "a", name: "Laptop", public: line, use_for_new_frames: true }]);
    expect(sshKeysFrom({})).toEqual([]);
  });

  it("saves the whole list on add and renders what the server kept", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        ssh_keys: { keys: { id: string; name: string; public: string }[] };
      };
      return jsonResponse({ ssh_keys: body.ssh_keys });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AccountSshKeys
        initialKeys={[{ id: "a", name: "Laptop", public: line, use_for_new_frames: true }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add SSH key" }));
    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "Desk" } });
    fireEvent.change(screen.getByLabelText("Public key"), {
      target: { value: `  ${line.replace("you@laptop", "me@desk")}\n` },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));

    await waitFor(() => expect(screen.getByText("Desk")).toBeTruthy());
    const posted = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as {
      ssh_keys: { keys: { id: string; name: string; public: string; use_for_new_frames: boolean }[] };
    };
    expect(posted).toEqual({
      ssh_keys: {
        keys: [
          { id: "a", name: "Laptop", public: line, use_for_new_frames: true },
          {
            id: expect.any(String),
            name: "Desk",
            public: line.replace("you@laptop", "me@desk"),
            use_for_new_frames: true,
          },
        ],
      },
    });
    expect(screen.getByText("Laptop")).toBeTruthy();
    expect(screen.queryByLabelText("Public key")).toBeNull();
  });

  it("explains a refused key and keeps the form open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "invalid_ssh_key" }, 400)),
    );
    render(<AccountSshKeys initialKeys={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add SSH key" }));
    fireEvent.change(screen.getByLabelText("Public key"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/not an OpenSSH public key/);
    expect((screen.getByLabelText("Public key") as HTMLTextAreaElement).value).toBe("nope");
  });
});
