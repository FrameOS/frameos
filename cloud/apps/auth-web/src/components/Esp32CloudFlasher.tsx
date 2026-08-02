"use client";

import { Usb, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";

// Browser flasher for cloud-managed ESP32 frames (docs/cloud-frames.md,
// "ESP32 browser flashing"): WebSerial + esptool-js writes the prebuilt
// GENERIC firmware from the GitHub release (no credentials baked in), then
// provisions cloud_url + claim_token (+ optional WiFi) over the device's
// serial console. The claim token is single-use and short-lived; nothing
// per-user ever enters the firmware binary.
//
// Both the release listing and the firmware bytes come from this cloud's own
// /api/frames/firmware route: GitHub's release redirect sends no CORS headers,
// and unauthenticated api.github.com is rate-limited per IP (one office NAT is
// enough to 403 everyone behind it).

const firmwareApiUrl = "/api/frames/firmware";
const firmwarePlatform = "esp32-s3-epd7in5v2";
// The panel is compiled into the firmware, so this build drives the Waveshare
// 7.5" V2 panel only — see the esp32 job in docker-publish-multi.yml.
const genericFirmwareSuffix = "-esp32-s3-epd7in5v2.bin";
const flashBaudrate = 460800;
const consoleBaudrate = 115200;

// The console prompt has no trailing space (fos_console.c: `printf("frameos>")`).
const consolePrompt = "frameos>";
// cmd_wifi prints "wifi credentials saved, restarting..." before esp_restart().
const rebootNotice = "restarting";
const bootPromptTimeoutMs = 20000;
const commandPromptTimeoutMs = 10000;
const rebootAckTimeoutMs = 5000;

// 802.11 limits, and both fit the device's 128-byte config fields.
const maxSsidLength = 32;
const maxPasswordLength = 64;
// A newline would end the console line and start a second command; no other
// control character survives the serial console either. (A character class
// would say the same, but eslint's no-control-regex bans it in a regex.)
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

type FlashPhase =
  | "idle"
  | "fetching"
  | "connecting"
  | "flashing"
  | "provisioning"
  | "done"
  | "error";

interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}

interface ConsoleCommand {
  // What to show in the log — secrets are redacted there, not on the wire.
  display: string;
  // Substring the console prints back once the command took effect: its prompt
  // after `set`, the reboot notice after `wifi`, nothing at all after
  // `restart` (cmd_restart resets without printing anything).
  expect: string | undefined;
  // Whether a missing acknowledgement means the command failed. Reboot
  // commands print theirs while the board is already resetting, so that line
  // can legitimately be lost in the USB TX buffer.
  required: boolean;
  text: string;
}

