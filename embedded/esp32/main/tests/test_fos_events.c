/* Host test of fos_events_gen.h, the firmware's tables of the scene event
 * contract (docs/events-contract.json). The cases are the `origins` section
 * of docs/event-fixtures.json — the corpus the Nim runtime, the backend and
 * the cloud run too — fed on stdin by
 * backend/app/tasks/tests/test_esp32_events_contract.py as lines of
 * "<origin> <event> <0|1>", so this needs no JSON parser and no IDF.
 *
 *   cc -std=c11 -Wall -Wextra -Werror -I main main/tests/test_fos_events.c -o t && ./t < cases
 */
#include <stdio.h>
#include <string.h>

#include "fos_events_gen.h"

static int origin_of(const char *name, fos_event_origin_t *out)
{
    static const struct { const char *name; fos_event_origin_t origin; } origins[] = {
        {"driver", FOS_ORIGIN_DRIVER},       {"preview", FOS_ORIGIN_PREVIEW},
        {"scene", FOS_ORIGIN_SCENE},         {"schedule", FOS_ORIGIN_SCHEDULE},
        {"http:write", FOS_ORIGIN_HTTP_WRITE}, {"http:admin", FOS_ORIGIN_HTTP_ADMIN},
        {"cloud", FOS_ORIGIN_CLOUD},         {"system", FOS_ORIGIN_SYSTEM},
    };
    for (size_t i = 0; i < sizeof(origins) / sizeof(origins[0]); i++) {
        if (strcmp(origins[i].name, name) == 0) {
            *out = origins[i].origin;
            return 1;
        }
    }
    return 0;
}

int main(void)
{
    int failures = 0;
    int cases = 0;
    char origin_name[32];
    char event[FOS_CUSTOM_EVENT_MAX_NAME_LENGTH + 1];
    int allowed = 0;

    while (scanf("%31s %63s %d", origin_name, event, &allowed) == 3) {
        fos_event_origin_t origin;
        cases++;
        if (!origin_of(origin_name, &origin)) {
            printf("FAIL unknown origin %s\n", origin_name);
            failures++;
            continue;
        }
        if (fos_event_origin_may_emit(origin, event) != (allowed != 0)) {
            printf("FAIL %s / %s: expected allowed=%d\n", origin_name, event, allowed);
            failures++;
        }
    }

    /* The table itself: every row findable by its own name, the custom row for the rest. */
    for (size_t i = 0; i < FOS_EVENT_SPEC_COUNT; i++) {
        if (fos_event_spec(FOS_EVENT_SPECS[i].name) != &FOS_EVENT_SPECS[i]) {
            printf("FAIL lookup of %s\n", FOS_EVENT_SPECS[i].name);
            failures++;
        }
    }
    if (fos_event_spec("somethingOfTheScenes")->event_class != FOS_EVENT_CLASS_CUSTOM || fos_event_spec(NULL) == NULL) {
        printf("FAIL custom event row\n");
        failures++;
    }
    if (!fos_event_spec(FOS_EVENT_REBOOT)->ends_runtime || !fos_event_spec(FOS_EVENT_RESTART)->ends_runtime ||
        fos_event_spec(FOS_EVENT_RENDER)->ends_runtime) {
        printf("FAIL ends_runtime\n");
        failures++;
    }
    if (!fos_event_is_device_command(FOS_EVENT_UPLOAD_SCENES) || fos_event_is_device_command(FOS_EVENT_BUTTON)) {
        printf("FAIL device command class\n");
        failures++;
    }

    printf("%d cases, %d failures\n", cases, failures);
    return failures == 0 && cases > 0 ? 0 : 1;
}
