import { describe, expect, it } from "vitest";
import { organizationInvitationEmail } from "./email";
import { cleanEmail, cleanIdList, cleanName, cleanRole } from "./organization-manage";
import { frameAccessSummary, isUuid, roleAllows } from "./organizations";

// Who may do what with a shared frame (cloud/docs/sharing.md). The database
// half is src/test/integration/sharing.integration.test.ts.
describe("frame access levels", () => {
  it("gives a member the frame, an admin its switches, and the owner the rest", () => {
    const matrix = (["member", "admin", "owner"] as const).map((role) =>
      (["view", "edit", "manage", "owner"] as const).map((need) => roleAllows(role, need)),
    );
    expect(matrix).toEqual([
      [true, true, false, false],
      [true, true, true, false],
      [true, true, true, true],
    ]);
  });

  it("names the owner only on a frame that is someone else's", () => {
    const project = { id: "p", name: "Home" };
    const organization = { id: "o", name: "Olive" };
    expect(frameAccessSummary({ organization: null, project: null, role: "owner" })).toEqual({
      organization: null,
      project: null,
      role: "owner",
    });
    expect(
      frameAccessSummary({ organization, owner: { name: "Olive" }, project, role: "member" }),
    ).toEqual({ organization, owner_name: "Olive", project, role: "member" });
  });
});

describe("what the organization routes accept", () => {
  it("stores a name as one trimmed line", () => {
    expect(cleanName("  The\n Olives\t ", 60)).toBe("The Olives");
    expect(cleanName("", 60)).toBeUndefined();
    expect(cleanName("   ", 60)).toBeUndefined();
    expect(cleanName("x".repeat(61), 60)).toBeUndefined();
    expect(cleanName(7, 60)).toBeUndefined();
  });

  it("takes one address, lowercased, and nothing that could be a list or a header", () => {
    expect(cleanEmail(" Milo@Example.COM ")).toBe("milo@example.com");
    for (const bad of ["milo", "milo@", "a@b", "a@b.c, d@e.f", "a@b.c\nbcc: x@y.z", "<a@b.c>", "", 5]) {
      expect(cleanEmail(bad)).toBeUndefined();
    }
  });

  it("knows two roles and distinct uuids", () => {
    expect(cleanRole("admin")).toBe("admin");
    expect(cleanRole("owner")).toBeUndefined();
    const id = "0b6c1d3e-8f2a-4c5d-9e7f-1a2b3c4d5e6f";
    expect(isUuid(id)).toBe(true);
    expect(isUuid("------------------------------------")).toBe(false);
    expect(cleanIdList([id, id], 10)).toEqual([id]);
    expect(cleanIdList([id, "nope"], 10)).toBeUndefined();
    expect(cleanIdList([id, id], 1)).toBeUndefined();
    expect(cleanIdList("x", 10)).toBeUndefined();
  });
});

describe("the invitation mail", () => {
  it("says who invited, links only the invitation, and escapes what people typed", () => {
    const mail = organizationInvitationEmail({
      inviter: 'Olive <a href="https://evil.example">win</a>',
      organization: "Olives & Co",
      url: "https://cloud.example/account/people?invite=FOINV_abc",
    });
    expect(mail.subject).toBe("You were invited to share frames on FrameOS Cloud");
    expect(mail.textBody).toContain("Accept the invitation: https://cloud.example/account/people?invite=FOINV_abc");
    expect(mail.textBody).toContain("valid for seven days");
    // One link in the HTML: ours.
    expect(mail.htmlBody.match(/<a /g)).toHaveLength(1);
    expect(mail.htmlBody).toContain("Olives &amp; Co");
    expect(mail.htmlBody).toContain("&lt;a href=&quot;https://evil.example&quot;&gt;");
  });
});
