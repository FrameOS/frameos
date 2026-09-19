#include "pk_hotspot.h"

#include <stdbool.h>
#include <string.h>

// ------------------------------------------------------------------ DHCP

#define DHCP_FIXED_LEN 236u // BOOTP header up to the magic cookie
#define DHCP_OPTIONS_OFFSET 240u
#define DHCP_DISCOVER 1
#define DHCP_OFFER 2
#define DHCP_REQUEST 3
#define DHCP_ACK 5
#define DHCP_NAK 6
#define DHCP_LEASE_SECONDS 3600u

static const uint8_t DHCP_COOKIE[4] = {0x63, 0x82, 0x53, 0x63};
static const uint8_t HOTSPOT_IP[4] = {PK_HOTSPOT_IP0, PK_HOTSPOT_IP1, PK_HOTSPOT_IP2, PK_HOTSPOT_IP3};
// RFC 8910: tells a client outright that this network has a portal and where.
static const char CAPTIVE_URL[] = "http://" PK_HOTSPOT_IP_STRING "/";

void pk_dhcp_init(pk_dhcp_server_t *server)
{
    memset(server, 0, sizeof(*server));
}

// The value of one option, or NULL. Walks the TLV list defensively: a length
// that runs past the packet ends the search.
static const uint8_t *find_option(const uint8_t *packet, size_t len, uint8_t code, uint8_t *out_len)
{
    size_t i = DHCP_OPTIONS_OFFSET;
    while (i < len) {
        uint8_t option = packet[i];
        if (option == 255) break;
        if (option == 0) {
            i++;
            continue;
        }
        if (i + 1 >= len) break;
        uint8_t option_len = packet[i + 1];
        if (i + 2 + option_len > len) break;
        if (option == code) {
            *out_len = option_len;
            return packet + i + 2;
        }
        i += 2u + option_len;
    }
    return NULL;
}

static int lease_for(pk_dhcp_server_t *server, const uint8_t *mac)
{
    for (int i = 0; i < PK_HOTSPOT_LEASES; i++) {
        if (server->used[i] && memcmp(server->mac[i], mac, 6) == 0) return i;
    }
    int slot = -1;
    for (int i = 0; i < PK_HOTSPOT_LEASES; i++) {
        if (!server->used[i]) {
            slot = i;
            break;
        }
    }
    if (slot < 0) {
        // A setup hotspot sees a handful of clients over its whole life;
        // when all eight are taken the oldest assignment is recycled.
        slot = server->next_victim;
        server->next_victim = (uint8_t)((server->next_victim + 1) % PK_HOTSPOT_LEASES);
    }
    memcpy(server->mac[slot], mac, 6);
    server->used[slot] = 1;
    return slot;
}

static size_t put_option(uint8_t *reply, size_t at, uint8_t code, const void *data, uint8_t len)
{
    reply[at++] = code;
    reply[at++] = len;
    memcpy(reply + at, data, len);
    return at + len;
}

size_t pk_dhcp_handle(pk_dhcp_server_t *server, const uint8_t *request, size_t len,
                      uint8_t *reply, size_t reply_cap)
{
    if (len < DHCP_OPTIONS_OFFSET + 3 || reply_cap < 320) return 0;
    if (request[0] != 1 /* BOOTREQUEST */ || request[1] != 1 /* ethernet */ || request[2] != 6) {
        return 0;
    }
    if (memcmp(request + DHCP_FIXED_LEN, DHCP_COOKIE, 4) != 0) return 0;

    uint8_t option_len = 0;
    const uint8_t *type = find_option(request, len, 53, &option_len);
    if (type == NULL || option_len != 1) return 0;
    if (*type != DHCP_DISCOVER && *type != DHCP_REQUEST) return 0;

    const uint8_t *mac = request + 28; // chaddr
    int slot = lease_for(server, mac);
    uint8_t offered[4] = {PK_HOTSPOT_IP0, PK_HOTSPOT_IP1, PK_HOTSPOT_IP2,
                          (uint8_t)(PK_HOTSPOT_FIRST_LEASE + slot)};

    uint8_t reply_type = *type == DHCP_DISCOVER ? DHCP_OFFER : DHCP_ACK;
    if (*type == DHCP_REQUEST) {
        // A REQUEST for another server's offer is not ours to answer; one for
        // an address we would not hand this client is refused so it restarts.
        const uint8_t *server_id = find_option(request, len, 54, &option_len);
        if (server_id != NULL && (option_len != 4 || memcmp(server_id, HOTSPOT_IP, 4) != 0)) {
            return 0;
        }
        const uint8_t *wanted = find_option(request, len, 50, &option_len);
        if (wanted == NULL || option_len != 4) {
            wanted = request + 12; // ciaddr (renewal)
        }
        static const uint8_t none[4] = {0, 0, 0, 0};
        if (memcmp(wanted, none, 4) != 0 && memcmp(wanted, offered, 4) != 0) {
            reply_type = DHCP_NAK;
        }
    }

    memset(reply, 0, 320);
    reply[0] = 2; // BOOTREPLY
    reply[1] = 1;
    reply[2] = 6;
    memcpy(reply + 4, request + 4, 4);   // xid
    memcpy(reply + 10, request + 10, 2); // flags
    if (reply_type != DHCP_NAK) memcpy(reply + 16, offered, 4); // yiaddr
    memcpy(reply + 20, HOTSPOT_IP, 4);   // siaddr
    memcpy(reply + 24, request + 24, 4); // giaddr
    memcpy(reply + 28, request + 28, 16); // chaddr
    memcpy(reply + DHCP_FIXED_LEN, DHCP_COOKIE, 4);

    size_t at = DHCP_OPTIONS_OFFSET;
    at = put_option(reply, at, 53, &reply_type, 1);
    at = put_option(reply, at, 54, HOTSPOT_IP, 4);
    if (reply_type != DHCP_NAK) {
        static const uint8_t mask[4] = {255, 255, 255, 0};
        uint8_t lease[4] = {(uint8_t)(DHCP_LEASE_SECONDS >> 24), (uint8_t)(DHCP_LEASE_SECONDS >> 16),
                            (uint8_t)(DHCP_LEASE_SECONDS >> 8), (uint8_t)DHCP_LEASE_SECONDS};
        at = put_option(reply, at, 51, lease, 4);
        at = put_option(reply, at, 1, mask, 4);
        at = put_option(reply, at, 3, HOTSPOT_IP, 4);
        at = put_option(reply, at, 6, HOTSPOT_IP, 4);
        at = put_option(reply, at, 114, CAPTIVE_URL, (uint8_t)(sizeof(CAPTIVE_URL) - 1));
    }
    reply[at++] = 255;
    // Some clients drop replies shorter than the BOOTP minimum.
    return at < 300 ? 300 : at;
}

