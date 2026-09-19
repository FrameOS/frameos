// The setup hotspot's two tiny servers, as pure packet functions: a DHCP
// server that leases 192.168.4.16-23 and a DNS responder that answers every
// name with the hotspot's own address, which is what makes a phone pop its
// captive-portal sheet. pk_wifi_ap.c binds them to lwIP UDP sockets; here
// they are request bytes in, reply bytes out, so they are host-tested
// (tests/test_pk_hotspot.c). Also mints the hotspot passphrase.
#ifndef PK_HOTSPOT_H
#define PK_HOTSPOT_H

#include <stddef.h>
#include <stdint.h>

#define PK_HOTSPOT_IP0 192
#define PK_HOTSPOT_IP1 168
#define PK_HOTSPOT_IP2 4
#define PK_HOTSPOT_IP3 1
#define PK_HOTSPOT_IP_STRING "192.168.4.1"
#define PK_HOTSPOT_LEASES 8
#define PK_HOTSPOT_FIRST_LEASE 16 // 192.168.4.16 …
#define PK_HOTSPOT_PSK_LEN 10

typedef struct {
    uint8_t mac[PK_HOTSPOT_LEASES][6];
    uint8_t used[PK_HOTSPOT_LEASES];
    uint8_t next_victim; // round-robin reuse once every lease is taken
} pk_dhcp_server_t;

void pk_dhcp_init(pk_dhcp_server_t *server);
// Handles DISCOVER (→OFFER) and REQUEST (→ACK/NAK). Returns the reply length,
// or 0 when the packet needs no answer. `reply` must hold 320 bytes. Replies
// are always broadcast (the client has no address yet).
size_t pk_dhcp_handle(pk_dhcp_server_t *server, const uint8_t *request, size_t len,
                      uint8_t *reply, size_t reply_cap);

// Answers an A/ANY question with the hotspot address; other types get an
// empty NOERROR so resolvers move on instead of retrying. Returns the reply
// length or 0 for anything that is not a plain single-question query.
size_t pk_dns_hijack(const uint8_t *query, size_t len, uint8_t *reply, size_t reply_cap);

// A passphrase from an ambiguity-free alphabet (no 0/O/1/l/I) — the same one
// the ESP32 mints (fos_wifi.c) — using rejection sampling so no symbol is
// favoured. `random32` is the platform's RNG. dst needs PK_HOTSPOT_PSK_LEN+1.
void pk_hotspot_mint_psk(uint32_t (*random32)(void), char *dst);

#endif // PK_HOTSPOT_H
