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

// Server-side, session-gated and cached release lookup. The browser used to
// call api.github.com directly, which burns the unauthenticated 60 req/hr/IP
// budget — a single corporate NAT is enough to turn that into a 403 for
// everyone behind it.
const firmwareApiUrl = "/api/frames/firmware";

const knownBoards = [
  { label: "Raspberry Pi Zero 2 W", platform: "raspberry-pi-zero-2-w" },
  { label: "Raspberry Pi Zero W", platform: "raspberry-pi-zero-w" },
] as const;

interface FirmwareAsset {
  name: string;
  platform: string;
  size: number;
}

interface Board {
  asset?: FirmwareAsset | undefined;
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
  let drained = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        drained = true;
        return;
      }
      if (value && value.length > 0) {
        yield value;
      }
    }
  } finally {
    // Whoever consumes this may bail out early (a patch error, a failed disk
    // write). Releasing the lock alone would leave a multi-hundred-MB
    // download running in the background, so cancel the source too.
    if (!drained) {
      await reader.cancel().catch(() => undefined);
    }
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
        const response = await fetch(firmwareApiUrl);
        if (!response.ok) {
          throw new Error(`Release lookup failed (${response.status})`);
        }
        const data = (await response.json()) as {
          assets?: FirmwareAsset[];
          release?: string;
        };
        if (cancelled) {
          return;
        }
        // The route lists ESP32 firmware alongside the SD images, so match on
        // the board's platform and prefer an .img.gz; a board with no entry
        // stays listed but disabled.
        const boards: Board[] = knownBoards.map((board) => {
          const candidates = (data.assets ?? []).filter(
            (asset) => asset.platform === board.platform,
          );
          return {
            asset:
              candidates.find((asset) => asset.name?.endsWith(".img.gz")) ??
              candidates[0],
            label: board.label,
            platform: board.platform,
          };
        });
        setRelease({
          boards,
          status: "ready",
          // The route sends "" when the release carries no tag.
          version: data.release || "latest",
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

  function failWith(message: string) {
    setError(message);
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

      // Gzipped output: Raspberry Pi Imager and balenaEtcher both read
      // .img.gz directly, it downloads ~10x smaller, and browsers don't flag
      // an archive as a dangerous file the way they do a bare .img.
      const suggestedName = `frameos-${board.platform}-${slugify(frameName) || "cloud"}.img.gz`;
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
                accept: { "application/gzip": [".img.gz", ".gz"] },
                description: "Compressed disk image",
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
      // Same-origin: GitHub's release redirect sends no CORS headers, so the
      // bytes stream through the provider (see app/api/frames/sd-image).
      const response = await fetch(
        `/api/frames/sd-image?platform=${encodeURIComponent(board.platform)}`,
      );
      if (!response.ok || !response.body) {
        const detail = (await response
          .json()
          .catch(() => ({}))) as { error?: string };
        throw new Error(
          detail.error === "image_not_published"
            ? "No image published for this board in the latest release yet."
            : `Image download failed (${detail.error ?? response.status})`,
        );
      }
      const decompressed = response.body.pipeThrough(
        new DecompressionStream("gzip"),
      );

      setStatus("Personalizing and compressing the image…");
      // Re-gzip the patched stream so what lands on disk is a compressed
      // image: smaller, and flashers read it directly.
      const recompressed = new CompressionStream("gzip");
      const recompressedWriter = recompressed.writable.getWriter();
      const blobParts: Uint8Array[] = [];
      let written = 0;
      let lastShown = 0;

      const drain = (async () => {
        for await (const chunk of streamChunks(recompressed.readable)) {
          if (writable) {
            await writable.write(chunk);
          } else {
            blobParts.push(chunk);
          }
        }
      })();
      // The drain side is the one that touches the disk, so it is where a
      // full volume shows up mid-image. Once it dies nobody reads
      // recompressed.readable any more and the loop below would block
      // forever on gzip backpressure — the UI would sit at "Personalizing…"
      // with busyRef stuck true. So race every write against a promise that
      // only ever rejects. The no-op catches keep the same rejection from
      // being reported a second time as unhandled.
      const drainFailure = drain.then(
        () => new Promise<never>(() => undefined),
        (reason: unknown) => Promise.reject(reason),
      );
      drainFailure.catch(() => undefined);
      // A write/close the race abandons still rejects later (we abort the
      // writer), so give it a handler of its own before racing it.
      const raceDrain = (pending: Promise<void>) => {
        pending.catch(() => undefined);
        return Promise.race([pending, drainFailure]);
      };

      try {
        for await (const chunk of patchCloudConfig(
          streamChunks(decompressed),
          configBytes,
        )) {
          await raceDrain(recompressedWriter.write(chunk as BufferSource));
          written += chunk.length;
          if (written - lastShown >= 8 * 1024 * 1024) {
            lastShown = written;
            setProgressBytes(written);
          }
        }
        await raceDrain(recompressedWriter.close());
      } catch (pipelineError) {
        // Tear the gzip pipeline down: aborting the writer errors the
        // readable side, which unblocks (and cancels) the drain and the
        // download reader behind it, so `drain` always settles from here.
        await recompressedWriter.abort(pipelineError).catch(() => undefined);
        // Report the drain's reason when it has one: a failed disk write
        // cancels the gzip stream, and the "operation was aborted" that the
        // in-flight write then reports would hide the actual cause.
        throw await drain.then(
          () => pipelineError,
          (reason: unknown) => reason,
        );
      }
      await drain;
      setProgressBytes(written);
      if (writable) {
        await writable.close();
        writable = undefined;
      } else {
        const blob = new Blob(blobParts as BlobPart[], {
          type: "application/gzip",
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
        failWith(
          "This release image predates in-browser personalization — update to a newer FrameOS release, or use the install-script flow instead.",
        );
      } else {
        // Always land on a real message: a DOMException from a failed disk
        // write can carry an empty one, and a blank error would look like a
        // silent hang.
        const message =
          buildError instanceof Error
            ? buildError.message
            : String(buildError);
        failWith(
          message ||
            "The image could not be written — check the destination has room and try again.",
        );
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
            <p className="copy" role="alert" style={{ color: "var(--warning)" }}>
              Could not look up the latest FrameOS release ({release.message}).
              Try again in a moment.
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
                aria-label="Frame name (optional)"
                className="input"
                disabled={building}
                maxLength={256}
                onChange={(event) => setFrameName(event.target.value)}
                placeholder="Frame name (optional)"
                value={frameName}
              />
              <input
                aria-label="WiFi network name (optional)"
                className="input"
                disabled={building}
                maxLength={64}
                onChange={(event) => setWifiSsid(event.target.value)}
                placeholder="WiFi network (optional — the FrameOS-Setup portal works too)"
                value={wifiSsid}
              />
              <input
                aria-label="WiFi password"
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
                Image saved. Flash this <code>.img.gz</code> to as many SD
                cards as you like (Raspberry Pi Imager or balenaEtcher,
                &ldquo;Use custom image&rdquo; — both read it compressed).
                Each frame appears below as <em>pending</em> when it first
                boots — confirm each one.
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
          This browser can&apos;t build the image locally (it needs
          DecompressionStream — use Chrome, Edge, Firefox or Safari 16.4+).
        </p>
      )}
    </div>
  );
}
