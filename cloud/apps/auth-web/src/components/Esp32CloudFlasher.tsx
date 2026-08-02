"use client";

import { Usb, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";

// Browser flasher for cloud-managed ESP32 frames (docs/cloud-frames.md,
// "ESP32 browser flashing"): WebSerial + esptool-js writes the prebuilt
// GENERIC firmware from the GitHub release (no credentials baked in), then
// provisions cloud_url + claim_token (+ optional WiFi) over the device's
// serial console. The claim token is single-use and short-lived; nothing
// per-user ever enters the firmware binary.

const releaseApiUrl =
  "https://api.github.com/repos/FrameOS/frameos/releases/latest";
const genericFirmwareSuffix = "-esp32-s3-generic.bin";
const flashBaudrate = 460800;
const consoleBaudrate = 115200;

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

async function fetchGenericFirmware(
  log: (line: string) => void,
): Promise<Uint8Array> {
  log("Looking up the latest FrameOS release…");
  const releaseResponse = await fetch(releaseApiUrl, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!releaseResponse.ok) {
    throw new Error(`GitHub release lookup failed (${releaseResponse.status})`);
  }
  const release = (await releaseResponse.json()) as {
    assets?: { browser_download_url: string; name: string; size: number }[];
    tag_name?: string;
  };
  const asset = release.assets?.find((entry) =>
    entry.name.endsWith(genericFirmwareSuffix),
  );
  if (!asset) {
    throw new Error(
      `Release ${release.tag_name ?? "?"} has no ${genericFirmwareSuffix} asset yet — it ships with the first release after cloud frames landed. You can flash manually via embedded/esp32 instead.`,
    );
  }
  log(`Downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)…`);
  const firmwareResponse = await fetch(asset.browser_download_url);
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
  commands: string[],
  log: (line: string) => void,
): Promise<void> {
  await port.open({ baudRate: consoleBaudrate });
  try {
    const writer = port.writable?.getWriter();
    const reader = port.readable?.getReader();
    if (!writer || !reader) {
      throw new Error("Serial port has no readable/writable stream");
    }
    const decoder = new TextDecoder();
    let buffer = "";
    const readUntil = async (needle: string, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const result = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((resolve) =>
            setTimeout(() => resolve({ done: true, value: undefined }), 500),
          ),
        ]);
        if (result.value) {
          buffer += decoder.decode(result.value, { stream: true });
          if (buffer.includes(needle)) {
            return true;
          }
        }
      }
      return false;
    };

    // Wait for the console to come up after reset (boot logs then prompt).
    log("Waiting for the FrameOS console…");
    await readUntil("frameos>", 20000);
    for (const command of commands) {
      const display = command.startsWith("set claim_token")
        ? "set claim_token (redacted)"
        : command.startsWith("set wifi_pass")
          ? "set wifi_pass (redacted)"
          : command;
      log(`> ${display}`);
      buffer = "";
      await writer.write(new TextEncoder().encode(command + "\n"));
      await readUntil("frameos>", 10000);
    }
    writer.releaseLock();
    reader.releaseLock();
  } finally {
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
    busyRef.current = true;
    setLines([]);
    setProgress(0);
    try {
      setPhase("fetching");
      log("Preparing a one-time enrollment for this frame…");
      const token = await mintEnrollmentCode();
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
      await transport.disconnect();

      setPhase("provisioning");
      const commands = [
        `set cloud_url ${cloudUrl}`,
        `set claim_token ${token}`,
      ];
      if (wifiSsid) {
        // `wifi` saves credentials and reboots; enrollment starts on boot.
        commands.push(
          wifiPassword ? `wifi ${wifiSsid} ${wifiPassword}` : `wifi ${wifiSsid}`,
        );
      } else {
        commands.push("restart");
      }
      await provisionOverSerial(port, commands, log);

      setPhase("done");
      log(
        wifiSsid
          ? "Done. The frame joins WiFi, enrolls, and appears above as pending — confirm it there."
          : "Done. Connect the frame to WiFi (serial: `wifi <ssid> <pass>` or the FrameOS-Setup portal); it then enrolls and appears above as pending.",
      );
    } catch (error) {
      setPhase("error");
      log(`Error: ${error instanceof Error ? error.message : String(error)}`);
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
          className="input"
          onChange={(event) => setWifiSsid(event.target.value)}
          placeholder="WiFi network (optional — portal works too)"
          value={wifiSsid}
        />
        <input
          className="input"
          onChange={(event) => setWifiPassword(event.target.value)}
          placeholder="WiFi password"
          type="password"
          value={wifiPassword}
        />
        <div className="inline-actions">
          <button
            className="button button--small"
            disabled={phase !== "idle" && phase !== "error" && phase !== "done"}
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
      {lines.length > 0 ? (
        <pre
          className="copy"
          style={{ maxHeight: "12rem", overflow: "auto" }}
        >
          {lines.join("\n")}
        </pre>
      ) : null}
    </div>
  );
}
