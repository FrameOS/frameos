## Monocypher 4.0.2 (vendored, unmodified) — https://monocypher.org
## Dual-licensed 2-clause BSD / CC0-1.0, see LICENCE.md.
##
## Used for Ed25519 (SHA-512 flavor, monocypher-ed25519.c) key generation and
## signing in the cloud-frame enrollment/WS-auth flow: mbedTLS in ESP-IDF does
## not expose Ed25519.
idf_component_register(
    SRCS
        "monocypher.c"
        "monocypher-ed25519.c"
    INCLUDE_DIRS
        "."
)
