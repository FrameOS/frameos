// A local stand-in for Creem's test mode, for working on the paid plans
// without a Creem account (cloud/docs/billing.md "Without a Creem account"):
//
//   pnpm --filter @frameos-cloud/auth-web creem:fake
//
// and in the dev server's environment:
//
//   CREEM_API_KEY=creem_test_fake
//   CREEM_WEBHOOK_SECRET=whsec_fake
//   CREEM_API_URL=http://localhost:4010
//
// It answers the API calls src/lib/creem.ts makes, serves a checkout page
// and a billing portal with buttons for what a buyer and the calendar do
// (pay, renew, fail a payment, cancel, refund), and posts the signed
// webhooks to the dev server. It is our reading of Creem's documentation,
// not Creem: before going live, run the same flow against Creem's real test
// mode.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreemFake } from "../src/test/creem-fake";

const port = Number(process.env.CREEM_FAKE_PORT ?? 4010);
const origin = `http://localhost:${port}`;
const webhookUrl = process.env.CREEM_FAKE_WEBHOOK_URL ?? "http://localhost:3000/api/webhooks/creem";
const fake = new CreemFake({
  apiKey: process.env.CREEM_API_KEY ?? "creem_test_fake",
  baseUrl: origin,
  taxPercent: Number(process.env.CREEM_FAKE_TAX_PERCENT ?? 21),
  webhookSecret: process.env.CREEM_WEBHOOK_SECRET ?? "whsec_fake",
});

// Its products and subscriptions outlive a restart, or every product id the
// dev database holds would point at nothing.
const stateFile = process.env.CREEM_FAKE_STATE ?? join(tmpdir(), "frameos-creem-fake.json");
if (existsSync(stateFile)) {
  try {
    fake.restore(readFileSync(stateFile, "utf8"));
  } catch {
    console.warn(`Ignoring unreadable state in ${stateFile}`);
  }
}

function save() {
  writeFileSync(stateFile, fake.snapshot());
}

const log: string[] = [];

