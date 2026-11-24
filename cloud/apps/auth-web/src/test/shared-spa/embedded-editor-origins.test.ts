// @vitest-environment jsdom
// The embedded editor's postMessage origin rules (frontend/src/embed/embedOrigins.ts):
// which parent origins may drive an iframe-hosted editor, where replies go,
// and which previewProxyUrl values are honoured.
import { describe, expect, it } from "vitest";
import {
  PARENT_ORIGINS_META,
  allowedParentOrigins,
  replyTargetOrigin,
  sameOriginPreviewProxyUrl,
  trustedParentOrigins,
} from "../../../../../../frontend/src/embed/embedOrigins";

const editor = "https://editor.example";

describe("trustedParentOrigins", () => {
  it("is the editor's own origin, and what its own page lists", () => {
    expect(PARENT_ORIGINS_META).toBe("frameos-editor-parent-origins");
    expect(trustedParentOrigins(editor, null)).toEqual([editor]);
    expect(trustedParentOrigins(editor, undefined)).toEqual([editor]);
    expect(trustedParentOrigins(editor, "")).toEqual([editor]);
    expect(
      trustedParentOrigins(editor, " https://scenes.example/page?x=1, http://localhost:3000  https://b.example:8443 "),
    ).toEqual([editor, "https://scenes.example", "http://localhost:3000", "https://b.example:8443"]);
  });

  it("never trusts what is no http(s) origin: an opaque document's origin reads null for everyone", () => {
    expect(trustedParentOrigins("null", null)).toEqual([]);
    expect(trustedParentOrigins(editor, "null, *, not a url, javascript:alert(1), file:///tmp/x")).toEqual([editor]);
  });
});

describe("allowedParentOrigins", () => {
  const trusted = trustedParentOrigins(editor, "https://scenes.example, http://localhost:3000");

  it("lets the host's own declaration pick among the trusted origins, normalised", () => {
    expect(allowedParentOrigins("?parentOrigin=https://scenes.example/page?x=1", "", trusted)).toEqual([
      "https://scenes.example",
    ]);
    expect(allowedParentOrigins(`?parentOrigin=${editor},http://localhost:3000`, "https://evil.example/", trusted)).toEqual([
      editor,
      "http://localhost:3000",
    ]);
    expect(allowedParentOrigins(`?parentOrigin=${editor}&parentOrigin=http://localhost:3000`, "", trusted)).toEqual([
      editor,
      "http://localhost:3000",
    ]);
  });

  // The iframe URL and the referrer are both the framing page's own word:
  // any page that framed the editor could name itself.
  it("allows no origin the editor's own page does not trust, whatever the framing page says", () => {
    expect(allowedParentOrigins("?parentOrigin=https://evil.example", "https://evil.example/", trusted)).toEqual([]);
    expect(allowedParentOrigins("?parentOrigin=https://evil.example,https://scenes.example", "", trusted)).toEqual([
      "https://scenes.example",
    ]);
    expect(allowedParentOrigins("", "https://evil.example/frame.html", trusted)).toEqual([]);
    expect(allowedParentOrigins("?parentOrigin=https://evil.example", "", [editor])).toEqual([]);
    expect(allowedParentOrigins("", "https://scenes.example/", [editor])).toEqual([]);
  });

  it("falls back to the framing document's origin when nothing is declared", () => {
    expect(allowedParentOrigins("", "https://scenes.example/scenes/new", trusted)).toEqual(["https://scenes.example"]);
    expect(allowedParentOrigins("?other=1", "http://localhost:3000/", trusted)).toEqual(["http://localhost:3000"]);
    expect(allowedParentOrigins("", `${editor}/scenes/local/3/edit`, [editor])).toEqual([editor]);
  });

  it("hears every trusted host when the framing page says nothing at all", () => {
    expect(allowedParentOrigins("", "", trusted)).toEqual(trusted);
    expect(allowedParentOrigins("?theme=dark", "", [editor])).toEqual([editor]);
  });

  it("allows nobody when what was said is not usable", () => {
    expect(allowedParentOrigins("?parentOrigin=not a url", "", trusted)).toEqual([]);
    expect(allowedParentOrigins("?parentOrigin=", `${editor}/`, trusted)).toEqual([]);
    expect(allowedParentOrigins("", "garbage", trusted)).toEqual([]);
    expect(allowedParentOrigins("", "", [])).toEqual([]);
  });
});

describe("replyTargetOrigin", () => {
  it("replies to the locked parent, or to itself on a direct mount — never to *", () => {
    expect(replyTargetOrigin("https://host.example")).toBe("https://host.example");
    expect(replyTargetOrigin(null)).toBe(window.location.origin);
  });
});

describe("sameOriginPreviewProxyUrl", () => {
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
