// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initKea } from "../../../../../../frontend/src/initKea";
import { confirmDialog, confirmDialogLogic } from "../../../../../../frontend/src/utils/confirmDialogLogic";

// The delete/reset/disconnect flows used to block on window.confirm next to
// the toast system. confirmDialog() routes them through the app's one
// dialog when a host (ConfirmDialog, mounted by both App roots) is up, and
// keeps the browser prompt as the fallback where none is — an embed, a
// test — so no guarded flow ever runs unguarded.

describe("confirmDialog", () => {
  let unmount: () => void;

  beforeEach(() => {
    initKea({ memoryRouter: true });
    unmount = confirmDialogLogic.mount();
  });

  afterEach(() => {
    unmount();
    vi.restoreAllMocks();
  });

  it("falls back to window.confirm while no dialog host is mounted", async () => {
    const browserConfirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await expect(confirmDialog("Delete it?")).resolves.toBe(true);
    expect(browserConfirm).toHaveBeenCalledWith("Delete it?");
    browserConfirm.mockReturnValue(false);
    await expect(confirmDialog({ title: "Delete?", message: "Gone for good." })).resolves.toBe(false);
    expect(confirmDialogLogic.values.pending).toBeNull();
  });

  it("parks the request for the host and resolves with its answer", async () => {
    const browserConfirm = vi.spyOn(window, "confirm");
    confirmDialogLogic.actions.hostMounted();
    const answer = confirmDialog({ title: "Delete?", message: "Gone for good.", danger: true });
    expect(confirmDialogLogic.values.pending).toEqual({ title: "Delete?", message: "Gone for good.", danger: true });
    confirmDialogLogic.actions.answer(true);
    await expect(answer).resolves.toBe(true);
    expect(confirmDialogLogic.values.pending).toBeNull();
    expect(browserConfirm).not.toHaveBeenCalled();

    const declined = confirmDialog("Again?");
    confirmDialogLogic.actions.answer(false);
    await expect(declined).resolves.toBe(false);
  });

  it("cancels a request that a newer one displaces", async () => {
    confirmDialogLogic.actions.hostMounted();
    const first = confirmDialog("First?");
    const second = confirmDialog("Second?");
    await expect(first).resolves.toBe(false);
    expect(confirmDialogLogic.values.pending?.message).toBe("Second?");
    confirmDialogLogic.actions.answer(true);
    await expect(second).resolves.toBe(true);
  });

  it("goes back to the browser prompt once the last host unmounts", async () => {
    confirmDialogLogic.actions.hostMounted();
    confirmDialogLogic.actions.hostUnmounted();
    const browserConfirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await expect(confirmDialog("Reset?")).resolves.toBe(false);
    expect(browserConfirm).toHaveBeenCalledOnce();
  });
});
