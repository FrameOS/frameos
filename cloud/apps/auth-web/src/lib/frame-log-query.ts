// The query half of GET /api/frames/{id}/logs, kept free of Next and the
// database so the parsing can be pinned on its own. The route used to serve
// one fixed page (the newest 1000 rows, or everything after a cursor) and
// left narrowing to the caller — the MCP's frame_logs pulled the whole
// window to keep five lines. Now the page size, a text filter and a lower
// time bound travel as query parameters and the database does the cutting.

export const maxLogsPerPage = 1000;
export const maxLogSearchLength = 200;

export type FrameLogQuery = {
  /** Rows strictly after this id (oldest first); undefined = newest page. */
  afterId: number | undefined;
  /** Page size, 1..maxLogsPerPage; the old fixed page when absent. */
  limit: number;
  /** Case-insensitive substring of the stored payload; undefined = none. */
  search: string | undefined;
  /** Rows at or after this instant; undefined = none. */
  since: Date | undefined;
};

export function parseFrameLogQuery(params: URLSearchParams): FrameLogQuery {
  const afterIdRaw = params.get("after_id");
  const parsedAfterId =
    afterIdRaw === null ? Number.NaN : Number.parseInt(afterIdRaw, 10);
  // after_id=0 is a real cursor ("everything from the beginning"), not an
  // absent one — id is a generated identity starting at 1, so a truthiness
  // check would silently drop the filter.
  const afterId =
    Number.isFinite(parsedAfterId) && parsedAfterId >= 0
      ? parsedAfterId
      : undefined;

  const limitRaw = params.get("limit");
  const parsedLimit =
    limitRaw === null ? Number.NaN : Number.parseInt(limitRaw, 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(maxLogsPerPage, Math.max(1, parsedLimit))
    : maxLogsPerPage;

  const searchRaw = params.get("search")?.trim() ?? "";
  const search = searchRaw ? searchRaw.slice(0, maxLogSearchLength) : undefined;

  const sinceRaw = params.get("since");
  const sinceParsed = sinceRaw ? new Date(sinceRaw) : undefined;
  const since =
    sinceParsed && Number.isFinite(sinceParsed.getTime()) ? sinceParsed : undefined;

  return { afterId, limit, search, since };
}

/**
 * The LIKE pattern for a substring search: the needle's own `%`, `_` and
 * `\` are literal characters, not wildcards.
 */
export function logSearchPattern(needle: string): string {
  return `%${needle.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
