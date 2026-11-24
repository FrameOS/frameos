// What one device socket may send before the hub stops listening to it.
//
// Every enrolled frame is untrusted (docs/cloud-frames.md, threat model), and
// the hub handles a session's messages one at a time: each arrival is chained
// behind the one before, and several kinds cost a database round trip. A
// socket that sends faster than its messages are handled therefore queued
// without bound, every waiting message held in memory (up to maxPayloadBytes
// each). This is the bound: a token bucket on arrivals and a cap on what is
// waiting. Past either the socket is closed; a frame reconnects with its own
// backoff, behind the upgrade throttle.
//
// The numbers clear the fastest thing a working frame does, which is stream
// a file back (asset_chunk): an ESP32 sends 24 KiB chunks as fast as its
// Wi-Fi takes them, a hundred or so a second at the very best, and a 6 MiB
// panel picture is 250 of them in one go; a Pi sends 1 MiB chunks. Mid-stream
// chunks are handled without a database call, so they rarely wait; but a
// whole file can arrive while the one before it is still being stored, so
// the backlog has room for nearly three of the largest file the hub
// assembles (maxAssetFileBytes, 8 MiB: 11 MiB and 342 ESP32 chunks as
// base64). That is no more than a session may already hold in open asset
// streams. Everything else a frame says (acks, logs every 2 s, state,
// metrics) is a handful of messages a second.
export interface InboundLimits {
  /** Messages allowed at once on top of the sustained rate. */
  burst: number;
  /** Sustained messages a second. */
  perSecond: number;
  /** Messages received and not yet handled. */
  backlogMessages: number;
  /** Bytes of those messages. */
  backlogBytes: number;
}

export const deviceInboundLimits: InboundLimits = {
  backlogBytes: 32 * 1024 * 1024,
  backlogMessages: 1024,
  burst: 2000,
  perSecond: 500,
};

export type InboundRefusal = "message_backlog" | "message_rate";

export class InboundGuard {
  private tokens: number;
  private refilledAt: number;
  private waiting = 0;
  private waitingBytes = 0;

  constructor(
    private readonly limits: InboundLimits = deviceInboundLimits,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = limits.burst;
    this.refilledAt = now();
  }

  /** A message arrived. Returns why the socket must close, or undefined when
   *  the message may be queued (then `handled` must be called for it). */
  admit(bytes: number): InboundRefusal | undefined {
    const now = this.now();
    const elapsed = Math.max(0, now - this.refilledAt);
    this.refilledAt = now;
    this.tokens = Math.min(
      this.limits.burst,
      this.tokens + (elapsed / 1000) * this.limits.perSecond,
    );
    if (this.tokens < 1) {
      return "message_rate";
    }
    if (
      this.waiting >= this.limits.backlogMessages ||
      this.waitingBytes + bytes > this.limits.backlogBytes
    ) {
      return "message_backlog";
    }
    this.tokens -= 1;
    this.waiting += 1;
    this.waitingBytes += bytes;
    return undefined;
  }

  /** The message `admit` let through has been handled. */
  handled(bytes: number) {
    this.waiting = Math.max(0, this.waiting - 1);
    this.waitingBytes = Math.max(0, this.waitingBytes - bytes);
  }

  get backlog() {
    return { bytes: this.waitingBytes, messages: this.waiting };
  }
}

/** The size of one `ws` message as it was received. */
export function inboundBytes(data: unknown): number {
  if (typeof data === "string") {
    return Buffer.byteLength(data);
  }
  if (Buffer.isBuffer(data)) {
    return data.length;
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  if (Array.isArray(data)) {
    return data.reduce(
      (total: number, part) => total + (Buffer.isBuffer(part) ? part.length : 0),
      0,
    );
  }
  return 0;
}
