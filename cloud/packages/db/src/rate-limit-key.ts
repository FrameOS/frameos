// What a per-address rate limit counts by.
//
// One IPv6 customer, residential or hosted, holds a /64 at the least: 2^64
// addresses to send from. A limit keyed on the whole address is no limit for
// them, so the key is the address's /64. An IPv4 address is its own key,
// also when it arrives IPv4-mapped (::ffff:192.0.2.1). Anything that is not
// an IPv6 address (the limiter's "untrusted" and "local" keys, a name) is
// returned as it came.
//
// Only for counting. The address shown in an audit row, or handed to
// Turnstile, stays the whole one.
export function rateLimitAddressKey(address: string): string {
  let text = address.trim().toLowerCase();
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    text = text.slice(1, end === -1 ? undefined : end);
  }
  const zone = text.indexOf("%");
  if (zone !== -1) {
    text = text.slice(0, zone);
  }
  const groups = ipv6Groups(text);
  if (!groups) {
    return address;
  }
  const mapped =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (mapped) {
    const high = groups[6]!;
    const low = groups[7]!;
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

// The eight 16-bit groups of an IPv6 address in text, or undefined when the
// text is not one.
function ipv6Groups(text: string): number[] | undefined {
  if (!text.includes(":") || !/^[0-9a-f:.]+$/.test(text)) {
    return undefined;
  }
  const halves = text.split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const parse = (half: string): number[] | undefined => {
    if (half === "") {
      return [];
    }
    const out: number[] = [];
    const parts = half.split(":");
    for (const [index, part] of parts.entries()) {
      if (part.includes(".")) {
        // A dotted quad is only ever the last 32 bits.
        const quad = part.split(".");
        if (index !== parts.length - 1 || quad.length !== 4) {
          return undefined;
        }
        const bytes = quad.map((byte) => (/^\d{1,3}$/.test(byte) ? Number(byte) : 256));
        if (bytes.some((byte) => byte > 255)) {
          return undefined;
        }
        out.push((bytes[0]! << 8) | bytes[1]!, (bytes[2]! << 8) | bytes[3]!);
      } else if (/^[0-9a-f]{1,4}$/.test(part)) {
        out.push(Number.parseInt(part, 16));
      } else {
        return undefined;
      }
    }
    return out;
  };
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !tail) {
    return undefined;
  }
  if (halves.length === 1) {
    return head.length === 8 ? head : undefined;
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 1) {
    return undefined;
  }
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}
