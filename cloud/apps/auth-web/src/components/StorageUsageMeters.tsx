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
    // A 200 MB quota with 3 KB used rounds to 0% — keep a visible sliver so
    // "there is something here" still reads.
    width: bucket.bytes > 0 ? `${Math.max(1.5, Math.min(100, percent))}%` : "0",
  };
}

export function StorageUsageMeters({ usage }: { usage: AccountUsage }) {
  const totalBytes =
    usage.scenes.private_bytes +
    usage.scenes.public_bytes +
    usage.backups.bytes +
    usage.frame_logs.bytes;
  const meters: MeterBucket[] = [
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
        <span className="storage-usage__total-label">Storage used</span>
        <span className="storage-usage__total-value">{formatBytes(totalBytes)}</span>
      </div>
      {meters.map((bucket) => {
        const fill = meterFill(bucket);
        return (
          <div
            className="storage-usage__row"
            key={bucket.label}
            title={`${bucket.label}: ${formatBytes(bucket.bytes)} of ${formatBytes(bucket.maxBytes)}`}
          >
            <span className="storage-usage__label">{bucket.label}</span>
            <span className="storage-usage__track">
              <span className={fill.className} style={{ width: fill.width }} />
            </span>
            <span className="storage-usage__value">
              {formatBytes(bucket.bytes)} / {formatBytes(bucket.maxBytes)}
            </span>
          </div>
        );
      })}
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
