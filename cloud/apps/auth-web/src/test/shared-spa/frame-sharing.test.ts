// Sharing frames with the people on a plan (cloud/docs/sharing.md), as the
// workspace words it: who a frame belongs to, and the controls a person who
// is not the owner is not offered. The People page itself is
// people-page.test.tsx.
import { describe, expect, it } from "vitest";
import { accountPages, isAccountPageKey } from "../../../../../../frontend/src/scenes/settings/account/accountPages";
import {
  frameIsSharedWithAccount,
  frameMenuActionIsAllowed,
  ownerOnlyFrameMenuActions,
} from "../../../../../../frontend/src/scenes/workspace/workspaceSurfaces";
import {
  canManageFrame,
  frameAccessRole,
  frameIsSharedWithMe,
  frameSharingLabel,
} from "../../../../../../frontend/src/utils/frameAccess";
import { mergeBroadcastFrame } from "../../../../../../frontend/src/utils/frameSecrets";

const home = { id: "p-home", name: "Home" };
const shared = {
  access: { organization: { id: "o1", name: "Olive" }, owner_name: "Olive", project: home, role: "member" as const },
};

describe("who a frame belongs to", () => {
  it("reads a frame without access as the account's own", () => {
    expect(frameAccessRole(undefined)).toBe("owner");
    expect(frameAccessRole({})).toBe("owner");
    expect(frameIsSharedWithMe({})).toBe(false);
    expect(canManageFrame({})).toBe(true);
    expect(frameSharingLabel({})).toBeNull();
  });

  it("says whose a shared frame is, and which project the owner shares one through", () => {
    expect(frameIsSharedWithMe(shared)).toBe(true);
    expect(frameSharingLabel(shared)).toBe("Shared by Olive");
    expect(frameSharingLabel({ access: { project: home, role: "owner" } })).toBe("Shared in Home");
    expect(frameSharingLabel({ access: { project: null, role: "owner" } })).toBeNull();
  });

  it("leaves the owner's switches to the owner and the admins", () => {
    expect(canManageFrame(shared)).toBe(false);
    expect(canManageFrame({ access: { ...shared.access, role: "admin" } })).toBe(true);
  });

  it("offers deleting a frame to its owner only", () => {
    expect(ownerOnlyFrameMenuActions).toEqual(["delete"]);
    const hardware = { hardware: { platform: "pi-zero2w" } };
    expect(frameMenuActionIsAllowed("cloud", "delete", hardware)).toBe(true);
    expect(frameMenuActionIsAllowed("cloud", "delete", { ...hardware, access: { role: "owner" } })).toBe(true);
    for (const role of ["member", "admin"]) {
      const frame = { ...hardware, access: { role } };
      expect(frameIsSharedWithAccount(frame)).toBe(true);
      expect(frameMenuActionIsAllowed("cloud", "delete", frame)).toBe(false);
      // What changes the frame stays.
      expect(frameMenuActionIsAllowed("cloud", "rename", frame)).toBe(true);
      expect(frameMenuActionIsAllowed("cloud", "reboot", frame)).toBe(true);
    }
  });

  it("keeps a frame's access through a live update that does not carry it", () => {
    // Typed loosely: a broadcast is a partial row.
    const row: Record<string, unknown> = { id: "f1", name: "Kitchen", ...shared };
    const merged = mergeBroadcastFrame(row, { connected: true, name: "Wall" });
    expect(merged.access).toEqual(shared.access);
    expect(merged.name).toBe("Wall");
  });

  it("has a page of the account for it", () => {
    expect(isAccountPageKey("people")).toBe(true);
    expect(accountPages.map((page) => page.key)).toContain("people");
  });
});
