/*
 * The cloud verb contract, as the firmware reads it (docs/cloud-frames-contract.json
 * → fos_cloud_contract_gen.h, the esp32 profile's tables). Pure cJSON, no
 * IDF: the same file is built on the host by main/tests/test_fos_cloud_contract.c
 * against docs/cloud-frames-fixtures.json, the corpus the Linux runtime and
 * the cloud run too.
 */
#pragma once

#include <stdbool.h>

#include "cJSON.h"

/* The verdict on a set_settings `settings` object: NULL when every key is one
 * this profile takes and every value satisfies its rule, else the error token
 * to ack — "invalid_settings" or "setting_not_allowed". One bad key refuses
 * the whole push, so provider and device never disagree about what got set. */
const char *fos_cloud_contract_check_settings(const cJSON *settings);

/* Does the firmware take this key at all (any version)? */
bool fos_cloud_contract_setting_allowed(const char *key);

/* Applying this key reboots the chip (a boot-time setting). */
bool fos_cloud_contract_setting_restarts(const char *key);

/* Is `verb` in the contract's verb table? On true, *scope (may be NULL) is
 * the scope it requires and *content says whether it is a content verb —
 * refused `backend_managed` when a self-hosted backend owns the frame. */
bool fos_cloud_contract_verb(const char *verb, const char **scope, bool *content);
