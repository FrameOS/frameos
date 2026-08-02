"use client";

import { Download, HardDrive } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  renderCloudConfig,
  sanitizeConfigValue,
  SdImagePatchError,
  patchCloudConfig,
} from "../lib/sd-image-patch";

// "Download SD image" for cloud-managed Raspberry Pi frames
// (docs/cloud-frames.md, "Placeholder + in-browser personalization"): the
// browser fetches the GENERIC .img.gz release asset, stream-decompresses it,
// and rewrites the 4096-byte frameos-cloud.txt placeholder on the boot
// partition with this cloud's URL, a multi-use claim code, and (optionally)
// WiFi credentials — entirely client-side, so credentials never reach the
// server. If the release image has no placeholder the UI falls back to the
// manual instructions below.

const releaseApiUrl =
  "https://api.github.com/repos/FrameOS/frameos/releases/latest";

const knownBoards = [
  { label: "Raspberry Pi Zero 2 W", platform: "raspberry-pi-zero-2-w" },
  { label: "Raspberry Pi Zero W", platform: "raspberry-pi-zero-w" },
] as const;

interface ReleaseAsset {
  browser_download_url: string;
  name: string;
  size: number;
}

interface Board {
  asset?: ReleaseAsset | undefined;
  label: string;
  platform: string;
}

type ReleaseState =
  | { status: "loading" }
  | { message: string; status: "error" }
  | { boards: Board[]; status: "ready"; version: string };

type BuildPhase = "idle" | "building" | "done" | "error";

// File System Access API (Chrome/Edge); not yet in lib.dom.
interface WritableImageStream {
  abort(): Promise<void>;
  close(): Promise<void>;
  write(data: Uint8Array): Promise<void>;
}

type SaveFilePicker = (options: {
  suggestedName?: string;
  types?: { accept: Record<string, string[]>; description?: string }[];
}) => Promise<{ createWritable(): Promise<WritableImageStream> }>;

