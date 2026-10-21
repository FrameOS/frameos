// The setup hotspot's DHCP server and captive-portal DNS as packet functions,
// and the passphrase minting.
#include "pk_hotspot.h"
#include "pk_test.h"

// A minimal DHCP client packet: BOOTP header + cookie + options.
static size_t dhcp_packet(uint8_t *out, uint8_t type, const uint8_t mac[6], const uint8_t *requested,
                          const uint8_t *server_id)
{
    memset(out, 0, 300);
    out[0] = 1; // BOOTREQUEST
    out[1] = 1;
    out[2] = 6;
    out[4] = 0xDE; out[5] = 0xAD; out[6] = 0xBE; out[7] = 0xEF; // xid
    out[10] = 0x80;                                              // broadcast flag
    memcpy(out + 28, mac, 6);
    out[236] = 0x63; out[237] = 0x82; out[238] = 0x53; out[239] = 0x63;
    size_t at = 240;
    out[at++] = 53; out[at++] = 1; out[at++] = type;
    if (requested) {
        out[at++] = 50; out[at++] = 4;
        memcpy(out + at, requested, 4);
        at += 4;
    }
    if (server_id) {
        out[at++] = 54; out[at++] = 4;
        memcpy(out + at, server_id, 4);
        at += 4;
    }
    out[at++] = 255;
    return 300;
}

static const uint8_t *option(const uint8_t *packet, size_t len, uint8_t code, uint8_t *out_len)
{
    size_t i = 240;
    while (i + 1 < len && packet[i] != 255) {
        if (packet[i] == 0) {
            i++;
            continue;
        }
        if (packet[i] == code) {
            *out_len = packet[i + 1];
            return packet + i + 2;
        }
        i += 2u + packet[i + 1];
    }
    return NULL;
}

