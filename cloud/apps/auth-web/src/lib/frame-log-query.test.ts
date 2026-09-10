import { describe, expect, it } from "vitest";
import { logSearchPattern, maxLogsPerPage, parseFrameLogQuery } from "./frame-log-query";

describe("parseFrameLogQuery", () => {
  it("defaults to the old fixed page with no filters", () => {
    expect(parseFrameLogQuery(new URLSearchParams())).toEqual({
      afterId: undefined,
      limit: maxLogsPerPage,
      search: undefined,
      since: undefined,
    });
  });

  it("keeps after_id=0 as a cursor", () => {
    expect(parseFrameLogQuery(new URLSearchParams("after_id=0")).afterId).toBe(0);
    expect(parseFrameLogQuery(new URLSearchParams("after_id=-1")).afterId).toBeUndefined();
    expect(parseFrameLogQuery(new URLSearchParams("after_id=x")).afterId).toBeUndefined();
  });

  it("bounds the page size", () => {
    expect(parseFrameLogQuery(new URLSearchParams("limit=5")).limit).toBe(5);
    expect(parseFrameLogQuery(new URLSearchParams("limit=0")).limit).toBe(1);
    expect(parseFrameLogQuery(new URLSearchParams("limit=999999")).limit).toBe(maxLogsPerPage);
    expect(parseFrameLogQuery(new URLSearchParams("limit=abc")).limit).toBe(maxLogsPerPage);
  });

  it("trims and caps the search text", () => {
    expect(parseFrameLogQuery(new URLSearchParams("search=%20error%20")).search).toBe("error");
    expect(parseFrameLogQuery(new URLSearchParams("search=%20%20")).search).toBeUndefined();
    expect(parseFrameLogQuery(new URLSearchParams(`search=${"a".repeat(300)}`)).search).toHaveLength(200);
  });

  it("parses since as an instant and drops garbage", () => {
    expect(parseFrameLogQuery(new URLSearchParams("since=2026-09-10T10:00:00Z")).since?.toISOString()).toBe(
      "2026-09-10T10:00:00.000Z",
    );
    expect(parseFrameLogQuery(new URLSearchParams("since=yesterday")).since).toBeUndefined();
  });
});

describe("logSearchPattern", () => {
  it("escapes LIKE wildcards in the needle", () => {
    expect(logSearchPattern("error")).toBe("%error%");
    expect(logSearchPattern("100%_done\\")).toBe("%100\\%\\_done\\\\%");
  });
});
