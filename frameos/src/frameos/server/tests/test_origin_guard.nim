import std/[json, strutils, unittest]

import ./helpers/http_harness

var server = startRouterServer(19336)

suite "same-origin guard on the router":
  setup:
    drainEventChannel()
    configureServerState(defaultFrameConfig())

  let ownOrigin = "http://127.0.0.1:" & $server.port

  test "a cross-site POST is refused before the route runs":
    let foreign = httpRequest(
      server.port,
      "POST",
      "/api/admin/login",
      headers = [("Origin", "http://evil.example"), ("Content-Type", "application/json")],
      body = $(%*{"username": "admin", "password": "secret"}),
    )
    check foreign.status == 403
    check foreign.body.contains("Cross-origin")

    let opaque = httpRequest(
      server.port,
      "POST",
      "/api/admin/login",
      headers = [("Origin", "null"), ("Content-Type", "application/json")],
      body = $(%*{"username": "admin", "password": "secret"}),
    )
    check opaque.status == 403

  test "the frame's own pages and origin-less clients reach the route":
    # Admin auth is disabled in the default config, so reaching the route
    # means a 401 with its own message rather than the guard's 403.
    let own = httpRequest(
      server.port,
      "POST",
      "/api/admin/login",
      headers = [("Origin", ownOrigin), ("Content-Type", "application/json")],
      body = $(%*{"username": "admin", "password": "secret"}),
    )
    check own.status == 401
    check own.body.contains("Admin auth disabled")

    let noOrigin = httpRequest(
      server.port,
      "POST",
      "/api/admin/login",
      headers = [("Content-Type", "application/json")],
      body = $(%*{"username": "admin", "password": "secret"}),
    )
    check noOrigin.status == 401

    # Behind a proxy that rewrote Host (the setup TLS proxy keeps it; a
    # user's own nginx may not), X-Forwarded-Host still names the frame.
    let proxied = httpRequest(
      server.port,
      "POST",
      "/api/admin/login",
      headers = [
        ("Origin", "https://frame.example.com"),
        ("X-Forwarded-Host", "frame.example.com"),
        ("X-Forwarded-Proto", "https"),
        ("Content-Type", "application/json"),
      ],
      body = $(%*{"username": "admin", "password": "secret"}),
    )
    check proxied.status == 401

  test "reads are not gated, WebSocket handshakes are":
    let read = httpRequest(
      server.port,
      "GET",
      "/api/admin/session",
      headers = [("Origin", "http://evil.example")],
    )
    check read.status == 200

    let foreignSocket = httpRequest(
      server.port,
      "GET",
      "/ws/admin",
      headers = [
        ("Origin", "http://evil.example"),
        ("Upgrade", "websocket"),
        ("Connection", "Upgrade"),
        ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="),
        ("Sec-WebSocket-Version", "13"),
      ],
    )
    check foreignSocket.status == 403

    let ownSocket = httpRequest(
      server.port,
      "GET",
      "/ws/admin",
      headers = [
        ("Origin", ownOrigin),
        ("Upgrade", "websocket"),
        ("Connection", "Upgrade"),
        ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="),
        ("Sec-WebSocket-Version", "13"),
      ],
    )
    # Past the guard: the route's own admin check answers.
    check ownSocket.status == 401
