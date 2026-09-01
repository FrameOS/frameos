import Link from "next/link";
import { formatBytes } from "../lib/format";
import type { AccountUsage } from "../lib/usage";

// The account header's storage summary: one small capacity meter per quota
// bucket instead of the old single-line sentence. Server-rendered, no JS —
// the bars are plain divs whose width is the fill percentage. Colors stay
// on the shared tokens (globals.css .storage-usage rules), so they follow
// the light/dark theme; the numbers next to each bar carry the exact state,
// the color shift at 80%/95% is reinforcement, not the only signal.

interface MeterBucket {
  bytes: number;
  label: string;
  maxBytes: number;
  // Frames are counted, not measured — same meter, different words on the
  // right-hand side. Anything else formats as bytes.
  unit?: "frames";
}

function meterValue(bucket: MeterBucket): string {
  return bucket.unit === "frames"
    ? `${bucket.bytes} / ${bucket.maxBytes}`
    : `${formatBytes(bucket.bytes)} / ${formatBytes(bucket.maxBytes)}`;
}

function meterFill(bucket: MeterBucket) {
  const percent = bucket.maxBytes > 0 ? (bucket.bytes / bucket.maxBytes) * 100 : 0;
  return {
    className:
      percent >= 95
        ? "storage-usage__fill storage-usage__fill--critical"
        : percent >= 80
          ? "storage-usage__fill storage-usage__fill--warning"
          : "storage-usage__fill",
    // A 100 MB quota with 3 KB used rounds to 0% — keep a visible sliver so
    // "there is something here" still reads.
    width: bucket.bytes > 0 ? `${Math.max(1.5, Math.min(100, percent))}%` : "0",
  };
}

// The AI row's words. Four zero states, and each one means something
// different: nothing used yet, the switch is off (§5.1), every turn ran on
// the account's own OpenAI key (they owe us nothing, and a bill-shaped zero
// would be a lie rather than a number), and — while metering is in shadow
// mode — a real figure that is nevertheless not being charged. See
// cloud/docs/accounting-todo.md §5.2.
function aiUsageValue(ai: AccountUsage["ai"]): { note?: string; value: string } {
  if (!ai.enabled) {
    return { value: "off" };
  }
  const micros = BigInt(ai.month_micros);
  if (micros === 0n) {
    return ai.own_key_only
      ? { value: "on your own key" }
      : { value: "$0.00 this month" };
  }
  const value = `${formatDollars(micros)} this month`;
  // "Billed" needs both: metering actually posting, and something in the
  // month that is billable to them. A month spent entirely on the operator's
  // shared key owes nothing, and a bare dollar figure would imply otherwise.
  const billed = ai.metering_mode === "live" && BigInt(ai.billable_micros) > 0n;
  return billed ? { value } : { note: "not billed", value };
}

// Micro-dollars to a displayed amount, rounding UP to the cent: a tenth of a
// cent of usage should read as $0.01, not as nothing at all.
function formatDollars(micros: bigint): string {
  const cents = (micros + 9_999n) / 10_000n;
  return `$${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, "0")}`;
}

export function StorageUsageMeters({
  aiHref = "/account/ai",
  usage,
}: {
  aiHref?: string;
  usage: AccountUsage;
}) {
  const totalBytes =
    usage.scenes.private_bytes +
    usage.scenes.public_bytes +
    usage.backups.bytes +
    usage.frame_logs.bytes;
  const meters: MeterBucket[] = [
    // First, because it is the quota people actually meet: storage is
    // generous, frames are a countable thing you add one at a time.
    {
      bytes: usage.frames.count,
      label: "Frames",
      maxBytes: usage.frames.max_count,
      unit: "frames",
    },
    {
      bytes: usage.scenes.private_bytes,
      label: "Private scenes",
      maxBytes: usage.scenes.private_max_bytes,
    },
    { bytes: usage.backups.bytes, label: "Backups", maxBytes: usage.backups.max_bytes },
    {
      bytes: usage.frame_logs.bytes,
      label: "Frame logs",
      maxBytes: usage.frame_logs.max_bytes,
    },
  ];

  return (
    <div className="storage-usage">
      <div className="storage-usage__total">
        {/* Named, because an unnamed limit reads as a bug the first time you
            meet it. Every number below is deployment-tunable
            (FRAMEOS_CLOUD_MAX_*), so a paid tier raises them without a code
            change — see src/lib/usage.ts. */}
        <span className="storage-usage__total-label">Free plan · storage used</span>
        <span className="storage-usage__total-value">{formatBytes(totalBytes)}</span>
      </div>
      {meters.map((bucket) => {
        const fill = meterFill(bucket);
        return (
          <div
            className="storage-usage__row"
            key={bucket.label}
            title={`${bucket.label}: ${meterValue(bucket).replace(" / ", " of ")}`}
          >
            <span className="storage-usage__label">{bucket.label}</span>
            <span className="storage-usage__track">
              <span className={fill.className} style={{ width: fill.width }} />
            </span>
            <span className="storage-usage__value">{meterValue(bucket)}</span>
          </div>
        );
      })}
      {/* AI usage: a label and a figure, no meter, linking to the page that
          breaks it down and holds the off switch. */}
      <Link className="storage-usage__link" href={aiHref}>
        <span className="storage-usage__label">AI usage</span>
        <span className="storage-usage__note">{aiUsageValue(usage.ai).note ?? ""}</span>
        <span className="storage-usage__value">{aiUsageValue(usage.ai).value}</span>
      </Link>
      {usage.scenes.public_bytes > 0 ? (
        <div className="storage-usage__row" title="Published public scenes don't count against any quota">
          <span className="storage-usage__label">Public scenes</span>
          <span />
          <span className="storage-usage__value">
            {formatBytes(usage.scenes.public_bytes)} · free
          </span>
        </div>
      ) : null}
    </div>
  );
}