// esp_console_split_argv (ESP-IDF components/console/split_argv.c, reached via
// esp_console_run in fos_console.c) understands double quotes and backslash
// escapes: inside "…" a space is a literal space, and the only recognized
// escapes are \\, \" and backslash-space — any other escape is silently
// dropped, so nothing else may be emitted. Quoting the
// whole value and escaping backslashes and quotes is exactly expressible, and
// an SSID like `My Home WiFi` arrives as one argv entry.
function quoteConsoleArgument(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

// Validated before anything is downloaded or flashed: half-provisioning a
// board and then failing is much worse than refusing up front.
export function wifiInputError(
  ssid: string,
  password: string,
): string | undefined {
  if (hasControlCharacter(ssid) || hasControlCharacter(password)) {
    return "WiFi name and password can't contain line breaks or control characters.";
  }
  if (ssid.length > maxSsidLength) {
    return `WiFi network name must be at most ${maxSsidLength} characters.`;
  }
  if (password.length > maxPasswordLength) {
    return `WiFi password must be at most ${maxPasswordLength} characters.`;
  }
  if (!ssid && password) {
    return "Enter the WiFi network name for that password.";
  }
  return undefined;
}

interface FirmwareAsset {
  name: string;
  platform: string;
  size: number;
}

async function fetchGenericFirmware(
  log: (line: string) => void,
): Promise<Uint8Array> {
  log("Looking up the latest FrameOS release…");
  const releaseResponse = await fetch(firmwareApiUrl);
  if (!releaseResponse.ok) {
    throw new Error(`Release lookup failed (${releaseResponse.status})`);
  }
  const release = (await releaseResponse.json()) as {
    assets?: FirmwareAsset[];
    release?: string;
  };
  const asset = release.assets?.find(
    (entry) => entry.platform === firmwarePlatform,
  );
  if (!asset) {
    throw new Error(
      `Release ${release.release || "?"} has no ${genericFirmwareSuffix} asset yet — it ships with the first release after cloud frames landed. You can flash manually via embedded/esp32 instead.`,
    );
  }
  log(`Downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)…`);
  const firmwareResponse = await fetch(
    `${firmwareApiUrl}?platform=${encodeURIComponent(firmwarePlatform)}`,
  );
  if (!firmwareResponse.ok) {
    throw new Error(`Firmware download failed (${firmwareResponse.status})`);
  }
  return new Uint8Array(await firmwareResponse.arrayBuffer());
}

// Send console commands over the freshly flashed firmware's serial REPL and
// wait for its prompt output. The console echoes results; we scan for
// substrings rather than parsing the esp_console framing.
async function provisionOverSerial(
  port: SerialPortLike,
  commands: ConsoleCommand[],
  log: (line: string) => void,
): Promise<void> {
  await port.open({ baudRate: consoleBaudrate });
  const writer = port.writable?.getWriter();
  const reader = port.readable?.getReader();
  try {
    if (!writer || !reader) {
      throw new Error("Serial port has no readable/writable stream");
    }
    const decoder = new TextDecoder();
    let buffer = "";
    // Exactly one read() may be outstanding at a time. Racing a fresh read()
    // against a timer and walking away leaves that read pending — it still
    // resolves later, and its chunk (possibly the one carrying the prompt) is
    // lost. So the pending promise is kept and re-awaited until it settles.
    let pendingRead:
      | Promise<{ result: ReadableStreamReadResult<Uint8Array>; tag: "read" }>
      | undefined;
    const readUntil = async (needle: string, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      if (buffer.includes(needle)) {
        return true;
      }
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return false;
        }
        pendingRead ??= reader
          .read()
          .then((result) => ({ result, tag: "read" as const }));
        let timer: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
          pendingRead,
          new Promise<{ tag: "timeout" }>((resolve) => {
            timer = setTimeout(() => resolve({ tag: "timeout" }), remaining);
          }),
        ]);
        clearTimeout(timer);
        if (outcome.tag === "timeout") {
          // Keep pendingRead: its bytes are still coming.
          continue;
        }
        pendingRead = undefined;
        if (outcome.result.done) {
          // The device closed the stream; no further bytes will arrive.
          return buffer.includes(needle);
        }
        if (outcome.result.value) {
          buffer += decoder.decode(outcome.result.value, { stream: true });
          if (buffer.includes(needle)) {
            return true;
          }
        }
      }
    };

    // Wait for the console to come up after reset (boot logs then prompt).
    log("Waiting for the FrameOS console…");
    if (!(await readUntil(consolePrompt, bootPromptTimeoutMs))) {
      throw new Error(
        "The flashed firmware never showed its FrameOS console prompt, so nothing was provisioned. Unplug the board, plug it back in and try again.",
      );
    }
    for (const command of commands) {
      log(`> ${command.display}`);
      buffer = "";
      await writer.write(new TextEncoder().encode(command.text + "\n"));
      if (command.expect === undefined) {
        continue;
      }
      const acknowledged = await readUntil(
        command.expect,
        command.required ? commandPromptTimeoutMs : rebootAckTimeoutMs,
      );
      if (acknowledged) {
        continue;
      }
      if (command.required) {
        // Every result used to be discarded, so a board that never booted a
        // console was still reported as provisioned.
        throw new Error(
          `The frame never acknowledged \`${command.display}\`, so it is not fully provisioned. Try flashing again.`,
        );
      }
      log(
        "(No reboot confirmation seen — the board may have reset before it finished printing.)",
      );
    }
  } finally {
    // Hand the streams back even when a step threw, or the port stays locked
    // and the offered retry fails with "port already open" until a replug.
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // Already errored/closed — nothing to cancel.
      }
      try {
        reader.releaseLock();
      } catch {
        // Ditto.
      }
    }
    try {
      writer?.releaseLock();
    } catch {
      // Ditto.
    }
    try {
      await port.close();
    } catch {
      // Some firmware resets close the port on their own.
    }
  }
}

