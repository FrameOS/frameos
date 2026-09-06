// @vitest-environment jsdom
// The embedded editor's postMessage origin rules (frontend/src/embed/embedOrigins.ts):
// which parent origins may drive an iframe-hosted editor, where replies go,
// and which previewProxyUrl values are honoured.
import { describe, expect, it } from "vitest";
import {
  allowedParentOrigins,
  replyTargetOrigin,
  sameOriginPreviewProxyUrl,
} from "../../../../../../frontend/src/embed/embedOrigins";

describe("allowedParentOrigins", () => {
  it("takes the host's own declaration from the iframe URL, normalised to origins", () => {
    expect(allowedParentOrigins("?parentOrigin=https://scenes.example/page?x=1", "")).toEqual(["https://scenes.example"]);
    expect(allowedParentOrigins("?parentOrigin=https://a.example,https://b.example:8443", "https://evil.example/")).toEqual([
      "https://a.example",
      "https://b.example:8443",
    ]);
    expect(allowedParentOrigins("?parentOrigin=https://a.example&parentOrigin=http://localhost:3000", "")).toEqual([
      "https://a.example",
      "http://localhost:3000",
    ]);
  });

  it("falls back to the framing document's origin when nothing is declared", () => {
    expect(allowedParentOrigins("", "https://host.example/scenes/new")).toEqual(["https://host.example"]);
    expect(allowedParentOrigins("?other=1", "http://localhost:3000/")).toEqual(["http://localhost:3000"]);
  });

  it("allows nobody when neither is usable", () => {
    expect(allowedParentOrigins("", "")).toEqual([]);
    expect(allowedParentOrigins("?parentOrigin=not a url", "")).toEqual([]);
    expect(allowedParentOrigins("", "garbage")).toEqual([]);
  });
});

describe("replyTargetOrigin", () => {
  it("replies to the locked parent, or to itself on a direct mount — never to *", () => {
    expect(replyTargetOrigin("https://host.example")).toBe("https://host.example");
    expect(replyTargetOrigin(null)).toBe(window.location.origin);
  });
});

describe("sameOriginPreviewProxyUrl", () => {
  const editor = "https://editor.example";
  it("keeps a same-origin proxy, relative or absolute", () => {
    expect(sameOriginPreviewProxyUrl("/api/store/preview-proxy", editor)).toBe("/api/store/preview-proxy");
    expect(sameOriginPreviewProxyUrl("https://editor.example/api/proxy", editor)).toBe("https://editor.example/api/proxy");
  });
  it("drops a proxy on any other origin, and non-strings", () => {
    expect(sameOriginPreviewProxyUrl("https://evil.example/proxy", editor)).toBeUndefined();
    expect(sameOriginPreviewProxyUrl("//evil.example/proxy", editor)).toBeUndefined();
    expect(sameOriginPreviewProxyUrl("", editor)).toBeUndefined();
    expect(sameOriginPreviewProxyUrl(42, editor)).toBeUndefined();
    expect(sameOriginPreviewProxyUrl(undefined, editor)).toBeUndefined();
  });
});
