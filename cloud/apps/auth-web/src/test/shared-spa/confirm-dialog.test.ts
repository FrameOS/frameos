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

  it("stays up, busy, while the confirmed work runs, and closes when it settles", async () => {
    confirmDialogLogic.actions.hostMounted();
    let finishWork = (): void => {};
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => (finishWork = resolve)));
    let answered: boolean | null = null;
    void confirmDialog({ message: "Update?", onConfirm }).then((confirmed) => (answered = confirmed));

    confirmDialogLogic.actions.confirm();
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(confirmDialogLogic.values.busy).toBe(true);
    expect(confirmDialogLogic.values.pending?.message).toBe("Update?");
    await Promise.resolve();
    expect(answered).toBeNull();

    finishWork();
    await vi.waitFor(() => expect(answered).toBe(true));
    expect(confirmDialogLogic.values.busy).toBe(false);
    expect(confirmDialogLogic.values.pending).toBeNull();
  });

  it("the extra action runs ITS work, not the main one's, with its own busy flag", async () => {
    confirmDialogLogic.actions.hostMounted();
    let finishWork = (): void => {};
    const onConfirm = vi.fn();
    const onExtra = vi.fn(() => new Promise<void>((resolve) => (finishWork = resolve)));
    let answered: boolean | null = null;
    void confirmDialog({
      extraAction: { label: "Update all scenes (3)", onConfirm: onExtra },
      message: "Update?",
      onConfirm,
    }).then((confirmed) => (answered = confirmed));

    confirmDialogLogic.actions.confirmExtra();
    expect(onExtra).toHaveBeenCalledOnce();
    expect(confirmDialogLogic.values.busy).toBe(true);
    expect(confirmDialogLogic.values.busyExtra).toBe(true);

    finishWork();
    await vi.waitFor(() => expect(answered).toBe(true));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(confirmDialogLogic.values.busy).toBe(false);
    expect(confirmDialogLogic.values.busyExtra).toBe(false);
  });

  it("never runs the work on a no, and runs it under the browser prompt's yes", async () => {
    const onConfirm = vi.fn();
    confirmDialogLogic.actions.hostMounted();
    const declined = confirmDialog({ message: "Update?", onConfirm });
    confirmDialogLogic.actions.answer(false);
    await expect(declined).resolves.toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();

    confirmDialogLogic.actions.hostUnmounted();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await expect(confirmDialog({ message: "Update?", onConfirm })).resolves.toBe(true);
    expect(onConfirm).toHaveBeenCalledOnce();
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
