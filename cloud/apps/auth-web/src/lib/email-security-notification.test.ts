import { afterEach, describe, expect, it, vi } from "vitest";
import { securityNotificationEmail, sendSecurityNotificationEmail } from "./email";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.POSTMARK_SERVER_TOKEN;
});

describe("securityNotificationEmail", () => {
  const when = new Date("2026-09-02T10:11:12.345Z");

  it("names the change, the time and the detail in both bodies", () => {
    const mail = securityNotificationEmail("owner@example.com", {
      detail: "YubiKey 5",
      what: "passkey_added",
      when,
    });
    expect(mail.to).toBe("owner@example.com");
    expect(mail.subject).toBe("Your FrameOS Cloud sign-in security changed");
    expect(mail.textBody).toContain("A passkey was added to your FrameOS Cloud account.");
    expect(mail.textBody).toContain("When: 2026-09-02 10:11:12 UTC");
    expect(mail.textBody).toContain("Details: YubiKey 5");
    expect(mail.textBody).toContain("If it was not");
    expect(mail.htmlBody).toContain("<p>A passkey was added to your FrameOS Cloud account.</p>");
    expect(mail.htmlBody).toContain("Details: YubiKey 5");
  });

  it("escapes the free-text detail in the HTML body", () => {
    const mail = securityNotificationEmail("owner@example.com", {
      detail: '<img src=x onerror="alert(1)">',
      what: "passkey_removed",
      when,
    });
    expect(mail.htmlBody).not.toContain("<img");
    expect(mail.htmlBody).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(mail.textBody).toContain('Details: <img src=x onerror="alert(1)">');
  });

  it("has a line for every change kind, with no detail line when there is none", () => {
    for (const what of [
      "passkey_added",
      "passkey_removed",
      "totp_enabled",
      "totp_disabled",
      "two_factor_disabled",
    ] as const) {
      const mail = securityNotificationEmail("owner@example.com", { what, when });
      expect(mail.textBody).toContain("FrameOS Cloud account");
      expect(mail.textBody).not.toContain("Details:");
    }
  });

  it("goes through the mailer (Postmark when configured)", async () => {
    process.env.POSTMARK_SERVER_TOKEN = "tok";
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await sendSecurityNotificationEmail("owner@example.com", { what: "totp_enabled", when });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<string, string>;
    expect(body.To).toBe("owner@example.com");
    expect(body.Subject).toBe("Your FrameOS Cloud sign-in security changed");
    expect(body.TextBody).toContain("An authenticator app was enabled");
  });
});
