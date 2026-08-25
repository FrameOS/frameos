// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewLog } from "./PreviewLog";

// Virtuoso measures its scroller and rows; jsdom has no layout, so the list
// becomes a plain map over the data (the row rendering is what is tested).
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    components,
    computeItemKey,
    data,
    itemContent,
  }: {
    components?: { EmptyPlaceholder?: () => React.ReactNode };
    computeItemKey: (index: number, item: unknown) => string;
    data: unknown[];
    itemContent: (index: number, item: unknown) => React.ReactNode;
  }) => (
    <div data-testid="virtuoso">
      {data.length === 0
        ? components?.EmptyPlaceholder?.()
        : data.map((item, index) => (
            <div key={computeItemKey(index, item)}>{itemContent(index, item)}</div>
          ))}
    </div>
  ),
}));

afterEach(cleanup);

const receivedAt = new Date(2026, 7, 25, 10, 30, 15).getTime();

describe("PreviewLog", () => {
  it("shows the placeholder when there is nothing yet", () => {
    render(<PreviewLog lines={[]} />);
    expect(screen.getByText("No logs yet")).toBeTruthy();
  });

  it("renders a JSON line as timestamp, event tag and key=value pairs", () => {
    render(
      <PreviewLog
        lines={[
          {
            id: 0,
            line: '{"event":"render:done","sceneId":"analog-clock-face","ms":208.0}',
            receivedAt,
          },
        ]}
      />,
    );
    const row = document.querySelector(".preview-log__row")!;
    expect(row.classList.contains("preview-log__row--info")).toBe(true);
    expect(row.querySelector(".preview-log__time")!.textContent).toBe("2026-08-25 10:30:15");
    expect(row.querySelector(".preview-log__event")!.textContent).toBe("render:done");
    const keys = Array.from(row.querySelectorAll(".preview-log__key")).map((el) => el.textContent);
    expect(keys).toEqual(["sceneId=", "ms="]);
    const values = Array.from(row.querySelectorAll(".preview-log__value")).map(
      (el) => el.textContent,
    );
    expect(values).toEqual(['"analog-clock-face"', "208"]);
    // Break opportunities inside values, after ":" "," "/".
    render(
      <PreviewLog
        lines={[{ id: 1, line: '{"event":"fetch","url":"https://a.b/c,d"}', receivedAt }]}
      />,
    );
    const value = document.querySelectorAll(".preview-log__value")[2]!;
    expect(value.querySelectorAll("wbr").length).toBe(5);
    expect(value.textContent).toBe('"https://a.b/c,d"');
  });

  it("shows plain text as-is and tints error rows", () => {
    render(
      <PreviewLog
        lines={[
          { id: 0, line: 'scene "Analog clock face" initialized', receivedAt },
          { id: 1, line: "error: Worker crashed", receivedAt },
          { id: 2, line: '{"event":"fetch:warn","url":"x"}', receivedAt },
        ]}
      />,
    );
    const rows = document.querySelectorAll(".preview-log__row");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.classList.contains("preview-log__row--info")).toBe(true);
    expect(rows[0]!.querySelector(".preview-log__event")).toBeNull();
    expect(rows[0]!.querySelector(".preview-log__body")!.textContent).toBe(
      'scene "Analog clock face" initialized',
    );
    expect(rows[1]!.classList.contains("preview-log__row--error")).toBe(true);
    expect(rows[1]!.querySelector(".preview-log__event")!.textContent).toBe("error");
    expect(rows[1]!.querySelector(".preview-log__value")!.textContent).toBe("Worker crashed");
    expect(rows[2]!.classList.contains("preview-log__row--warn")).toBe(true);
  });
});
