// lwIP configuration for the FrameOS Pico thin client.
//
// NO_SYS polling mode (pico_cyw43_arch_lwip_poll): single-threaded, no OS,
// callbacks run from cyw43_arch_poll(). Sized for one outbound HTTP(S)
// connection streaming a ~200KB body, plus the device's own small HTTP
// server (4 connections) and, in setup-hotspot mode, DHCP + DNS responders —
// larger TCP windows just waste the 264KB of SRAM the Pico W has.
#ifndef LWIPOPTS_H
#define LWIPOPTS_H

#define NO_SYS 1
#define LWIP_SOCKET 0
#define LWIP_NETCONN 0

#define MEM_LIBC_MALLOC 0
#define MEM_ALIGNMENT 4
// tcp_write(COPY) for the device server's responses and the log upload body
// come out of this heap.
#define MEM_SIZE 16000
#define MEMP_NUM_TCP_SEG 32
#define MEMP_NUM_ARP_QUEUE 10
#define PBUF_POOL_SIZE 24
// Client connection + 4 server connections + slack for TIME_WAIT.
#define MEMP_NUM_TCP_PCB 8
#define MEMP_NUM_TCP_PCB_LISTEN 2
// DHCP client, DNS client, SNTP, mDNS, and the hotspot's DHCP + DNS servers.
#define MEMP_NUM_UDP_PCB 8

#define LWIP_ARP 1
#define LWIP_ETHERNET 1
#define LWIP_ICMP 1
#define LWIP_RAW 1

// At least one whole TLS record (MBEDTLS_SSL_IN_CONTENT_LEN, 16 KB, plus
// overhead): altcp_tls only reopens the window once a record decodes, so a
// smaller one deadlocks on the first full-size record of an https download.
#define TCP_WND (12 * TCP_MSS)
#define TCP_MSS 1460
#define TCP_SND_BUF (8 * TCP_MSS)
#define TCP_SND_QUEUELEN ((4 * (TCP_SND_BUF) + (TCP_MSS - 1)) / (TCP_MSS))
#define TCP_LISTEN_BACKLOG 1

#define LWIP_NETIF_STATUS_CALLBACK 1
#define LWIP_NETIF_LINK_CALLBACK 1
#define LWIP_NETIF_HOSTNAME 1
#define LWIP_NETCONN_FULLDUPLEX 0

#define LWIP_DHCP 1
#define LWIP_IPV4 1
#define LWIP_TCP 1
#define LWIP_UDP 1
#define LWIP_DNS 1
#define LWIP_TCP_KEEPALIVE 1

// mDNS responder: the backend addresses an embedded frame as frame<N>.local.
#define LWIP_IGMP 1
#define LWIP_MDNS_RESPONDER 1
#define LWIP_NUM_NETIF_CLIENT_DATA 1
#define MDNS_MAX_SERVICES 1
// Running out of these is an assert (= panic); mDNS alone takes ten.
#define MEMP_NUM_SYS_TIMEOUT (LWIP_NUM_SYS_TIMEOUT_INTERNAL + 16)

#define LWIP_STATS 0
#define LWIP_STATS_DISPLAY 0
#define MEM_STATS 0
#define SYS_STATS 0
#define MEMP_STATS 0
#define LINK_STATS 0

#define LWIP_CHKSUM_ALGORITHM 3
#define LWIP_DHCP_DOES_ACD_CHECK 0

// TLS via mbedTLS behind lwIP's altcp layer (https backends + hostname
// verification against the embedded CA roots).
#define LWIP_ALTCP 1
#define LWIP_ALTCP_TLS 1
#define LWIP_ALTCP_TLS_MBEDTLS 1

// SNTP for certificate validity checks and log timestamps (pk_time.c).
#define SNTP_SERVER_DNS 1
#ifndef __ASSEMBLER__
void pk_time_set(unsigned long epoch_seconds);
#endif
#define SNTP_SET_SYSTEM_TIME(sec) pk_time_set(sec)

#endif // LWIPOPTS_H
