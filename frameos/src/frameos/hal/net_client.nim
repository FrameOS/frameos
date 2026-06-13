## Outbound-HTTP HAL.
##
## Linux uses the bounded std/net-based client in utils/http_client (OpenSSL).
## The embedded build talks HTTP(S) through esp_http_client/mbedTLS on the C
## side instead, so importing this module there is a compile-time error —
## Nim code that fetches URLs must stay out of the embedded dependency graph.

when defined(frameosEmbedded):
  {.error: "frameos/hal/net_client: use esp_http_client via the firmware on embedded targets".}
else:
  import frameos/utils/http_client
  export http_client
