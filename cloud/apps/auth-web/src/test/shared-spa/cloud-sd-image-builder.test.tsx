// @vitest-environment jsdom
//
// The SD image builder inside the workspace's "Add frame" panel. It lives in
// cloud-frontend/, which has no test runner, so it is tested from auth-web's
// vitest across the package boundary (see the other shared-spa tests).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_CONFIG_MAGIC,
  CLOUD_CONFIG_REGION_SIZE,
} from "../../../../../../cloud-frontend/src/lib/sd-image-patch";
import { SdImageBuilder } from "../../../../../../cloud-frontend/src/components/SdImageBuilder";

const fetchMock = vi.fn<typeof fetch>();
const encoder = new TextEncoder();

function buildPlaceholderImage(): Uint8Array {
  const prefix = new Uint8Array(1000).fill(0xaa);
  const region = new Uint8Array(CLOUD_CONFIG_REGION_SIZE);
  const header = encoder.encode(`${CLOUD_CONFIG_MAGIC}\n# Edit me.\n`);
  region.set(header);
  let offset = header.length;
  while (offset < CLOUD_CONFIG_REGION_SIZE) {
    const lineLength = Math.min(64, CLOUD_CONFIG_REGION_SIZE - offset);
    region.fill(0x23, offset, offset + lineLength - 1);
    region[offset + lineLength - 1] = 0x0a;
    offset += lineLength;
  }
  const suffix = new Uint8Array(2000).fill(0x55);
  const image = new Uint8Array(prefix.length + region.length + suffix.length);
  image.set(prefix);
  image.set(region, prefix.length);
  image.set(suffix, prefix.length + region.length);
  return image;
}

const image = buildPlaceholderImage();
const gzippedImage = new Uint8Array(gzipSync(image));

// A deliberately incompressible image, big enough that the re-gzip stream
// emits output (and therefore builds backpressure) while the write loop is
// still running. That is what the deadlock regression test needs.
function buildLargeIncompressibleImage(): Uint8Array {
  const base = buildPlaceholderImage();
  const noise = new Uint8Array(2 * 1024 * 1024);
  let state = 123456789;
  for (let index = 0; index < noise.length; index++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    noise[index] = (state >> 16) & 0xff;
  }
  const large = new Uint8Array(base.length + noise.length);
  large.set(base);
  large.set(noise, base.length);
  return large;
}

// Shape of GET /api/frames/firmware: one session-gated, server-cached release
// lookup covering both the ESP32 firmware and the SD images, so the browser
// never spends the unauthenticated api.github.com budget.
const firmwarePayload = {
  assets: [
    {
      name: "frameos-1.2.3-esp32.bin",
      platform: "esp32",
      size: 1_500_000,
    },
    {
      name: "frameos-1.2.3-raspberry-pi-zero-2-w-buildroot.img.gz",
      platform: "raspberry-pi-zero-2-w",
      size: gzippedImage.length,
    },
  ],
  release: "v1.2.3",
};

