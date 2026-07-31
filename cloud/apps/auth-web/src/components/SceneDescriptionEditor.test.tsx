// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SceneDescriptionEditor } from "./SceneDescriptionEditor";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

afterEach(cleanup);

describe("SceneDescriptionEditor", () => {
  it("formats selected text and previews the Markdown", () => {
    render(<SceneDescriptionEditor description="bird journal" sceneId="scene-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const textarea = screen.getByRole("textbox", {
      name: "Scene description",
    }) as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(0, 4);
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    expect(textarea.value).toBe("**bird** journal");

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByText("bird").tagName).toBe("STRONG");
    expect(screen.queryByText("0 / 2000")).toBeNull();
    expect(screen.getByText("16 / 2000")).toBeTruthy();
  });
});
