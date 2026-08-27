// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateSceneWithAiBox } from "./CreateSceneWithAiBox";

afterEach(cleanup);

// jsdom has no layout: scrollHeight is always 0, so the grow maths cannot be
// exercised here. What these pin is the shape of the control — a textarea
// that starts one line tall and still submits on Enter — and the plain GET
// form underneath it.
describe("CreateSceneWithAiBox", () => {
  function prompt() {
    return screen.getByLabelText("Describe the scene you want") as HTMLTextAreaElement;
  }

  it("takes a multi-line prompt in a textarea that starts one row tall", () => {
    render(<CreateSceneWithAiBox action="/my-scenes/new" />);
    const field = prompt();
    expect(field.tagName).toBe("TEXTAREA");
    expect(field.rows).toBe(1);
    expect(field.name).toBe("prompt");
    expect(field.required).toBe(true);
    expect(field.maxLength).toBe(2000);
    // Still the plain GET form: the prompt arrives as ?prompt=…
    expect(field.form?.method).toBe("get");
    expect(field.form?.getAttribute("action")).toBe("/my-scenes/new");
  });

  it("sends on Enter and takes a newline on Shift+Enter", () => {
    render(<CreateSceneWithAiBox action="/my-scenes/new" />);
    const field = prompt();
    const submit = vi.fn();
    field.form!.requestSubmit = submit;

    fireEvent.change(field, { target: { value: "A clock" } });
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(submit).not.toHaveBeenCalled();

    fireEvent.keyDown(field, { key: "Enter" });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("leaves an IME's Enter to the IME", () => {
    render(<CreateSceneWithAiBox action="/my-scenes/new" />);
    const field = prompt();
    const submit = vi.fn();
    field.form!.requestSubmit = submit;

    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    expect(submit).not.toHaveBeenCalled();
  });
});
