// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SceneZipUpload } from "./SceneZipUpload";

const fetchMock = vi.fn<typeof fetch>();
const refreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  refreshMock.mockReset();
  vi.unstubAllGlobals();
});

describe("SceneZipUpload", () => {
  it("uploads the selected ZIP and refreshes the scene list", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ scene: { name: "Sunrise Clock", version: 2 } }),
    );
    render(<SceneZipUpload />);

    const file = new File(["zip bytes"], "sunrise.zip", {
      type: "application/zip",
    });
    fireEvent.change(screen.getByLabelText("FrameOS scene ZIP"), {
      target: { files: [file] },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "Upload ZIP" }).closest("form")!,
    );

    expect(
      await screen.findByText("Uploaded Sunrise Clock (v2)"),
    ).toBeDefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/account/scenes/upload");
    expect(init?.method).toBe("POST");
    expect((init?.body as FormData).get("file")).toBe(file);
    expect(refreshMock).toHaveBeenCalledOnce();
  });

  it("shows a useful validation error from the server", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: "missing_template_json" }, { status: 400 }),
    );
    render(<SceneZipUpload />);

    fireEvent.change(screen.getByLabelText("FrameOS scene ZIP"), {
      target: { files: [new File(["bad"], "bad.zip")] },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "Upload ZIP" }).closest("form")!,
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The ZIP has no template.json",
    );
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
