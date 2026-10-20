import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  pendingCommandLabel,
  type FramePendingCommand,
} from "../../../../../../frontend/src/scenes/workspace/framePendingCommandsLogic";

// docs/ui-vocabulary.md: install / push / deploy / preview / update / sync /
// activate are the verbs; "upgrade" and "redeploy" are runtime names that
// never reach a label, and scenes alone are pushed, never deployed. The e2e
// specs pin the words the drawers show; this scans the source so a new label
// with a banned verb fails before it ships.

const repoRoot = resolve(__dirname, "../../../../../..");
const frontendSrc = resolve(repoRoot, "frontend/src");

// A banned verb right after a quote, a backtick, a JSX `>` or a `{' ` text
// opener — i.e. at the start of a user-visible string — and not as part of a
// longer identifier (`UpgradeApiError`).
const bannedLabelStart = /(['"`>]|\{'\s)(Upgrade|Upgrades|Upgrading|Re-deploy|Redeploy)\b/;
// The same verbs inside a sentence, applied to the things this UI deploys or
// updates ("then upgrade the firmware").
const bannedPhrase = /\b(upgrade|upgrades|upgrading) (the )?(scenes?|settings|firmware|FrameOS)\b/;
// "Deploy" with scenes alone as its object: that is a push ("Push scenes"),
// while "Deploy scenes & settings" is a deploy. Settings are never pushed.
const deployedScenes =
  /\b(Deploy|deploy|Deploys|deploys|Deploying|deploying|Deployed|deployed) (the |its |this |these |\d+ |\$\{[^}]+\} )?scenes?\b(?! (&|&amp;|and) settings)/;
const pushedSettings = /\b(Push|push|Pushes|pushes|Pushing|pushing|Pushed|pushed) (the |its )?settings\b/;

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
  it("keeps upgrade / redeploy out of every user-visible string in frontend/src, and scenes pushed", () => {
    const hits: string[] = [];
    for (const file of sourceFiles(frontendSrc)) {
      const lines = labelLines(readFileSync(file, "utf8"));
      lines.forEach((line, index) => {
        if (
          bannedLabelStart.test(line) ||
          bannedPhrase.test(line) ||
          deployedScenes.test(line) ||
          pushedSettings.test(line)
        ) {
          hits.push(`${relative(repoRoot, file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it("names a queued set_scenes command a push and set_settings a deploy", () => {
    const command = (type: string): FramePendingCommand => ({ id: type, type }) as unknown as FramePendingCommand;
    expect(pendingCommandLabel(command("set_scenes"))).toBe("Push scenes");
    expect(pendingCommandLabel(command("set_settings"))).toBe("Deploy settings");
    expect(pendingCommandLabel(command("set_schedule"))).toBe("Update the schedule");
    expect(pendingCommandLabel(command("notify_update_available"))).toBe("Check for a firmware update");
  });
});
