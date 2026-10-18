## redactedUrl / redactedUrlsIn: what of a request URL may leave the frame in
## an error message or a log line (utils/redacted_url.nim). The C side
## (fos_netguard_url_origin, embedded/esp32/main/tests/test_fos_netguard.c)
## and the wasm hook (frameosLogUrl, tools/wasm/frameos_library.test.mjs)
## are held to the same cases.

import std/[strutils, unittest]

import ../redacted_url

const ShareFile = "https://cloud.frameos.net/api/photos/shared/pk_abc/file?path=beach%2Fa.jpg"

suite "redactedUrl":
  test "keeps scheme, host and port, drops path, query and fragment":
    check redactedUrl(ShareFile) == "https://cloud.frameos.net"
    check redactedUrl("HTTP://Example.COM:8080/x?key=secret#frag") == "http://example.com:8080"
    check redactedUrl("https://example.com?token=1") == "https://example.com"
    check redactedUrl("https://example.com#token") == "https://example.com"
    check redactedUrl("http://example.com:/x") == "http://example.com"
    check redactedUrl("  https://example.com/x  ") == "https://example.com"
    check redactedUrl("https://example.com\\pk_abc") == "https://example.com"

  test "drops userinfo, up to the last @":
    check redactedUrl("http://user:pa@ss@192.168.1.1:8123/api") == "http://192.168.1.1:8123"
    check redactedUrl("rtsp://admin:hunter2@cam.local/stream") == "rtsp://cam.local"
    check redactedUrl("https://user:secret@/x") == InvalidUrlText

  test "IPv6 hosts keep their brackets":
    check redactedUrl("http://[fe80::1]:8080/x") == "http://[fe80::1]:8080"
    check redactedUrl("https://[2001:DB8::1]/") == "https://[2001:db8::1]"
    check redactedUrl("https://[::ffff:192.168.0.1]/x") == "https://[::ffff:192.168.0.1]"
    check redactedUrl("https://[::1/") == InvalidUrlText
    check redactedUrl("https://[::1]x/") == InvalidUrlText
    check redactedUrl("https://[]/") == InvalidUrlText
    check redactedUrl("https://[pk_abc]/") == InvalidUrlText

  test "anything that is not scheme://host is a fixed placeholder, never the input":
    for garbage in ["", "   ", "example.com/path?key=1", "pk_abc", "://host/x",
        "https:///pk_abc", "https:/host/x", "1http://host/", "ht tp://host/",
        "https://host:80x/", "https://host:123456/", "https://sec ret/",
        "https://host\"pk_abc/", "/api/photos/shared/pk_abc/photo",
        "data:image/png;base64,iVBOR?u=http://x/"]:
      check redactedUrl(garbage) == InvalidUrlText

suite "redactedUrlsIn":
  test "cuts every URL in a text down to its origin":
    check redactedUrlsIn("HTTP request failed: " & ShareFile) ==
      "HTTP request failed: https://cloud.frameos.net"
    check redactedUrlsIn("deadline has passed (" & ShareFile & ").") ==
      "deadline has passed (https://cloud.frameos.net)."
    check redactedUrlsIn("navigating to \"https://ha.local:8123/lovelace?token=x\", waiting") ==
      "navigating to \"https://ha.local:8123\", waiting"
    check redactedUrlsIn("a https://a.example/x and http://b.example/y?k=1") ==
      "a https://a.example and http://b.example"

  test "leaves a text without URLs alone":
    for text in ["", "connect failed: ESP_ERR_HTTP_CONNECT", "HTTP 404: {\"detail\":\"Not Found\"}",
        "odd :// marker", "://"]:
      check redactedUrlsIn(text) == text

  test "a URL that does not parse still loses what follows the marker":
    let text = redactedUrlsIn("failed: https:///pk_abc?x=1 then")
    check text == "failed: " & InvalidUrlText & " then"
    check "pk_abc" notin text
