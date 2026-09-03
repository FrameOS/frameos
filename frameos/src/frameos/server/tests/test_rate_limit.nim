import std/[unittest, os]
import mummy
import ../rate_limit

proc makeRequest(remoteAddress: string): Request =
  result = create(RequestObj)
  result.httpMethod = "GET"
  result.path = "/api/cloud/login/options"
  result.remoteAddress = remoteAddress

suite "request rate limiting":
  setup:
    resetRateLimits()

  test "allows a burst up to the limit and rejects the next request":
    let request = makeRequest("10.0.0.5")
    for _ in 1 .. 3:
      check rateLimitExceeded(request, "test:bucket", 3, 60.0) == false
    check rateLimitExceeded(request, "test:bucket", 3, 60.0) == true

  test "budgets are per client address":
    let noisy = makeRequest("10.0.0.5")
    let quiet = makeRequest("10.0.0.6")
    for _ in 1 .. 4:
      discard rateLimitExceeded(noisy, "test:bucket", 3, 60.0)
    check rateLimitExceeded(noisy, "test:bucket", 3, 60.0) == true
    # The flood above must not have spent the other client's budget.
    check rateLimitExceeded(quiet, "test:bucket", 3, 60.0) == false

  test "budgets are per bucket":
    let request = makeRequest("10.0.0.5")
    for _ in 1 .. 4:
      discard rateLimitExceeded(request, "bucket:a", 3, 60.0)
    check rateLimitExceeded(request, "bucket:a", 3, 60.0) == true
    check rateLimitExceeded(request, "bucket:b", 3, 60.0) == false

  test "the window reopens once it has passed":
    let request = makeRequest("10.0.0.5")
    check rateLimitExceeded(request, "test:short", 1, 0.2) == false
    check rateLimitExceeded(request, "test:short", 1, 0.2) == true
    sleep(250)
    check rateLimitExceeded(request, "test:short", 1, 0.2) == false

  test "retry-after is a positive whole number of seconds":
    let request = makeRequest("10.0.0.5")
    check rateLimitExceeded(request, "test:retry", 1, 30.0) == false
    check retryAfterSeconds(request, "test:retry") >= 1
    check retryAfterSeconds(request, "test:retry") <= 30

  test "a full table evicts the windows nearest expiry, not everyone":
    # 512 distinct clients, each already over budget. The first 100 got the
    # shortest windows, so they are the ones to go when a 513th arrives; a
    # client with a long window keeps its (exhausted) budget.
    for index in 0 ..< 512:
      let request = makeRequest("10.1." & $(index div 256) & "." & $(index mod 256))
      let window = if index < 100: 30.0 else: 3600.0
      for _ in 1 .. 4:
        discard rateLimitExceeded(request, "flood", 3, window)
    check rateLimitEntryCount() == 512
    check rateLimitExceeded(makeRequest("10.9.9.9"), "flood", 3, 3600.0) == false
    check rateLimitEntryCount() <= 512
    # Still over budget: its window was not the one evicted.
    check rateLimitExceeded(makeRequest("10.1.1.255"), "flood", 3, 3600.0) == true
    # The evicted short-window client starts a fresh window.
    check rateLimitExceeded(makeRequest("10.1.0.0"), "flood", 3, 30.0) == false

  test "a full table drops expired windows first":
    for index in 0 ..< 512:
      let request = makeRequest("10.2." & $(index div 256) & "." & $(index mod 256))
      let window = if index < 10: 0.1 else: 3600.0
      for _ in 1 .. 4:
        discard rateLimitExceeded(request, "expiry", 3, window)
    sleep(150)
    check rateLimitExceeded(makeRequest("10.9.9.8"), "expiry", 3, 3600.0) == false
    # Only the ten expired windows were dropped; every long window survived.
    check rateLimitEntryCount() == 512 - 10 + 1
    check rateLimitExceeded(makeRequest("10.2.0.10"), "expiry", 3, 3600.0) == true

  test "a zero limit disables the check":
    let request = makeRequest("10.0.0.5")
    for _ in 1 .. 50:
      check rateLimitExceeded(request, "test:off", 0, 60.0) == false