static void test_dhcp(void)
{
    pk_dhcp_server_t server;
    pk_dhcp_init(&server);
    uint8_t request[600], reply[320];
    const uint8_t phone[6] = {0x02, 0x11, 0x22, 0x33, 0x44, 0x55};
    const uint8_t laptop[6] = {0x02, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE};
    const uint8_t us[4] = {192, 168, 4, 1};
    uint8_t len8 = 0;

    // DISCOVER → OFFER
    size_t len = dhcp_packet(request, 1, phone, NULL, NULL);
    size_t reply_len = pk_dhcp_handle(&server, request, len, reply, sizeof(reply));
    CHECK(reply_len >= 300);
    CHECK(reply[0] == 2);
    CHECK(memcmp(reply + 4, request + 4, 4) == 0); // xid echoed
    CHECK(memcmp(reply + 28, phone, 6) == 0);
    const uint8_t offered[4] = {192, 168, 4, PK_HOTSPOT_FIRST_LEASE};
    CHECK(memcmp(reply + 16, offered, 4) == 0);
    const uint8_t *value = option(reply, reply_len, 53, &len8);
    CHECK(value && *value == 2);
    value = option(reply, reply_len, 6, &len8); // DNS = us: that is the captive portal
    CHECK(value && len8 == 4 && memcmp(value, us, 4) == 0);
    value = option(reply, reply_len, 3, &len8);
    CHECK(value && memcmp(value, us, 4) == 0);
    value = option(reply, reply_len, 114, &len8); // RFC 8910 captive-portal URL
    CHECK(value && len8 == strlen("http://192.168.4.1/") && memcmp(value, "http://192.168.4.1/", len8) == 0);

    // REQUEST for that address → ACK
    len = dhcp_packet(request, 3, phone, offered, us);
    reply_len = pk_dhcp_handle(&server, request, len, reply, sizeof(reply));
    value = option(reply, reply_len, 53, &len8);
    CHECK(value && *value == 5);
    CHECK(memcmp(reply + 16, offered, 4) == 0);

    // The same client keeps its address; a second client gets the next one.
    len = dhcp_packet(request, 1, phone, NULL, NULL);
    pk_dhcp_handle(&server, request, len, reply, sizeof(reply));
    CHECK(reply[19] == PK_HOTSPOT_FIRST_LEASE);
    len = dhcp_packet(request, 1, laptop, NULL, NULL);
    pk_dhcp_handle(&server, request, len, reply, sizeof(reply));
    CHECK(reply[19] == PK_HOTSPOT_FIRST_LEASE + 1);

    // A REQUEST for an address from the phone's home network → NAK, so it
    // starts over instead of squatting on 10.0.0.23 inside our /24.
    const uint8_t home[4] = {10, 0, 0, 23};
    len = dhcp_packet(request, 3, phone, home, NULL);
    reply_len = pk_dhcp_handle(&server, request, len, reply, sizeof(reply));
    value = option(reply, reply_len, 53, &len8);
    CHECK(value && *value == 6);
    const uint8_t none[4] = {0, 0, 0, 0};
    CHECK(memcmp(reply + 16, none, 4) == 0);

    // A REQUEST naming another DHCP server is not ours to answer.
    const uint8_t other[4] = {192, 168, 4, 254};
    len = dhcp_packet(request, 3, phone, offered, other);
    CHECK(pk_dhcp_handle(&server, request, len, reply, sizeof(reply)) == 0);

    // More clients than leases: addresses are recycled, never run off the pool.
    for (int i = 0; i < 40; i++) {
        uint8_t mac[6] = {0x02, 0, 0, 0, 1, (uint8_t)i};
        len = dhcp_packet(request, 1, mac, NULL, NULL);
        CHECK(pk_dhcp_handle(&server, request, len, reply, sizeof(reply)) >= 300);
        CHECK(reply[19] >= PK_HOTSPOT_FIRST_LEASE && reply[19] < PK_HOTSPOT_FIRST_LEASE + PK_HOTSPOT_LEASES);
    }

    // Junk: short, wrong op, no cookie, RELEASE, truncated options, tiny reply buffer.
    CHECK(pk_dhcp_handle(&server, request, 100, reply, sizeof(reply)) == 0);
    len = dhcp_packet(request, 1, phone, NULL, NULL);
    request[0] = 2;
    CHECK(pk_dhcp_handle(&server, request, len, reply, sizeof(reply)) == 0);
    len = dhcp_packet(request, 1, phone, NULL, NULL);
    request[236] = 0;
    CHECK(pk_dhcp_handle(&server, request, len, reply, sizeof(reply)) == 0);
    len = dhcp_packet(request, 7, phone, NULL, NULL);
    CHECK(pk_dhcp_handle(&server, request, len, reply, sizeof(reply)) == 0);
    len = dhcp_packet(request, 1, phone, NULL, NULL);
    request[241] = 200; // option 53 claims 200 bytes in a packet that ends sooner
    CHECK(pk_dhcp_handle(&server, request, 244, reply, sizeof(reply)) == 0);
    len = dhcp_packet(request, 1, phone, NULL, NULL);
    CHECK(pk_dhcp_handle(&server, request, len, reply, 100) == 0);
}

static size_t dns_query(uint8_t *out, const char *name, uint16_t qtype)
{
    memset(out, 0, 12);
    out[0] = 0x12; out[1] = 0x34; // id
    out[2] = 0x01;                // RD
    out[5] = 1;                   // QDCOUNT
    size_t at = 12;
    while (*name) {
        const char *dot = strchr(name, '.');
        size_t label = dot ? (size_t)(dot - name) : strlen(name);
        out[at++] = (uint8_t)label;
        memcpy(out + at, name, label);
        at += label;
        name += label + (dot ? 1 : 0);
    }
    out[at++] = 0;
    out[at++] = (uint8_t)(qtype >> 8);
    out[at++] = (uint8_t)qtype;
    out[at++] = 0;
    out[at++] = 1; // IN
    return at;
}

