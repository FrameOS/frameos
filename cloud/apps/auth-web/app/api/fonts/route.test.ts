import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { catalogueFonts } from "../../../src/lib/fonts";
import { GET as getFile } from "./[file]/route";
import { GET as listFonts } from "./route";

// The two routes the scene editor's font picker uses: the catalogue, and one
// font's bytes. Both are public — these are the faces FrameOS ships, the same
// for every account, and the bytes sit in public/fonts where the static
// handler serves them without a session anyway.

function fileRequest(file: string) {
  return [
    new NextRequest(`https://cloud.example/api/fonts/${file}`),
    { params: Promise.resolve({ file }) },
  ] as const;
}

describe("GET /api/fonts", () => {
  it("lists the catalogue in the shape fontsModel parses", async () => {
    const body = (await listFonts().json()) as {
      fonts: { file: string; name: string; weight: number; italic: boolean }[];
    };
    expect(body.fonts.length).toBe(catalogueFonts.length);
    const cascadia = body.fonts.find((font) => font.file === "CascadiaMono.ttf")!;
    expect(cascadia.name).toBe("Cascadia Mono");
    expect(cascadia.weight).toBe(400);
    expect(cascadia.italic).toBe(false);
  });
});

describe("GET /api/fonts/[file]", () => {
  it("points at the static copy rather than streaming it through Node", async () => {
    const response = await getFile(...fileRequest("CascadiaMono.ttf"));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe(
      "/fonts/CascadiaMono.ttf",
    );
  });

  it("404s a name that is not in the catalogue", async () => {
    const response = await getFile(...fileRequest("Nonexistent.ttf"));
    expect(response.status).toBe(404);
  });

  it("refuses a traversal instead of resolving it", async () => {
    for (const attempt of [
      "../../../etc/passwd",
      "..%2f..%2fetc%2fpasswd",
      "fonts/../../secrets.env",
    ]) {
      const response = await getFile(...fileRequest(attempt));
      expect(response.status, `${attempt} should not resolve`).toBe(404);
      expect(response.headers.get("location")).toBeNull();
    }
  });
});
