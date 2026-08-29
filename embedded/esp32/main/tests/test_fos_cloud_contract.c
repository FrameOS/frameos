/*
 * Host test: the firmware's contract walker (fos_cloud_contract.c) against
 * the conformance corpus docs/cloud-frames-fixtures.json — the same cases the
 * Linux runtime (test_cloud_contract.nim) and the cloud (vitest) run. Every
 * `settings` case's esp32 verdict must match; `verbs` cases check the table.
 *
 * Build and run (from the repo root), with cJSON from ESP-IDF:
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Iembedded/esp32/main \
 *      -I$IDF_PATH/components/json/cJSON $IDF_PATH/components/json/cJSON/cJSON.c \
 *      embedded/esp32/main/fos_cloud_contract.c \
 *      embedded/esp32/main/tests/test_fos_cloud_contract.c -lm \
 *      -o /tmp/test_fos_cloud_contract && \
 *   /tmp/test_fos_cloud_contract docs/cloud-frames-fixtures.json
 *
 * (backend/app/tasks/tests/test_esp32_cloud_contract.py does exactly that in CI.)
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "fos_cloud_contract.h"

static char *read_file(const char *path)
{
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *buf = malloc((size_t)len + 1);
    if (!buf) {
        fclose(f);
        return NULL;
    }
    size_t got = fread(buf, 1, (size_t)len, f);
    fclose(f);
    buf[got] = '\0';
    return buf;
}

int main(int argc, char **argv)
{
    if (argc != 2) {
        fprintf(stderr, "usage: %s docs/cloud-frames-fixtures.json\n", argv[0]);
        return 2;
    }
    char *text = read_file(argv[1]);
    if (!text) {
        fprintf(stderr, "cannot read %s\n", argv[1]);
        return 2;
    }
    cJSON *root = cJSON_Parse(text);
    free(text);
    if (!root) {
        fprintf(stderr, "fixtures are not JSON\n");
        return 2;
    }
    int failures = 0, checks = 0;
    const cJSON *fixture = NULL;
    cJSON_ArrayForEach(fixture, cJSON_GetObjectItem(root, "settings")) {
        const char *name = cJSON_GetStringValue(cJSON_GetObjectItem(fixture, "name"));
        const cJSON *expect = cJSON_GetObjectItem(cJSON_GetObjectItem(fixture, "expect"), "esp32");
        const char *expected = cJSON_GetStringValue(expect);
        const char *verdict = fos_cloud_contract_check_settings(cJSON_GetObjectItem(fixture, "settings"));
        const char *got = verdict ? verdict : "ok";
        checks++;
        if (!expected || strcmp(expected, got) != 0) {
            failures++;
            printf("FAIL %s: expected %s, got %s\n", name, expected ? expected : "?", got);
        }
    }
    /* The verb table: every documented verb is known, the classic non-verbs are not. */
    const char *scope = NULL;
    bool content = false;
    checks++;
    if (!fos_cloud_contract_verb("get_logs", &scope, &content) || !scope ||
        strcmp(scope, "telemetry:logs") != 0 || content) {
        failures++;
        printf("FAIL get_logs: expected scope telemetry:logs, non-content\n");
    }
    checks++;
    if (!fos_cloud_contract_verb("set_scenes", &scope, &content) || scope || !content) {
        failures++;
        printf("FAIL set_scenes: expected no scope, content verb\n");
    }
    cJSON_ArrayForEach(fixture, cJSON_GetObjectItem(root, "verbs")) {
        const char *type = cJSON_GetStringValue(cJSON_GetObjectItem(fixture, "type"));
        const char *expected = cJSON_GetStringValue(cJSON_GetObjectItem(fixture, "expect"));
        if (expected && strcmp(expected, "unknown_verb") == 0) {
            checks++;
            if (fos_cloud_contract_verb(type, NULL, NULL)) {
                failures++;
                printf("FAIL %s should not be a verb\n", type);
            }
        }
    }
    checks++;
    if (!fos_cloud_contract_setting_restarts("rotate") || fos_cloud_contract_setting_restarts("interval") ||
        fos_cloud_contract_setting_allowed("flip")) {
        failures++;
        printf("FAIL restart/allowed flags\n");
    }
    cJSON_Delete(root);
    printf("%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
