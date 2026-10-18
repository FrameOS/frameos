import { describe, expect, it } from "vitest";
import {
  hasPhotoShareLink,
  PhotoLinkRedactor,
  photoShareTokens,
} from "./share-links-in-scenes";

const token = `pk_${"a1B2c3D4".repeat(4)}`;
const other = `pk_${"Zz9_-yX8".repeat(5)}`;
const cloudLink = `https://cloud.frameos.net/api/photos/shared/${token}`;
const backendLink = `/api/photos/shared/${other}`;

function albumScene(album: string) {
  return [
    {
      id: "album",
      nodes: [
        {
          data: { config: { album, counterStateKey: "photoIndex" }, keyword: "photoAlbum" },
          id: "node-1",
          type: "app",
        },
      ],
    },
  ];
}

describe("hasPhotoShareLink", () => {
  it("finds a link anywhere in scene JSON, absolute or root-relative", () => {
    expect(hasPhotoShareLink(albumScene(cloudLink))).toBe(true);
    expect(hasPhotoShareLink(albumScene(backendLink))).toBe(true);
    expect(hasPhotoShareLink(albumScene(`http://10.0.0.5:8989${backendLink}/photo?index=3`))).toBe(true);
    expect(hasPhotoShareLink({ deep: [{ deeper: { [cloudLink]: 1 } }] })).toBe(true);
    expect(hasPhotoShareLink(cloudLink)).toBe(true);
  });

  it("finds a link whose slashes are escaped", () => {
    expect(hasPhotoShareLink(String.raw`const a = "https:\/\/x\/api\/photos\/shared\/${token}"`)).toBe(true);
    expect(hasPhotoShareLink(`?album=https%3A%2F%2Fx%2Fapi%2Fphotos%2Fshared%2F${token}`)).toBe(true);
  });

  it("leaves bare tokens, short tokens and other paths alone", () => {
    // A Stripe publishable key has the same shape as a token.
    expect(hasPhotoShareLink(albumScene(token))).toBe(false);
    expect(hasPhotoShareLink(albumScene("/api/photos/shared/pk_short"))).toBe(false);
    expect(hasPhotoShareLink(albumScene(`/api/photos/thumb?path=${token}`))).toBe(false);
    expect(hasPhotoShareLink(albumScene(`/api/photos/shared/${token}?x=1`))).toBe(true);
    expect(hasPhotoShareLink(albumScene(`/api/photos/shared/${"pk_" + "a".repeat(129)}`))).toBe(false);
    expect(hasPhotoShareLink(null)).toBe(false);
    expect(hasPhotoShareLink(undefined)).toBe(false);
    expect(hasPhotoShareLink(albumScene("https://cloud.frameos.net/api/photos/shared/pk_photo_link_1"))).toBe(
      false,
    );
  });
});

describe("photoShareTokens", () => {
  it("lists each token once, in order", () => {
    expect(photoShareTokens([cloudLink, backendLink, `${cloudLink}/photo`])).toEqual([token, other]);
    expect(photoShareTokens({ album: token })).toEqual([]);
  });
});

describe("PhotoLinkRedactor", () => {
  it("swaps each token for a numbered placeholder and keeps the host and path", () => {
    const redactor = new PhotoLinkRedactor();
    const redacted = redactor.redact(albumScene(cloudLink));
    expect(JSON.stringify(redacted)).not.toContain(token);
    expect(redacted[0]!.nodes[0]!.data.config.album).toBe(
      "https://cloud.frameos.net/api/photos/shared/pk_photo_link_1",
    );
    expect(redactor.size).toBe(1);
    // The placeholder is not itself a link.
    expect(hasPhotoShareLink(redacted)).toBe(false);
  });

  it("keeps one number per token for the whole turn", () => {
    const redactor = new PhotoLinkRedactor();
    expect(redactor.redactText(`a ${backendLink} b`)).toBe("a /api/photos/shared/pk_photo_link_1 b");
    expect(redactor.redactText(`${cloudLink} and ${backendLink}`)).toBe(
      "https://cloud.frameos.net/api/photos/shared/pk_photo_link_2 and /api/photos/shared/pk_photo_link_1",
    );
    expect(redactor.size).toBe(2);
  });

  it("hides a known token where it appears without the path", () => {
    const redactor = new PhotoLinkRedactor();
    const log = `HTTP request failed: ${cloudLink}/photo?index=4 (token ${token})`;
    const redacted = redactor.redactText(log);
    expect(redacted).not.toContain(token);
    expect(redacted).toBe(
      "HTTP request failed: https://cloud.frameos.net/api/photos/shared/pk_photo_link_1/photo?index=4 (token pk_photo_link_1)",
    );
    // An unknown bare token is not a link and stays.
    expect(new PhotoLinkRedactor().redactText(`key ${token}`)).toBe(`key ${token}`);
  });

  it("redacts escaped links in place", () => {
    const redactor = new PhotoLinkRedactor();
    const encoded = `?album=https%3A%2F%2Fx%2Fapi%2Fphotos%2Fshared%2F${token}`;
    expect(redactor.redactText(encoded)).toBe("?album=https%3A%2F%2Fx%2Fapi%2Fphotos%2Fshared%2Fpk_photo_link_1");
    expect(redactor.restoreText(redactor.redactText(encoded))).toBe(encoded);
  });

  it("restores the real link in what the model hands back", () => {
    const redactor = new PhotoLinkRedactor();
    const scene = albumScene(cloudLink);
    const redacted = redactor.redact(scene);
    // The model edits the scene and keeps the placeholder.
    const edited = structuredClone(redacted);
    edited[0]!.nodes[0]!.data.config.counterStateKey = "index";
    const restored = redactor.restore(edited);
    expect(restored[0]!.nodes[0]!.data.config.album).toBe(cloudLink);
    expect(restored[0]!.nodes[0]!.data.config.counterStateKey).toBe("index");
    // A JSON patch value, a code string and a key are restored too.
    expect(
      redactor.restore({
        ops: [{ op: "replace", path: "/nodes/0/data/config/album", value: redacted[0]!.nodes[0]!.data.config.album }],
      }).ops[0]!.value,
    ).toBe(cloudLink);
    expect(redactor.restoreText('fetch(base + "/pk_photo_link_1")')).toBe(`fetch(base + "/${token}")`);
    // A number it never handed out stays as written.
    expect(redactor.restoreText("pk_photo_link_7")).toBe("pk_photo_link_7");
    expect(redactor.restoreText("xpk_photo_link_1")).toBe("xpk_photo_link_1");
  });

  it("returns the same object when there is nothing to change", () => {
    const redactor = new PhotoLinkRedactor();
    const scene = albumScene("https://example.com/a.jpg");
    expect(redactor.redact(scene)).toBe(scene);
    expect(redactor.restore(scene)).toBe(scene);
    expect(redactor.restoreText("pk_photo_link_1")).toBe("pk_photo_link_1");
  });
});
