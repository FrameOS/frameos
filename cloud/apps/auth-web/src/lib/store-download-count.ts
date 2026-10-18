// `download_count` is meant as "how many installs", and every GET of the zip
// used to add one: a HEAD, a retry, one address fetching in a loop. Without
// a table (a row per download is more than this number is worth), a scene
// counts at most once per client address per UTC day in this process. A
// restart forgets the day, and installs behind one NAT count once: both can
// only undercount, and the number is a curation signal, not a ledger.
const maxRemembered = 50_000;

let rememberedDay = "";
const counted = new Set<string>();

export function shouldCountDownload(
  sceneId: string,
  clientKey: string,
  now: Date = new Date(),
): boolean {
  const day = now.toISOString().slice(0, 10);
  if (day !== rememberedDay) {
    rememberedDay = day;
    counted.clear();
  }
  const key = `${sceneId} ${clientKey}`;
  if (counted.has(key)) {
    return false;
  }
  // Bounded memory: past the cap the day starts over, which lets an address
  // count again rather than letting the set grow without end.
  if (counted.size >= maxRemembered) {
    counted.clear();
  }
  counted.add(key);
  return true;
}

export function resetDownloadCountsForTests() {
  rememberedDay = "";
  counted.clear();
}
