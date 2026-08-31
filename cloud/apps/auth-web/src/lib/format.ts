// Client-safe display helpers (no server-only imports): used by both server
// components and the admin table client components.

export function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) {
      break;
    }
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

// Dates are rendered unambiguously ("9 Jul 2026") instead of locale-dependent
// numeric formats like 7/9/2026, which read differently across countries.
// Deterministic output also keeps server-rendered HTML stable across locales.
const months = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function formatDate(date: Date) {
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

export function formatDateTime(date: Date) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${formatDate(date)}, ${hours}:${minutes}`;
}

// Micro-dollars as money. Amounts arrive as bigints on the server and as
// decimal strings in client props — bigint does not survive React's
// serialization boundary, and JSON's single number type loses integers above
// 2^53, so the string form is the one that crosses.
export function formatMicrosUsd(micros: bigint | string): string {
  const value = typeof micros === "bigint" ? micros : BigInt(micros || "0");
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 1_000_000n;
  const cents = (absolute % 1_000_000n) / 10_000n;
  const remainder = absolute % 10_000n;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  // Sub-cent precision matters here: a single metered turn can cost a
  // fraction of a cent, and rounding it away in the books would make a page
  // of them add up to something the ledger does not say.
  const fraction =
    remainder === 0n
      ? String(cents).padStart(2, "0")
      : (absolute % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}$${grouped}.${fraction}`;
}