async function* streamChunks(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array, void, undefined> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      if (value && value.length > 0) {
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function SdImageBuilder({
  claimToken,
  claimTokenExpiresAt,
  mintClaimToken,
}: {
  claimToken?: string | undefined;
  claimTokenExpiresAt?: string | undefined;
  mintClaimToken: (opts: { multiUse: boolean }) => Promise<string>;
}) {
  const [release, setRelease] = useState<ReleaseState>({ status: "loading" });
  const [platform, setPlatform] = useState("");
  const [frameName, setFrameName] = useState("");
  const [wifiSsid, setWifiSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const [phase, setPhase] = useState<BuildPhase>("idle");
  const [status, setStatus] = useState("");
  const [progressBytes, setProgressBytes] = useState(0);
  const [error, setError] = useState<string | undefined>();
  const [manualOpen, setManualOpen] = useState(false);
  const busyRef = useRef(false);

  const origin =
    typeof window !== "undefined"
      ? window.location.origin
      : "https://cloud.frameos.net";
  const supported =
    typeof DecompressionStream !== "undefined" &&
    typeof ReadableStream !== "undefined";
  const canStreamToDisk =
    typeof window !== "undefined" && "showSaveFilePicker" in window;

  useEffect(() => {
    let cancelled = false;
    async function loadRelease() {
      try {
        const response = await fetch(releaseApiUrl, {
          headers: { accept: "application/vnd.github+json" },
        });
        if (!response.ok) {
          throw new Error(`GitHub release lookup failed (${response.status})`);
        }
        const data = (await response.json()) as {
          assets?: ReleaseAsset[];
          tag_name?: string;
        };
        if (cancelled) {
          return;
        }
        const boards: Board[] = knownBoards.map((board) => ({
          asset: data.assets?.find(
            (asset) =>
              asset.name.startsWith("frameos-") &&
              asset.name.endsWith(`-${board.platform}-buildroot.img.gz`),
          ),
          label: board.label,
          platform: board.platform,
        }));
        setRelease({
          boards,
          status: "ready",
          version: data.tag_name ?? "latest",
        });
        const firstAvailable = boards.find((board) => board.asset);
        if (firstAvailable) {
          setPlatform((current) => current || firstAvailable.platform);
        }
      } catch (loadError) {
        if (!cancelled) {
          setRelease({
            message:
              loadError instanceof Error
                ? loadError.message
                : String(loadError),
            status: "error",
          });
        }
      }
    }
    void loadRelease();
    return () => {
      cancelled = true;
    };
  }, []);

  function failToFallback(message: string) {
    setError(message);
    setManualOpen(true);
    setPhase("error");
  }

  async function build() {
    if (busyRef.current || release.status !== "ready") {
      return;
    }
    const board = release.boards.find((entry) => entry.platform === platform);
    if (!board?.asset) {
      setError("Pick a board with a published image first.");
      setPhase("error");
      return;
    }
    busyRef.current = true;
    setError(undefined);
    setProgressBytes(0);
    setPhase("building");
    let writable: WritableImageStream | undefined;
    try {
      // Validate user input before opening the save dialog.
      sanitizeConfigValue(frameName, "Frame name");
      sanitizeConfigValue(wifiSsid, "WiFi network name");
      sanitizeConfigValue(wifiPassword, "WiFi password");

      const suggestedName = `frameos-${board.platform}-${slugify(frameName) || "cloud"}.img`;
      // Ask for the save location first, while the click's user activation is
      // still fresh (Chrome/Edge; other browsers fall back to a Blob).
      if (canStreamToDisk) {
        const picker = (
          window as unknown as { showSaveFilePicker: SaveFilePicker }
        ).showSaveFilePicker;
        try {
          const handle = await picker({
            suggestedName,
            types: [
              {
                accept: { "application/octet-stream": [".img"] },
                description: "Disk image",
              },
            ],
          });
          writable = await handle.createWritable();
        } catch (pickerError) {
          if (
            pickerError instanceof DOMException &&
            pickerError.name === "AbortError"
          ) {
            setPhase("idle");
            return;
          }
          throw pickerError;
        }
      }

      let token = claimToken;
      if (!token) {
        setStatus("Creating a multi-use claim code…");
        token = await mintClaimToken({ multiUse: true });
      }
      const configBytes = renderCloudConfig({
        claimToken: token,
        cloudUrl: origin,
        name: frameName,
        wifiPassword: wifiSsid ? wifiPassword : "",
        wifiSsid,
      });

      setStatus(`Downloading ${board.asset.name}…`);
      const response = await fetch(board.asset.browser_download_url);
      if (!response.ok || !response.body) {
        throw new Error(`Image download failed (${response.status})`);
      }
      const decompressed = response.body.pipeThrough(
        new DecompressionStream("gzip"),
      );

      setStatus("Personalizing and writing the image…");
      const blobParts: Uint8Array[] = [];
      let written = 0;
      let lastShown = 0;
      for await (const chunk of patchCloudConfig(
        streamChunks(decompressed),
        configBytes,
      )) {
        if (writable) {
          await writable.write(chunk);
        } else {
          blobParts.push(chunk);
        }
        written += chunk.length;
        if (written - lastShown >= 8 * 1024 * 1024) {
          lastShown = written;
          setProgressBytes(written);
        }
      }
      setProgressBytes(written);
      if (writable) {
        await writable.close();
        writable = undefined;
      } else {
        const blob = new Blob(blobParts as BlobPart[], {
          type: "application/octet-stream",
        });
        blobParts.length = 0;
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = suggestedName;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      setPhase("done");
    } catch (buildError) {
      if (writable) {
        try {
          await writable.abort();
        } catch {
          // Best effort — the partial file is discarded either way.
        }
      }
      if (
        buildError instanceof SdImagePatchError &&
        (buildError.code === "marker_not_found" ||
          buildError.code === "placeholder_invalid" ||
          buildError.code === "truncated_image")
      ) {
        failToFallback(
          "This release image doesn't support in-browser personalization yet — flash the generic image and create the file manually (instructions below).",
        );
      } else {
        setError(
          buildError instanceof Error ? buildError.message : String(buildError),
        );
        setPhase("error");
      }
    } finally {
      busyRef.current = false;
    }
  }

  const building = phase === "building";
  const progressMb = (progressBytes / 1024 / 1024).toFixed(0);

  return (
    <div>
      {supported ? (
        <>
          <p className="copy">
            Build a ready-to-flash image for your board right here: it embeds
            this cloud&apos;s address and a multi-use claim code. WiFi
            credentials are written into the image in your browser — they are
            never sent to FrameOS Cloud.
          </p>
          {release.status === "loading" ? (
            <p className="copy">Looking up the latest FrameOS release…</p>
          ) : null}
          {release.status === "error" ? (
            <p className="copy">
              Could not reach GitHub for the latest release ({release.message}).
              Use the manual instructions below.
            </p>
          ) : null}
          {release.status === "ready" ? (
            <div className="grid" style={{ gap: "0.5rem" }}>
              <select
                aria-label="Board"
                className="input"
                disabled={building}
                onChange={(event) => setPlatform(event.target.value)}
                value={platform}
              >
                <option disabled value="">
                  Pick a board…
                </option>
                {release.boards.map((board) => (
                  <option
                    disabled={!board.asset}
                    key={board.platform}
                    value={board.platform}
                  >
                    {board.asset
                      ? `${board.label} (${release.version})`
                      : `${board.label} — image not published yet`}
                  </option>
                ))}
              </select>
              <input
                className="input"
                disabled={building}
                maxLength={256}
                onChange={(event) => setFrameName(event.target.value)}
                placeholder="Frame name (optional)"
                value={frameName}
              />
              <input
                className="input"
                disabled={building}
                maxLength={64}
                onChange={(event) => setWifiSsid(event.target.value)}
                placeholder="WiFi network (optional — the FrameOS-Setup portal works too)"
                value={wifiSsid}
              />
              <input
                className="input"
                disabled={building || !wifiSsid}
                maxLength={128}
                onChange={(event) => setWifiPassword(event.target.value)}
                placeholder="WiFi password"
                type="password"
                value={wifiPassword}
              />
              {!canStreamToDisk ? (
                <p className="copy">
                  <HardDrive aria-hidden size={16} /> This browser can&apos;t
                  stream straight to disk, so the whole image (~1–2 GB) is
                  assembled in memory before the download starts.
                </p>
              ) : null}
              <div className="inline-actions">
                <button
                  className="button button--small"
                  disabled={building || !platform}
                  onClick={() => void build()}
                  type="button"
                >
                  <Download aria-hidden size={16} />
                  {building
                    ? progressBytes > 0
                      ? `Writing… ${progressMb} MB`
                      : "Preparing…"
                    : "Download SD image"}
                </button>
                {building ? (
                  <span className="copy" role="status">
                    {status}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
          {phase === "done" ? (
            <div className="card" data-testid="sd-image-done">
              <p className="copy">
                Image saved ({progressMb} MB). Flash this <code>.img</code> to
                as many SD cards as you like (Raspberry Pi Imager or
                balenaEtcher, &ldquo;Use custom image&rdquo;). Each frame
                appears below as <em>pending</em> when it first boots — confirm
                each one.
                {claimTokenExpiresAt
                  ? ` The embedded claim code is valid until ${new Date(claimTokenExpiresAt).toLocaleString()}.`
                  : ""}
              </p>
            </div>
          ) : null}
          {error ? (
            <p className="copy" role="alert" style={{ color: "var(--warning)" }}>
              {error}
            </p>
          ) : null}
        </>
      ) : (
        <p className="copy">
          This browser can&apos;t decompress the image locally — use the manual
          instructions below.
        </p>
      )}

      <details
        onToggle={(event) => setManualOpen(event.currentTarget.open)}
        open={manualOpen}
        style={{ marginTop: "0.5rem" }}
      >
        <summary className="copy" style={{ cursor: "pointer" }}>
          Manual setup (flash the generic image yourself)
        </summary>
        <p className="copy">
          Download the generic FrameOS image for your board from the{" "}
          <a
            href="https://github.com/FrameOS/frameos/releases/latest"
            rel="noreferrer noopener"
            target="_blank"
          >
            latest release
          </a>
          , flash it, then create a file named <code>frameos-cloud.txt</code>{" "}
          on the SD card&apos;s boot partition:
        </p>
        <pre className="copy">
          {`cloud_url=${origin}
claim_token=${claimToken ?? "<your claim code>"}
# optional:
# name=Kitchen frame
# wifi_ssid=MyNetwork
# wifi_password=…`}
        </pre>
        <p className="copy">
          The file is read once on first boot and destroyed. Without WiFi
          credentials the frame opens the <code>FrameOS-Setup</code> hotspot so
          you can connect it to your network first.
        </p>
      </details>
    </div>
  );
}
