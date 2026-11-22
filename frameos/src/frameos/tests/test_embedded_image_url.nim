# RULE: frames NEVER fetch images through a backend proxy, and oversized
# sources are fixed with better on-device streaming decode — not host-side
# resize params. This test pins that remote URLs pass through unrewritten
# (the pre-existing unsplash rewrite is the only exception).
import std/[strutils, unittest]
import pixie

import ../utils/image

suite "embedded remote image URLs (no proxies, ever)":
  let target = newImage(1200, 1600)

  test "unsplash URLs keep their pre-existing host-side resize params":
    let rewritten = embeddedSizedRemoteImageUrl(
      "https://images.unsplash.com/photo-123?ixid=abc", target)
    check rewritten.startsWith("https://images.unsplash.com/photo-123")
    check "w=800" in rewritten
    check "h=800" in rewritten
    check "fit=crop" in rewritten

  test "the query is rewritten in place: path, port, fragment and an author's format stay":
    check embeddedSizedRemoteImageUrl("https://IMAGES.unsplash.com:443/photo-1", target) ==
      "https://IMAGES.unsplash.com:443/photo-1?w=800&h=800&fit=crop&auto=format"
    check embeddedSizedRemoteImageUrl(
      "https://images.unsplash.com/photo-1?w=10&fm=png#top", target) ==
      "https://images.unsplash.com/photo-1?w=800&fm=png&h=800&fit=crop#top"
    check embeddedSizedRemoteImageUrl("https://user@images.unsplash.com?q=1", target) ==
      "https://user@images.unsplash.com?q=1&w=800&h=800&fit=crop&auto=format"
    let lookalike = "https://images.unsplash.com.example.org/photo?x=1"
    check embeddedSizedRemoteImageUrl(lookalike, target) == lookalike

  test "all other hosts pass through unchanged — never rewritten to a proxy":
    let gallery = "https://gallery.frameos.net/image?category=building-art-styles"
    check embeddedSizedRemoteImageUrl(gallery, target) == gallery
    let other = "https://example.com/huge.png"
    check embeddedSizedRemoteImageUrl(other, target) == other

  test "non-http and target-less calls pass through unchanged":
    check embeddedSizedRemoteImageUrl("file:///tmp/a.png", target) == "file:///tmp/a.png"
    check embeddedSizedRemoteImageUrl("https://example.com/a.png", nil) == "https://example.com/a.png"