static void test_dns(void)
{
    uint8_t query[512], reply[512 + 16];
    // What an iPhone asks the moment it joins.
    size_t len = dns_query(query, "captive.apple.com", 1);
    size_t reply_len = pk_dns_hijack(query, len, reply, sizeof(reply));
    CHECK(reply_len == len + 16);
    CHECK(reply[0] == 0x12 && reply[1] == 0x34);
    CHECK((reply[2] & 0x80) != 0);          // a response
    CHECK((reply[3] & 0x0F) == 0);          // NOERROR
    CHECK(reply[7] == 1);                   // one answer
    CHECK(memcmp(reply + 12, query + 12, len - 12) == 0); // question echoed
    const uint8_t *rr = reply + len;
    CHECK(rr[0] == 0xC0 && rr[1] == 12);    // name → the question
    CHECK(rr[3] == 1 && rr[5] == 1 && rr[11] == 4);
    CHECK(rr[12] == 192 && rr[13] == 168 && rr[14] == 4 && rr[15] == 1);

    // AAAA gets an empty NOERROR so the resolver settles on the A answer.
    len = dns_query(query, "connectivitycheck.gstatic.com", 28);
    reply_len = pk_dns_hijack(query, len, reply, sizeof(reply));
    CHECK(reply_len == len && reply[7] == 0 && (reply[3] & 0x0F) == 0);

    // Not a plain query: a response, two questions, a compressed name, a
    // name running off the end, no room for the reply.
    len = dns_query(query, "a.b", 1);
    query[2] |= 0x80;
    CHECK(pk_dns_hijack(query, len, reply, sizeof(reply)) == 0);
    len = dns_query(query, "a.b", 1);
    query[5] = 2;
    CHECK(pk_dns_hijack(query, len, reply, sizeof(reply)) == 0);
    len = dns_query(query, "a.b", 1);
    query[12] = 0xC0;
    CHECK(pk_dns_hijack(query, len, reply, sizeof(reply)) == 0);
    len = dns_query(query, "a.b", 1);
    query[12] = 60; // label longer than the packet
    CHECK(pk_dns_hijack(query, len, reply, sizeof(reply)) == 0);
    len = dns_query(query, "a.b", 1);
    CHECK(pk_dns_hijack(query, len, reply, len + 15) == 0);
    CHECK(pk_dns_hijack(query, 5, reply, sizeof(reply)) == 0);
}

static uint32_t s_random_state = 1;
static uint32_t fake_random(void)
{
    s_random_state = s_random_state * 1664525u + 1013904223u;
    return s_random_state;
}

static uint32_t all_ones(void)
{
    static int calls = 0;
    // Bytes >= 248 are rejected, so a source stuck at 0xFF must not loop
    // forever in a test: hand over usable bytes after a while.
    return ++calls < 50 ? 0xFFFFFFFFu : 0x01020304u;
}

static void test_psk(void)
{
    char psk[PK_HOTSPOT_PSK_LEN + 1];
    char previous[PK_HOTSPOT_PSK_LEN + 1] = "";
    for (int round = 0; round < 200; round++) {
        pk_hotspot_mint_psk(fake_random, psk);
        CHECK(strlen(psk) == PK_HOTSPOT_PSK_LEN); // WPA2 needs 8..63
        for (size_t i = 0; psk[i]; i++) {
            // Nothing a person misreads off e-paper: no 0/O, 1/l/I.
            CHECK(strchr("abcdefghjkmnpqrstuvwxyz23456789", psk[i]) != NULL);
        }
        CHECK(strcmp(psk, previous) != 0);
        memcpy(previous, psk, sizeof(psk));
    }
    pk_hotspot_mint_psk(all_ones, psk);
    CHECK(strlen(psk) == PK_HOTSPOT_PSK_LEN);
}

int main(void)
{
    test_dhcp();
    test_dns();
    test_psk();
    return pk_test_result("test_pk_hotspot");
}