// ------------------------------------------------------------------- DNS

#define DNS_HEADER_LEN 12u

size_t pk_dns_hijack(const uint8_t *query, size_t len, uint8_t *reply, size_t reply_cap)
{
    if (len < DNS_HEADER_LEN + 5) return 0;
    if (query[2] & 0x80) return 0;                // a response, not a query
    if (((query[2] >> 3) & 0x0F) != 0) return 0;  // opcode: standard query only
    if (query[4] != 0 || query[5] != 1) return 0; // exactly one question

    // Walk the question name; compression pointers have no business here.
    size_t i = DNS_HEADER_LEN;
    while (i < len && query[i] != 0) {
        if (query[i] & 0xC0) return 0;
        i += 1u + query[i];
    }
    if (i + 5 > len) return 0;
    size_t question_end = i + 5; // root label + QTYPE + QCLASS
    uint16_t qtype = (uint16_t)((query[i + 1] << 8) | query[i + 2]);
    bool answer = qtype == 1 /* A */ || qtype == 255 /* ANY */;

    size_t total = question_end + (answer ? 16u : 0u);
    if (total > reply_cap) return 0;
    memcpy(reply, query, question_end);
    reply[2] = (uint8_t)(0x80 | 0x04 | (query[2] & 0x01)); // QR, AA, echo RD
    reply[3] = 0x80;                                       // RA, NOERROR
    reply[6] = 0;
    reply[7] = answer ? 1 : 0;
    reply[8] = reply[9] = reply[10] = reply[11] = 0; // no authority/additional (drops EDNS)
    if (answer) {
        uint8_t *rr = reply + question_end;
        rr[0] = 0xC0; // name: pointer to the question
        rr[1] = (uint8_t)DNS_HEADER_LEN;
        rr[2] = 0; rr[3] = 1; // A
        rr[4] = 0; rr[5] = 1; // IN
        rr[6] = 0; rr[7] = 0; rr[8] = 0; rr[9] = 30; // TTL: short, the portal is temporary
        rr[10] = 0; rr[11] = 4;
        rr[12] = PK_HOTSPOT_IP0; rr[13] = PK_HOTSPOT_IP1;
        rr[14] = PK_HOTSPOT_IP2; rr[15] = PK_HOTSPOT_IP3;
    }
    return total;
}

// --------------------------------------------------------------- passphrase

// Readable and unambiguous on a small e-paper panel: no 0/O, 1/l/I. 31
// symbols, so bytes >= 248 (= 8 * 31) are rejected rather than folded, which
// would make the first few symbols likelier — this is a WPA2 passphrase.
static const char PSK_ALPHABET[] = "abcdefghjkmnpqrstuvwxyz23456789";

void pk_hotspot_mint_psk(uint32_t (*random32)(void), char *dst)
{
    size_t n = 0;
    while (n < PK_HOTSPOT_PSK_LEN) {
        uint32_t word = random32();
        for (int i = 0; i < 4 && n < PK_HOTSPOT_PSK_LEN; i++) {
            uint8_t byte = (uint8_t)(word >> (8 * i));
            if (byte >= 248) continue;
            dst[n++] = PSK_ALPHABET[byte % (sizeof(PSK_ALPHABET) - 1)];
        }
    }
    dst[n] = '\0';
}