export function Esp32CloudFlasher({ frameName }: { frameName?: string | undefined }) {
  const [phase, setPhase] = useState<FlashPhase>("idle");
  const [lines, setLines] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [cloudUrl] = useState(() =>
    typeof window !== "undefined"
      ? window.location.origin
      : "https://cloud.frameos.net",
  );
  const [wifiSsid, setWifiSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const busyRef = useRef(false);

  // WebSerial support is a client-only fact: decide it after mount so the
  // server and the hydrating client render the same fallback first.
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    setSupported("serial" in navigator);
  }, []);

  function log(line: string) {
    setLines((previous) => [...previous.slice(-200), line]);
  }

  // Enrollment codes are plumbing, not UX: mint a fresh single-use code per
  // flash, provision it over serial, never show it to the user.
  async function mintEnrollmentCode(): Promise<string> {
    const response = await fetch("/api/frames/claim-tokens", {
      body: JSON.stringify(frameName ? { name: frameName } : {}),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const data = (await response.json().catch(() => ({}))) as {
      claim_token?: string;
      error?: string;
    };
    if (!response.ok || !data.claim_token) {
      throw new Error(
        data.error === "frame_quota_exceeded"
          ? "You've reached the frame limit for this account."
          : "Could not prepare the enrollment — are you still signed in?",
      );
    }
    return data.claim_token;
  }

  async function flash() {
    if (busyRef.current) {
      return;
    }
    const inputError = wifiInputError(wifiSsid, wifiPassword);
    if (inputError) {
      setError(inputError);
      setPhase("error");
      return;
    }
    busyRef.current = true;
    setLines([]);
    setError(undefined);
    setProgress(0);
    try {
      setPhase("fetching");
      const firmware = await fetchGenericFirmware(log);

      setPhase("connecting");
      log("Pick the USB serial port of your ESP32…");
      const serial = (
        navigator as unknown as {
          serial: { requestPort(): Promise<SerialPortLike> };
        }
      ).serial;
      const port = await serial.requestPort();

      setPhase("flashing");
      const { ESPLoader, Transport } = await import("esptool-js");
      const transport = new Transport(port as never, false);
      const loader = new ESPLoader({
        baudrate: flashBaudrate,
        romBaudrate: 115200,
        transport,
      } as never);
      try {
        await loader.main();
        log(`Connected: ${loader.chip?.CHIP_NAME ?? "ESP32"}`);
        // esptool-js wants binary strings; convert in chunks.
        let binary = "";
        const chunkSize = 0x8000;
        for (let offset = 0; offset < firmware.length; offset += chunkSize) {
          binary += String.fromCharCode(
            ...firmware.subarray(offset, offset + chunkSize),
          );
        }
        await loader.writeFlash({
          compress: true,
          eraseAll: false,
          fileArray: [{ address: 0x0, data: binary }],
          flashFreq: "keep",
          flashMode: "keep",
          flashSize: "keep",
          reportProgress: (_index: number, written: number, total: number) => {
            setProgress(Math.round((written / total) * 100));
          },
        } as never);
        log("Firmware written. Resetting…");
        await loader.after();
      } finally {
        // Always give the port back, including on a mid-flash throw: esptool-js
        // holds the WebSerial reader/writer, and provisioning (or a retry)
        // needs to reopen the same port.
        try {
          await transport.disconnect();
        } catch {
          // Never mask the flash error with a teardown error.
        }
      }

      setPhase("provisioning");
      // Minted here, not at the start: claim tokens are single-use and there is
      // no revoke endpoint, so minting before the download/connect/flash burned
      // one code per failed attempt. Now nothing is spent unless the firmware
      // is actually on the board and only the serial handshake is left.
      log("Preparing a one-time enrollment for this frame…");
      const token = await mintEnrollmentCode();
      const commands: ConsoleCommand[] = [
        {
          display: `set cloud_url ${cloudUrl}`,
          expect: consolePrompt,
          required: true,
          text: `set cloud_url ${quoteConsoleArgument(cloudUrl)}`,
        },
        {
          display: "set claim_token (redacted)",
          expect: consolePrompt,
          required: true,
          text: `set claim_token ${quoteConsoleArgument(token)}`,
        },
      ];
      if (wifiSsid) {
        // `wifi` saves credentials and reboots; enrollment starts on boot.
        commands.push({
          display: wifiPassword
            ? `wifi ${wifiSsid} (password redacted)`
            : `wifi ${wifiSsid}`,
          expect: rebootNotice,
          required: false,
          text: wifiPassword
            ? `wifi ${quoteConsoleArgument(wifiSsid)} ${quoteConsoleArgument(wifiPassword)}`
            : `wifi ${quoteConsoleArgument(wifiSsid)}`,
        });
      } else {
        commands.push({
          display: "restart",
          expect: undefined,
          required: false,
          text: "restart",
        });
      }
      await provisionOverSerial(port, commands, log);

      setPhase("done");
      log(
        wifiSsid
          ? "Done. The frame joins WiFi, enrolls, and appears above as pending — confirm it there."
          : "Done. Connect the frame to WiFi (serial: `wifi <ssid> <pass>` or the FrameOS-Setup portal); it then enrolls and appears above as pending.",
      );
    } catch (flashError) {
      const message =
        flashError instanceof Error ? flashError.message : String(flashError);
      setPhase("error");
      setError(message);
      log(`Error: ${message}`);
    } finally {
      busyRef.current = false;
    }
  }

  if (!supported) {
    return (
      <p className="copy">
        <Usb aria-hidden size={16} /> Browser flashing needs WebSerial
        (Chrome/Edge on desktop). You can still provision over a serial
        console — see the ESP32 tile above.
      </p>
    );
  }

  const busy =
    phase !== "idle" && phase !== "error" && phase !== "done";

  return (
    <div className="card">
      <h4>
        <Zap aria-hidden size={18} /> Flash an ESP32 from this browser
      </h4>
      <p className="copy">
        Plug the board in over USB and click flash — it writes the generic
        FrameOS firmware and links the frame to this account automatically.
      </p>
      <div className="grid" style={{ gap: "0.5rem" }}>
        <input
          aria-label="WiFi network"
          className="input"
          disabled={busy}
          maxLength={maxSsidLength}
          onChange={(event) => setWifiSsid(event.target.value)}
          placeholder="WiFi network (optional — portal works too)"
          value={wifiSsid}
        />
        <input
          aria-label="WiFi password"
          className="input"
          disabled={busy}
          maxLength={maxPasswordLength}
          onChange={(event) => setWifiPassword(event.target.value)}
          placeholder="WiFi password"
          type="password"
          value={wifiPassword}
        />
        <div className="inline-actions">
          <button
            className="button button--small"
            disabled={busy}
            onClick={() => void flash()}
            type="button"
          >
            <Usb aria-hidden size={16} />
            {phase === "flashing"
              ? `Flashing ${progress}%`
              : phase === "provisioning"
                ? "Provisioning…"
                : phase === "fetching" || phase === "connecting"
                  ? "Preparing…"
                  : "Connect & flash"}
          </button>
        </div>
      </div>
      {error ? (
        <p className="copy" role="alert" style={{ color: "var(--warning)" }}>
          {error}
        </p>
      ) : null}
      {phase === "done" ? <div data-testid="esp32-flash-done" /> : null}
      {lines.length > 0 ? (
        <pre
          className="copy"
          role="status"
          style={{ maxHeight: "12rem", overflow: "auto" }}
        >
          {lines.join("\n")}
        </pre>
      ) : null}
    </div>
  );
}
