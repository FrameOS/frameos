import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  pendingCommandLabel,
  type FramePendingCommand,
} from "../../../../../../frontend/src/scenes/workspace/framePendingCommandsLogic";

// docs/ui-vocabulary.md: install / deploy / update / sync / activate are the
// verbs; "push", "upgrade" and "redeploy" are protocol and runtime names that
// never reach a label. The e2e specs pin the words the drawers show; this
// scans the source so a new label with a banned verb fails before it ships.

const repoRoot = resolve(__dirname, "../../../../../..");
const frontendSrc = resolve(repoRoot, "frontend/src");

// A banned verb right after a quote, a backtick, a JSX `>` or a `{' ` text
// opener — i.e. at the start of a user-visible string — and not as part of a
// longer identifier (`UpgradeApiError`).
const bannedLabelStart =
  /(['"`>]|\{'\s)(Push|Pushes|Pushing|Pushed|Upgrade|Upgrades|Upgrading|Re-deploy|Redeploy)\b/;
// The same verbs inside a sentence, applied to the things this UI deploys or
// updates ("Also push scenes & settings", "then push the scenes").
const bannedPhrase = /\b(push|pushes|pushing|upgrade|upgrades|upgrading) (the )?(scenes?|settings|firmware|FrameOS)\b/;

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

function labelLines(source: string): string[] {
  // Drop block comments, then line comments; what is left is code and JSX.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/\s.*$/, ""));
}

describe("frame action vocabulary", () => {
  it("keeps push / upgrade / redeploy out of every user-visible string in frontend/src", () => {
    const hits: string[] = [];
    for (const file of sourceFiles(frontendSrc)) {
      const lines = labelLines(readFileSync(file, "utf8"));
      lines.forEach((line, index) => {
        if (bannedLabelStart.test(line) || bannedPhrase.test(line)) {
          hits.push(`${relative(repoRoot, file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it("names a queued set_scenes / set_settings command a deploy", () => {
    const command = (type: string): FramePendingCommand => ({ id: type, type }) as unknown as FramePendingCommand;
    expect(pendingCommandLabel(command("set_scenes"))).toBe("Deploy scenes");
    expect(pendingCommandLabel(command("set_settings"))).toBe("Deploy settings");
    expect(pendingCommandLabel(command("set_schedule"))).toBe("Update the schedule");
    expect(pendingCommandLabel(command("notify_update_available"))).toBe("Check for a firmware update");
  });
});
