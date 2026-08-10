// The MetricsType row shape the shared SPA expects (frontend/src/types.tsx),
// mirroring the backend's Metrics.to_dict(): string id, timezone-aware ISO
// timestamp, the frame's id and the raw sample. Shared by /metrics and
// /metrics/recent so the two pages of the same history serialize identically.
export function metricsRow(
  frameId: string,
  row: { id: number; timestamp: Date; payload: unknown },
) {
  return {
    frame_id: frameId,
    id: String(row.id),
    metrics: row.payload,
    timestamp: row.timestamp.toISOString(),
  };
}
