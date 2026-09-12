// @vitest-environment jsdom
//
// The long-running task toast: the latest log line runs the full width of
// the toast under the title row, drawn the way the Logs panel draws a line
// (tone dot, timestamp, coloured text) on a log-coloured strip — not
// truncated in the text column beside the Logs / expand / dismiss buttons.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LongRunningTaskToasts } from "../../../../../../frontend/src/components/LongRunningTaskToasts";
import { initKea } from "../../../../../../frontend/src/initKea";
import { longRunningTasksModel } from "../../../../../../frontend/src/models/longRunningTasksModel";
import type { FrameId, LogType } from "../../../../../../frontend/src/types";

const frameId = 14 as unknown as FrameId;

function log(line: string, type = "stdout"): LogType {
  return { id: 1, timestamp: "2026-09-12T10:00:00Z", ip: "", type, line, frame_id: frameId };
}

type TestWindow = Window & { FRAMEOS_EMBEDDED_NO_BACKEND?: boolean };
const testWindow = window as TestWindow;

beforeEach(() => {
  // No websocket, no first-user probe: the models under test talk to the
  // mocked fetch only.
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  document.body.innerHTML = '<div id="popper"></div><div id="root"></div>';
  initKea();
  longRunningTasksModel.mount();
});

afterEach(() => {
  cleanup();
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
  longRunningTasksModel.unmount();
});

describe("the long-running task toast", () => {
  it("shows the latest log line as a log line across the whole toast", () => {
    longRunningTasksModel.actions.startTask({ frameId, kind: "deploy", title: "Deploy frame" });
    longRunningTasksModel.actions.appendTaskLog(log("> upload progress: 16 MiB / 23 MiB"));
    render(<LongRunningTaskToasts />);

    const line = screen.getByText("> upload progress: 16 MiB / 23 MiB");
    const strip = line.closest(".font-mono") as HTMLElement | null;
    expect(strip).toBeTruthy();
    // The strip is a full-width row of the toast: a sibling of the header
    // row that holds the buttons, not something nested beside them.
    const logsLink = screen.getByRole("link", { name: "All logs" });
    expect(strip!.contains(logsLink)).toBe(false);
    expect(strip!.parentElement!.contains(logsLink)).toBe(true);
    expect(strip!.parentElement!.contains(screen.getByText("Deploy frame"))).toBe(true);
    // Drawn like a log line: a timestamp beside the text.
    expect(strip!.textContent).toMatch(/\d\d:\d\d:\d\d/);
  });

  it("shows the finished task's verdict on the same strip", () => {
    longRunningTasksModel.actions.startTask({ frameId, kind: "deploy", title: "Deploy frame" });
    longRunningTasksModel.actions.appendTaskLog(log("> upload progress: 23 MiB / 23 MiB"));
    longRunningTasksModel.actions.finishTask({ frameId, kind: "deploy", status: "success", detail: "Deployed" });
    render(<LongRunningTaskToasts />);

    const line = screen.getByText("Deployed");
    expect(line.closest(".font-mono")).toBeTruthy();
    expect(screen.queryByText("> upload progress: 23 MiB / 23 MiB")).toBeNull();
  });
});