// The image itself comes from the provider's same-origin route (GitHub's
// release redirect sends no CORS headers), so that is what the build path
// fetches; the board listing comes from the firmware route.
function mockReleaseAndImage() {
  fetchMock.mockImplementation((input) => {
    const url = String(input);
    if (url.startsWith("/api/frames/firmware")) {
      return Promise.resolve(Response.json(firmwarePayload));
    }
    if (url.startsWith("/api/frames/sd-image")) {
      return Promise.resolve(
        new Response(gzippedImage.slice(), {
          headers: { "content-type": "application/gzip" },
        }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

// The builder re-gzips its output, so tests decompress before asserting on
// image bytes.
function gunzip(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(gunzipSync(Buffer.from(bytes)));
}

interface SavedFile {
  aborted: boolean;
  bytes: Uint8Array[];
  closed: boolean;
  suggestedName?: string;
}

function stubSaveFilePicker(): SavedFile {
  const saved: SavedFile = { aborted: false, bytes: [], closed: false };
  Object.assign(window, {
    showSaveFilePicker: (options: { suggestedName?: string }) => {
      if (options.suggestedName !== undefined) {
        saved.suggestedName = options.suggestedName;
      }
      return Promise.resolve({
        createWritable: () =>
          Promise.resolve({
            abort: () => {
              saved.aborted = true;
              return Promise.resolve();
            },
            close: () => {
              saved.closed = true;
              return Promise.resolve();
            },
            write: (chunk: Uint8Array) => {
              saved.bytes.push(chunk.slice());
              return Promise.resolve();
            },
          }),
      });
    },
  });
  return saved;
}

// A picker whose disk writes fail, the way a full volume behaves halfway
// through a 1-2 GB image.
function stubFailingSaveFilePicker(message: string) {
  Object.assign(window, {
    showSaveFilePicker: () =>
      Promise.resolve({
        createWritable: () =>
          Promise.resolve({
            abort: () => Promise.resolve(),
            close: () => Promise.resolve(),
            write: () =>
              Promise.reject(new DOMException(message, "QuotaExceededError")),
          }),
      }),
  });
}

function savedBytes(saved: SavedFile): Uint8Array {
  const total = saved.bytes.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of saved.bytes) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  // jsdom has no object URLs; the Blob-fallback test installs its own.
  delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
  delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
});

describe("SdImageBuilder", () => {
  it("lists boards from the latest release and disables missing ones", async () => {
    mockReleaseAndImage();
    render(<SdImageBuilder cloudOrigin={window.location.origin} mintClaimToken={() => Promise.resolve("FRCT_x")} />);

    const available = await screen.findByRole("option", {
      name: "Raspberry Pi Zero 2 W (v1.2.3)",
    });
    expect((available as HTMLOptionElement).disabled).toBe(false);

    const missing = screen.getByRole("option", {
      name: "Raspberry Pi Zero W — image not published yet",
    });
    expect((missing as HTMLOptionElement).disabled).toBe(true);
  });

  it("reports a failed release lookup instead of silently offering nothing", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("{}", { status: 500 }),
    );
    render(<SdImageBuilder cloudOrigin={window.location.origin} mintClaimToken={() => Promise.resolve("FRCT_x")} />);

    await screen.findByText(/Could not look up the latest FrameOS release/);
  });

  it("refuses WiFi values with double quotes before downloading anything", async () => {
    mockReleaseAndImage();
    const mint = vi.fn(() => Promise.resolve("FRCT_multi"));
    render(<SdImageBuilder cloudOrigin={window.location.origin} mintClaimToken={mint} />);
    await screen.findByRole("option", {
      name: "Raspberry Pi Zero 2 W (v1.2.3)",
    });

    fireEvent.change(
      screen.getByPlaceholderText(/WiFi network \(optional/),
      { target: { value: 'my "network"' } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: /download sd image/i }),
    );

    await screen.findByText(/must not contain double quotes or backslashes/);
    expect(mint).not.toHaveBeenCalled();
    // Only the release lookup hit the network — never the image download.
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).startsWith("/api/frames/sd-image"),
      ),
    ).toHaveLength(0);
  });

  it("builds a personalized image: mints a multi-use token, patches the placeholder, streams to disk", async () => {
    mockReleaseAndImage();
    const saved = stubSaveFilePicker();
    const mint = vi.fn(() => Promise.resolve("FRCT_multi_use_token"));
    render(<SdImageBuilder cloudOrigin={window.location.origin} mintClaimToken={mint} />);
    await screen.findByRole("option", {
      name: "Raspberry Pi Zero 2 W (v1.2.3)",
    });

    fireEvent.change(screen.getByPlaceholderText("Frame name (optional)"), {
      target: { value: "Kitchen Frame" },
    });
    fireEvent.change(
      screen.getByPlaceholderText(/WiFi network \(optional/),
      { target: { value: "MyNet" } },
    );
    fireEvent.change(screen.getByPlaceholderText("WiFi password"), {
      target: { value: "hunter2" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /download sd image/i }),
    );

    await screen.findByTestId("sd-image-done", undefined, { timeout: 5000 });

    expect(mint).toHaveBeenCalledExactlyOnceWith({ multiUse: true });
    expect(saved.suggestedName).toBe(
      "frameos-raspberry-pi-zero-2-w-kitchen-frame.img.gz",
    );
    expect(saved.closed).toBe(true);
    expect(saved.aborted).toBe(false);

    // The saved file is gzipped; decompress before comparing image bytes.
    const output = gunzip(savedBytes(saved));
    expect(output.length).toBe(image.length);
    // Bytes outside the placeholder region are untouched.
    expect(output.slice(0, 1000)).toEqual(image.slice(0, 1000));
    expect(output.slice(1000 + CLOUD_CONFIG_REGION_SIZE)).toEqual(
      image.slice(1000 + CLOUD_CONFIG_REGION_SIZE),
    );
    // The region carries the personalized config.
    const regionText = new TextDecoder().decode(
      output.slice(1000, 1000 + CLOUD_CONFIG_REGION_SIZE),
    );
    expect(regionText.startsWith(`${CLOUD_CONFIG_MAGIC}\n`)).toBe(true);
    expect(regionText).toContain("claim_token=FRCT_multi_use_token\n");
    expect(regionText).toContain(`cloud_url=${window.location.origin}\n`);
    expect(regionText).toContain("name=Kitchen Frame\n");
    expect(regionText).toContain("wifi_ssid=MyNet\n");
    expect(regionText).toContain("wifi_password=hunter2\n");
  });

  it("reuses a previously minted multi-use token passed as a prop", async () => {
    mockReleaseAndImage();
    const saved = stubSaveFilePicker();
    const mint = vi.fn(() => Promise.resolve("FRCT_should_not_mint"));
    render(
      <SdImageBuilder
        cloudOrigin={window.location.origin}
        claimToken="FRCT_existing"
        claimTokenExpiresAt="2030-01-01T00:00:00Z"
        mintClaimToken={mint}
      />,
    );
    await screen.findByRole("option", {
      name: "Raspberry Pi Zero 2 W (v1.2.3)",
    });

    fireEvent.click(
      screen.getByRole("button", { name: /download sd image/i }),
    );
    await screen.findByTestId("sd-image-done", undefined, { timeout: 5000 });

    expect(mint).not.toHaveBeenCalled();
    const regionText = new TextDecoder().decode(gunzip(savedBytes(saved)));
    expect(regionText).toContain("claim_token=FRCT_existing\n");
    // Success panel mentions the token expiry.
    expect(
      screen.getByTestId("sd-image-done").textContent,
    ).toContain("valid until");
  });

  // Firefox and Safari have no File System Access API, so the whole image is
  // assembled in memory and handed over as a Blob download.
  it("falls back to a Blob download when the browser cannot stream to disk", async () => {
    mockReleaseAndImage();
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return "blob:mock-url";
    });
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const clicked: HTMLAnchorElement[] = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push(this);
      });

    render(<SdImageBuilder cloudOrigin={window.location.origin} mintClaimToken={() => Promise.resolve("FRCT_m")} />);
    await screen.findByRole("option", {
      name: "Raspberry Pi Zero 2 W (v1.2.3)",
    });
    // The in-memory caveat is stated up front.
    expect(screen.getByText(/assembled in memory/)).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", { name: /download sd image/i }),
    );
    await screen.findByTestId("sd-image-done", undefined, { timeout: 5000 });

    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.download).toBe(
      "frameos-raspberry-pi-zero-2-w-cloud.img.gz",
    );
    expect(clicked[0]?.href).toBe("blob:mock-url");
    expect(blobs).toHaveLength(1);
    const bytes = new Uint8Array(await blobs[0]!.arrayBuffer());
    const output = gunzip(bytes);
    expect(output.length).toBe(image.length);
    expect(
      new TextDecoder().decode(
        output.slice(1000, 1000 + CLOUD_CONFIG_REGION_SIZE),
      ),
    ).toContain("claim_token=FRCT_m\n");

    clickSpy.mockRestore();
  });

  // Regression: a mid-stream write failure used to deadlock. The drain
  // rejected, nothing observed it until after the loop, and the loop blocked
  // forever on gzip backpressure with busyRef stuck true — no error, no way
  // back without reloading the page.
  it("surfaces a mid-stream write failure and leaves the UI usable", async () => {
    const large = new Uint8Array(gzipSync(buildLargeIncompressibleImage()));
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.startsWith("/api/frames/firmware")) {
        return Promise.resolve(Response.json(firmwarePayload));
      }
      return Promise.resolve(new Response(large.slice()));
    });
    stubFailingSaveFilePicker("The target volume is full.");
    render(<SdImageBuilder cloudOrigin={window.location.origin} mintClaimToken={() => Promise.resolve("FRCT_m")} />);
    await screen.findByRole("option", {
      name: "Raspberry Pi Zero 2 W (v1.2.3)",
    });

    const button = screen.getByRole("button", { name: /download sd image/i });
    fireEvent.click(button);

    await screen.findByText(/The target volume is full\./, undefined, {
      timeout: 5000,
    });
    expect(screen.queryByTestId("sd-image-done")).toBeNull();
    // Not stuck in "building": the button is enabled and offers a retry.
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.textContent).toContain("Download SD image");
  });

  it("reports a config that does not fit the placeholder on its own terms", async () => {
    mockReleaseAndImage();
    stubSaveFilePicker();
    render(<SdImageBuilder cloudOrigin={window.location.origin} mintClaimToken={() => Promise.resolve("FRCT_m")} />);
    await screen.findByRole("option", {
      name: "Raspberry Pi Zero 2 W (v1.2.3)",
    });

    fireEvent.change(screen.getByPlaceholderText("Frame name (optional)"), {
      target: { value: "x".repeat(5000) },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /download sd image/i }),
    );

    await screen.findByText(/does not fit in the 4096-byte placeholder/);
    // Not the "your release is too old" story — nothing is wrong with the
    // image.
    expect(
      screen.queryByText(/predates in-browser personalization/),
    ).toBeNull();
  });

  it("refuses an image without the placeholder instead of shipping a broken card", async () => {
    const noPlaceholder = new Uint8Array(64 * 1024).fill(0xaa);
    const gzipped = new Uint8Array(gzipSync(noPlaceholder));
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.startsWith("/api/frames/firmware")) {
        return Promise.resolve(Response.json(firmwarePayload));
      }
      return Promise.resolve(new Response(gzipped.slice()));
    });
    stubSaveFilePicker();
    render(
      <SdImageBuilder cloudOrigin={window.location.origin} mintClaimToken={() => Promise.resolve("FRCT_multi")} />,
    );
    await screen.findByRole("option", {
      name: "Raspberry Pi Zero 2 W (v1.2.3)",
    });

    fireEvent.click(
      screen.getByRole("button", { name: /download sd image/i }),
    );

    await screen.findByText(
      /predates in-browser personalization/,
      undefined,
      { timeout: 5000 },
    );
  });
});
