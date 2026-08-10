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

  test "a zero limit disables the check":
    let request = makeRequest("10.0.0.5")
    for _ in 1 .. 50:
      check rateLimitExceeded(request, "test:off", 0, 60.0) == false
