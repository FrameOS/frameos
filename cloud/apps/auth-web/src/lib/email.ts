// Minimal transactional email support. With no Postmark token configured
// (local development), the message body is written to the server log instead
// so the reset flow stays fully exercisable without an email provider.

type EmailMessage = {
  htmlBody: string;
  subject: string;
  textBody: string;
  to: string;
};

export async function sendEmail(message: EmailMessage) {
  const serverToken = process.env.POSTMARK_SERVER_TOKEN?.trim();
  if (!serverToken) {
    console.info(
      `email (not sent, POSTMARK_SERVER_TOKEN unset) to=${message.to} subject=${message.subject}\n${message.textBody}`,
    );
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
