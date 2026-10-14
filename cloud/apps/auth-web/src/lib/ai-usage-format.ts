// Formatting shared by the usage page's server half (AiUsageSections) and
// its client half (RecentAiRequests). No server imports here on purpose:
// the client bundle pulls this file in.

// Micro-dollars to dollars, rounding UP to the cent: a tenth of a cent of
// usage should read as $0.01, never as nothing at all. Negative amounts (a
// credit in the customer's favour) keep their sign.
export function dollars(micros: bigint): string {
  const negative = micros < 0n;
  const absolute = negative ? -micros : micros;
  const cents = (absolute + 9_999n) / 10_000n;
  return `${negative ? "-" : ""}$${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, "0")}`;
}

// Surface slugs are for the database. These are for people. The surface is
// the gate's own name for the route (never the client's — §9.2 item 1), so
// this map is the gate's argument names, one label each.
const surfaceLabels: Record<string, string> = {
  app_chat: "App code assistant",
  scene_chat: "Scene chat",
  scene_convert: "Scene converter",
  store_classify: "Store classification",
  store_recategorize: "Store recategorisation",
};

export function surfaceLabel(surface: string | null): string {
  if (!surface) {
    return "Other";
  }
  return surfaceLabels[surface] ?? surface.replace(/_/g, " ");
}
