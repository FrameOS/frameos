// Fire-and-forget Discord webhook notifications for operational events
// (scene reports and the like). No-op unless DISCORD_REPORTS_WEBHOOK_URL is
// configured; failures are logged and never surface to the user — a broken
// webhook must not break the flow that triggered it.

import { errorField, logWarn } from "./log";

export async function notifyDiscord(content: string) {
  const webhookUrl = process.env.DISCORD_REPORTS_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    return;
  }
  try {
    const response = await fetch(webhookUrl, {
      body: JSON.stringify({
        // Never ping anyone, whatever ends up in user-supplied text.
        allowed_mentions: { parse: [] },
        content: content.slice(0, 1900),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      logWarn("discord.webhook_rejected", {
        detail: (await response.text().catch(() => "")).slice(0, 200),
        status: response.status,
      });
    }
  } catch (error) {
    logWarn("discord.webhook_failed", { error: errorField(error) });
  }
}