async function deliverWebhooks() {
  for (const delivery of fake.takeDeliveries()) {
    try {
      const response = await fetch(webhookUrl, {
        body: delivery.body,
        headers: { "content-type": "application/json", "creem-signature": delivery.signature },
        method: "POST",
      });
      log.unshift(`${new Date().toISOString()} ${delivery.eventType} -> ${response.status}`);
    } catch (error) {
      log.unshift(
        `${new Date().toISOString()} ${delivery.eventType} -> not delivered (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  log.splice(50);
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>
<style>
body { font: 16px/1.5 system-ui, sans-serif; max-width: 44rem; margin: 3rem auto; padding: 0 1rem; color: #1c1c1c; background: #fafaf7; }
.banner { background: #fff3c4; border: 1px solid #e0c060; border-radius: 8px; padding: .6rem .9rem; margin-bottom: 1.5rem; font-size: 14px; }
.card { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 1rem 1.2rem; margin: 1rem 0; }
button { font: inherit; padding: .5rem .9rem; border-radius: 6px; border: 1px solid #999; background: #fff; cursor: pointer; margin: .2rem .4rem .2rem 0; }
button.primary { background: #1c1c1c; color: #fff; border-color: #1c1c1c; }
form { display: inline; }
code, pre { font-size: 13px; }
h1 { font-size: 22px; } h2 { font-size: 17px; margin: 0 0 .4rem; }
.muted { color: #666; font-size: 14px; }
</style></head><body>
<div class="banner">This is a local stand-in for Creem's test mode. No card is involved and nothing is charged.</div>
${body}</body></html>`;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function post(action: string, label: string, primary = false): string {
  return `<form method="post" action="${escape(action)}"><button${primary ? ' class="primary"' : ""}>${escape(label)}</button></form>`;
}

function checkoutPage(checkoutId: string): string | null {
  const checkout = fake.checkouts.get(checkoutId);
  const product = checkout ? fake.products.get(checkout.productId) : undefined;
  if (!checkout || !product) {
    return null;
  }
  if (checkout.status === "completed") {
    return page("Checkout", `<h1>This checkout was already paid</h1>`);
  }
  return page(
    "Checkout",
    `<h1>${escape(product.name)}</h1>
<div class="card"><p>${escape(product.description)}</p>
<p><strong>${money(product.priceCents)}</strong> a month, plus tax.</p>
<p class="muted">Buying as ${escape(checkout.customer.email ?? checkout.customer.id ?? "a new customer")}.</p>
${post(`/checkout/${checkout.id}/pay`, "Pay with the test card", true)}
<p class="muted">To see a declined card, close this tab: an unpaid checkout changes nothing.</p></div>`,
  );
}

function portalPage(customerId: string): string | null {
  const customer = fake.customers.get(customerId);
  if (!customer) {
    return null;
  }
  const cards = [...fake.subscriptions.values()]
    .filter((subscription) => subscription.customerId === customer.id)
    .map((subscription) => {
      const product = fake.products.get(subscription.productId);
      const base = `/portal/${customer.id}/${subscription.id}`;
      const live = subscription.status !== "canceled";
      return `<div class="card"><h2>${escape(product?.name ?? subscription.productId)}</h2>
<p>Status <code>${escape(subscription.status)}</code>, paid until ${escape(subscription.periodEnd.toISOString().slice(0, 10))}.</p>
${
  live
    ? `${post(`${base}/end-period`, "A month passes (renew, or end if cancelling)")}
${post(`${base}/fail`, "The next payment fails")}
${post(`${base}/cancel`, "Cancel now")}`
    : ""
}
${subscription.lastTransactionId ? post(`${base}/refund`, "Refund the last payment") : ""}</div>`;
    })
    .join("");
  return page(
    "Billing",
    `<h1>Billing for ${escape(customer.email)}</h1>${cards || "<p>No subscriptions.</p>"}
<h2>Webhooks sent</h2><pre>${escape(log.join("\n") || "none yet")}</pre>
<p><a href="${escape(process.env.CREEM_FAKE_RETURN_URL ?? "http://localhost:3000/account/usage")}">Back to FrameOS Cloud</a></p>`,
  );
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, status: number, body: string, type = "text/html; charset=utf-8") {
  response.writeHead(status, { "cache-control": "no-store", "content-type": type });
  response.end(body);
}

function redirect(response: ServerResponse, location: string) {
  response.writeHead(303, { location });
  response.end();
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", origin);
  const method = (request.method ?? "GET").toUpperCase();
  try {
    if (url.pathname.startsWith("/v1/")) {
      const body = method === "GET" ? undefined : await readBody(request);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === "string") {
          headers.set(key, value);
        }
      }
      const answer = await fake.fetch(url.toString(), { ...(body ? { body } : {}), headers, method });
      send(response, answer.status, await answer.text(), "application/json");
      save();
      // An API call can cause notices too (a cancellation, a plan change).
      void deliverWebhooks();
      return;
    }

    const checkout = /^\/checkout\/([^/]+)(\/pay)?$/.exec(url.pathname);
    if (checkout) {
      const id = checkout[1] ?? "";
      if (method === "POST" && checkout[2]) {
        const returnUrl = fake.completeCheckout(id);
        save();
        // Webhooks first, as they usually land before the browser is back.
        await deliverWebhooks();
        redirect(response, returnUrl);
        return;
      }
      const html = checkoutPage(id);
      send(response, html ? 200 : 404, html ?? page("Not found", "<h1>No such checkout</h1>"));
      return;
    }

    const portal = /^\/portal\/([^/]+)(?:\/([^/]+)\/(end-period|fail|cancel|refund))?$/.exec(url.pathname);
    if (portal) {
      const customerId = portal[1] ?? "";
      const subscriptionId = portal[2];
      if (method === "POST" && subscriptionId) {
        if (portal[3] === "end-period") {
          fake.endPeriod(subscriptionId);
        } else if (portal[3] === "fail") {
          fake.failRenewal(subscriptionId);
        } else if (portal[3] === "cancel") {
          fake.cancelNow(subscriptionId);
        } else {
          const transactionId = fake.subscriptions.get(subscriptionId)?.lastTransactionId;
          if (transactionId) {
            fake.refund(transactionId);
          }
        }
        save();
        await deliverWebhooks();
        redirect(response, `/portal/${customerId}`);
        return;
      }
      const html = portalPage(customerId);
      send(response, html ? 200 : 404, html ?? page("Not found", "<h1>No such customer</h1>"));
      return;
    }

    send(
      response,
      200,
      page(
        "Creem stand-in",
        `<h1>Creem stand-in</h1><p>${fake.products.size} products, ${fake.subscriptions.size} subscriptions. Webhooks go to <code>${escape(webhookUrl)}</code>.</p>
${[...fake.customers.values()].map((customer) => `<p><a href="/portal/${customer.id}">${escape(customer.email)}</a></p>`).join("")}
<h2>Webhooks sent</h2><pre>${escape(log.join("\n") || "none yet")}</pre>`,
      ),
    );
  } catch (error) {
    send(response, 500, page("Error", `<h1>Error</h1><pre>${escape(String(error))}</pre>`));
  }
}).listen(port, () => {
  console.log(`Creem stand-in on ${origin}, webhooks to ${webhookUrl}`);
  console.log(`State is kept in ${stateFile}. Delete it to start over.`);
});
