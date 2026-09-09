import unittest

import ../origin

suite "same-origin guard: Origin vs Host":
  test "a page served by this frame matches, whatever the case or default port":
    check originMatchesHost("http://192.168.1.50:8787", "192.168.1.50:8787")
    check originMatchesHost("http://Frame.local:8787", "frame.local:8787")
    check originMatchesHost("http://frame.local", "frame.local:80")
    check originMatchesHost("http://frame.local", "frame.local")
    check originMatchesHost("https://frame.local", "frame.local", requestIsHttps = true)
    check originMatchesHost("https://frame.local:8443", "frame.local:8443")
    check originMatchesHost("http://[fe80::1]:8787", "[FE80::1]:8787")
    check originMatchesHost("http://localhost:8787", "localhost:8787")

  test "another site, another port or an opaque origin does not":
    check not originMatchesHost("http://evil.example", "192.168.1.50:8787")
    check not originMatchesHost("http://192.168.1.50:3000", "192.168.1.50:8787")
    check not originMatchesHost("https://frame.local", "frame.local")
    check not originMatchesHost("http://frame.local", "frame.local", requestIsHttps = true)
    check not originMatchesHost("null", "192.168.1.50:8787")
    check not originMatchesHost("", "192.168.1.50:8787")
    check not originMatchesHost("http://192.168.1.50:8787/", "192.168.1.50:8787")
    check not originMatchesHost("ftp://frame.local", "frame.local")
    check not originMatchesHost("http://frame.local:abc", "frame.local:8787")
    check not originMatchesHost("http://frame.local:8787", "")
    check not originMatchesHost("http://[fe80::1", "[fe80::1]:80")

  test "a proxy that rewrote Host is trusted through X-Forwarded-Host":
    check originMatchesHost("https://frame.example.com", "127.0.0.1:8787",
      forwardedHost = "frame.example.com", requestIsHttps = true)
    check originMatchesHost("https://frame.example.com", "127.0.0.1:8787",
      forwardedHost = "frame.example.com, inner.proxy", requestIsHttps = true)
    check not originMatchesHost("https://evil.example", "127.0.0.1:8787",
      forwardedHost = "frame.example.com", requestIsHttps = true)
