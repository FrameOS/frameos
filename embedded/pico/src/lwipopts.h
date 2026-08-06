// lwIP configuration for the FrameOS Pico thin client.
//
// NO_SYS polling mode (pico_cyw43_arch_lwip_poll): single-threaded, no OS,
// callbacks run from cyw43_arch_poll(). Sized for exactly one outbound HTTP
// connection streaming a ~200KB body — larger TCP windows just waste the
// 264KB of SRAM the Pico W has.
#ifndef LWIPOPTS_H
#define LWIPOPTS_H

#define NO_SYS 1
#define LWIP_SOCKET 0
#define LWIP_NETCONN 0

#define MEM_LIBC_MALLOC 0
#define MEM_ALIGNMENT 4
#define MEM_SIZE 8000
#define MEMP_NUM_TCP_SEG 32
#define MEMP_NUM_ARP_QUEUE 10
#define PBUF_POOL_SIZE 24

#define LWIP_ARP 1
#define LWIP_ETHERNET 1
#define LWIP_ICMP 1
#define LWIP_RAW 1

#define TCP_WND (8 * TCP_MSS)
#define TCP_MSS 1460
#define TCP_SND_BUF (8 * TCP_MSS)
#define TCP_SND_QUEUELEN ((4 * (TCP_SND_BUF) + (TCP_MSS - 1)) / (TCP_MSS))

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

#define LWIP_STATS 0
#define LWIP_STATS_DISPLAY 0
#define MEM_STATS 0
#define SYS_STATS 0
#define MEMP_STATS 0
#define LINK_STATS 0

#define LWIP_CHKSUM_ALGORITHM 3
#define LWIP_DHCP_DOES_ACD_CHECK 0

#endif // LWIPOPTS_H
