// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_CONFIG_MAGIC,
  CLOUD_CONFIG_REGION_SIZE,
} from "../lib/sd-image-patch";
import { SdImageBuilder } from "./SdImageBuilder";

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

const releasePayload = {
  assets: [
    {
      browser_download_url:
        "https://github.com/FrameOS/frameos/releases/download/v1.2.3/frameos-1.2.3-raspberry-pi-zero-2-w-buildroot.img.gz",
      name: "frameos-1.2.3-raspberry-pi-zero-2-w-buildroot.img.gz",
      size: gzippedImage.length,
    },
  ],
  tag_name: "v1.2.3",
};

function mockReleaseAndImage() {
  fetchMock.mockImplementation((input) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/")) {
      return Promise.resolve(Response.json(releasePayload));
    }
    if (url.endsWith(".img.gz")) {
      return Promise.resolve(
        new Response(gzippedImage.slice(), {
          headers: { "content-type": "application/octet-stream" },
        }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
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
});

describe("SdImageBuilder", () => {
  it("lists boards from the latest release and disables missing ones", async () => {
    mockReleaseAndImage();
    render(<SdImageBuilder mintClaimToken={() => Promise.resolve("FRCT_x")} />);

    const available = await screen.findByRole("option", {
      name: "Raspberry Pi Zero 2 W (v1.2.3)",
    });
    expect((available as HTMLOptionElement).disabled).toBe(false);

    const missing = screen.getByRole("option", {
      name: "Raspberry Pi Zero W — image not published yet",
    });
    expect((missing as HTMLOptionElement).disabled).toBe(true);
  });

  it("falls back to manual instructions when the release lookup fails", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("{}", { status: 500 }),
    );
    render(<SdImageBuilder mintClaimToken={() => Promise.resolve("FRCT_x")} />);

    await screen.findByText(/Could not reach GitHub/);
    expect(
      screen.getByText(/Manual setup \(flash the generic image yourself\)/),
    ).toBeDefined();
  });

  it("refuses WiFi values with double quotes before downloading anything", async () => {
    mockReleaseAndImage();
    const mint = vi.fn(() => Promise.resolve("FRCT_multi"));
    render(<SdImageBuilder mintClaimToken={mint} />);
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
        String(input).endsWith(".img.gz"),
      ),
    ).toHaveLength(0);
  });

  it("builds a personalized image: mints a multi-use token, patches the placeholder, streams to disk", async () => {
    mockReleaseAndImage();
    const saved = stubSaveFilePicker();
    const mint = vi.fn(() => Promise.resolve("FRCT_multi_use_token"));
    render(<SdImageBuilder mintClaimToken={mint} />);
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
      "frameos-raspberry-pi-zero-2-w-kitchen-frame.img",
    );
    expect(saved.closed).toBe(true);
    expect(saved.aborted).toBe(false);

    const output = savedBytes(saved);
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
    const regionText = new TextDecoder().decode(savedBytes(saved));
    expect(regionText).toContain("claim_token=FRCT_existing\n");
    // Success panel mentions the token expiry.
    expect(
      screen.getByTestId("sd-image-done").textContent,
    ).toContain("valid until");
  });

  it("shows the manual fallback when the image has no placeholder", async () => {
    const noPlaceholder = new Uint8Array(64 * 1024).fill(0xaa);
    const gzipped = new Uint8Array(gzipSync(noPlaceholder));
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/")) {
        return Promise.resolve(Response.json(releasePayload));
      }
      return Promise.resolve(new Response(gzipped.slice()));
    });
    stubSaveFilePicker();
    render(
      <SdImageBuilder mintClaimToken={() => Promise.resolve("FRCT_multi")} />,
    );
    await screen.findByRole("option", {
      name: "Raspberry Pi Zero 2 W (v1.2.3)",
    });

    fireEvent.click(
      screen.getByRole("button", { name: /download sd image/i }),
    );

    await screen.findByText(
      /doesn't support in-browser personalization yet/,
      undefined,
      { timeout: 5000 },
    );
    // The manual instructions opened as the fallback.
    const details = document.querySelector("details");
    expect(details?.open).toBe(true);
  });
});
