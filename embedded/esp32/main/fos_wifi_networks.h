/*
 * The list of networks a scan found, as the frame settings show it. Plain C,
 * no IDF: host tested by main/tests/test_fos_wifi_networks.c.
 */
#pragma once

#include <stdint.h>

#define FOS_WIFI_SCAN_MAX 64
typedef struct {
    char ssid[33];
    int8_t rssi;
} fos_wifi_network_t;

/* Puts the list in the order a person looks a name up in: by name, case
 * ignored (ASCII letters; any other byte as it is, so UTF-8 names come
 * after), and names alike but for their case by their bytes. */
void fos_wifi_networks_sort(fos_wifi_network_t *networks, int count);
