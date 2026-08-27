// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoreActionCards } from "./StoreActionCards";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

afterEach(cleanup);

describe("StoreActionCards", () => {
  it("opens one form at a time under the card that was pressed, and folds it away again", () => {
    render(<StoreActionCards aiAction="/my-scenes/new" showUpload />);
    const ai = screen.getByRole("button", { name: /Create a scene with AI/ });
    const zip = screen.getByRole("button", { name: /Upload a scene ZIP/ });
    expect(ai.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("action-card-form")).toBeNull();

    fireEvent.click(ai);
    expect(ai.getAttribute("aria-pressed")).toBe("true");
    const prompt = screen.getByLabelText("Describe the scene you want") as HTMLTextAreaElement;
    expect(prompt.form?.getAttribute("action")).toBe("/my-scenes/new");
    // The card already carries the heading; the form is just its row.
    expect(screen.queryByRole("heading", { name: "Create a scene with AI" })).toBeNull();

    fireEvent.click(zip);
    expect(ai.getAttribute("aria-pressed")).toBe("false");
    expect(zip.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByLabelText("Describe the scene you want")).toBeNull();
    expect(screen.getByLabelText("FrameOS scene ZIP")).toBeTruthy();

    fireEvent.click(zip);
    expect(zip.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("action-card-form")).toBeNull();
  });

  it("offers only the AI card on the store front", () => {
    render(<StoreActionCards aiAction="/my-scenes/new" showUpload={false} />);
    expect(screen.getByRole("button", { name: /Create a scene with AI/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Upload a scene ZIP/ })).toBeNull();
  });
});
