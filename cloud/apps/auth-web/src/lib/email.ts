// Minimal transactional email support. With no Postmark token configured
// (local development), the message body is written to the server log instead
// so the reset flow stays fully exercisable without an email provider.
//
// Everything here throws on failure and lets the caller decide; the two
// callers that matter (email-verification.ts, api/auth/reset/request) report
// into error tracking rather than swallowing, because a silent send failure
// blocks logins for everyone who signs up during it.

import { logInfo } from "./log";

type EmailMessage = {
  htmlBody: string;
  subject: string;
  textBody: string;
  to: string;
};

export async function sendEmail(message: EmailMessage) {
  const serverToken = process.env.POSTMARK_SERVER_TOKEN?.trim();
  if (!serverToken) {
    // The body goes to the log verbatim: in development this IS the delivery
    // mechanism — the reset/verification link is read out of the journal.
    logInfo("email.not_sent_no_provider", {
      body: message.textBody,
      subject: message.subject,
      to: message.to,
    });
    return;
  }

  const from =
    process.env.POSTMARK_FROM_EMAIL?.trim() ||
    "FrameOS Cloud <auth@frameos.net>";
  const response = await fetch("https://api.postmarkapp.com/email", {
    body: JSON.stringify({
      From: from,
      HtmlBody: message.htmlBody,
      MessageStream: "outbound",
      Subject: message.subject,
      TextBody: message.textBody,
      To: message.to,
    }),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-postmark-server-token": serverToken,
    },
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    // Surface Postmark's error message (e.g. "account pending approval",
    // "signature not confirmed") — the bare status code hides the cause.
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Postmark send failed: ${response.status} ${detail.slice(0, 300)}`,
    );
  }
}

export type EmailDeliveryStatus = {
  detail: string;
  state: "ok" | "warning" | "failing" | "not_configured";
};

// Live probe for the /admin panel. "Is POSTMARK_SERVER_TOKEN set" (the static
// system check) does not answer the question that actually matters — a token
// can be set and still be revoked, pointed at a Sandbox server that silently
// drops every message, or attached to an account Postmark has suspended. All
// three block every signup, and all three look identical from the outside.
//
// Never throws: the admin page shows the failure rather than 500ing on it.
export async function checkEmailDelivery(): Promise<EmailDeliveryStatus> {
  const serverToken = process.env.POSTMARK_SERVER_TOKEN?.trim();
  if (!serverToken) {
    return {
      detail: "No POSTMARK_SERVER_TOKEN — mail is written to the log instead.",
      state: "not_configured",
    };
  }

  try {
    const response = await fetch("https://api.postmarkapp.com/server", {
      headers: {
        accept: "application/json",
        "x-postmark-server-token": serverToken,
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      return {
        detail: `Postmark rejected the token: ${response.status} ${detail}`,
        state: "failing",
      };
    }

    const server = (await response.json()) as {
      DeliveryType?: string;
      Name?: string;
    };
    // A Sandbox server accepts every send and delivers nothing. It is the
    // failure mode that looks healthiest from here, so call it out loudly.
    if (server.DeliveryType && server.DeliveryType !== "Live") {
      return {
        detail: `Postmark server "${server.Name}" is in ${server.DeliveryType} mode — messages are accepted but never delivered.`,
        state: "failing",
      };
    }

    return {
      detail: `Postmark server "${server.Name ?? "unknown"}" is live.`,
      state: "ok",
    };
  } catch (error) {
    return {
      detail: `Could not reach Postmark: ${error instanceof Error ? error.message : "unknown error"}`,
      state: "failing",
    };
  }
}

export async function sendEmailVerificationEmail(
  to: string,
  verifyUrl: string,
) {
  await sendEmail({
    htmlBody: [
      "<p>Welcome to FrameOS Cloud! Confirm that this email address is yours.</p>",
      `<p><a href="${verifyUrl}">Verify email address</a></p>`,
      "<p>The link is valid for 24 hours. If you did not create this account, you can ignore this email.</p>",
    ].join("\n"),
    subject: "Verify your FrameOS Cloud email",
    textBody: [
      "Welcome to FrameOS Cloud! Confirm that this email address is yours.",
      "",
      `Verify email address: ${verifyUrl}`,
      "",
      "The link is valid for 24 hours. If you did not create this account, you can ignore this email.",
    ].join("\n"),
    to,
  });
}

export async function sendPasswordResetEmail(to: string, resetUrl: string) {
  await sendEmail({
    htmlBody: [
      "<p>A password reset was requested for your FrameOS Cloud account.</p>",
      `<p><a href="${resetUrl}">Choose a new password</a></p>`,
      "<p>The link is valid for one hour and can be used once. If you did not request this, you can ignore this email.</p>",
    ].join("\n"),
    subject: "Reset your FrameOS Cloud password",
    textBody: [
      "A password reset was requested for your FrameOS Cloud account.",
      "",
      `Choose a new password: ${resetUrl}`,
      "",
      "The link is valid for one hour and can be used once. If you did not request this, you can ignore this email.",
    ].join("\n"),
    to,
  });
}
