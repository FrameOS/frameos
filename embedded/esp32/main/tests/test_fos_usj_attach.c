/* Host test for fos_usj_attach.c: cc -I.. test_fos_usj_attach.c ../fos_usj_attach.c */
#include <stdio.h>
#include <string.h>

#include "fos_usj_attach.h"

static int failures = 0;
#define CHECK(cond, msg) do { if (!(cond)) { printf("FAIL: %s\n", msg); failures++; } } while (0)

int main(void)
{
    fos_usj_attach_t s;

    /* No host: never installed, however long it polls. */
    memset(&s, 0, sizeof(s));
    for (int i = 0; i < 100; i++) CHECK(!fos_usj_attach_poll(&s, false, false), "no host, no driver");
    CHECK(!s.installed, "no host: not installed");

    /* A host: installed on the second poll in a row, exactly once. */
    memset(&s, 0, sizeof(s));
    CHECK(!fos_usj_attach_poll(&s, false, true), "first sighting waits");
    CHECK(fos_usj_attach_poll(&s, false, true), "second sighting installs");
    CHECK(s.installed, "installed is remembered");
    CHECK(!fos_usj_attach_poll(&s, false, true), "never twice");
    CHECK(!fos_usj_attach_poll(&s, false, false), "a host that leaves keeps the driver");

    /* One stray sighting between gaps never installs. */
    memset(&s, 0, sizeof(s));
    for (int i = 0; i < 20; i++) {
        CHECK(!fos_usj_attach_poll(&s, false, i % 2 == 0), "alternating sightings never install");
    }
    CHECK(!s.installed, "alternating: not installed");

    /* Claimed pads: never, even with a host (the driver would take the pads
     * back from the I2C bus, touch controller or microphone on them). */
    memset(&s, 0, sizeof(s));
    for (int i = 0; i < 10; i++) CHECK(!fos_usj_attach_poll(&s, true, true), "claimed pads, no driver");
    CHECK(!s.installed, "claimed: not installed");

    /* A host plugged in late (after many empty polls) still gets it. */
    memset(&s, 0, sizeof(s));
    for (int i = 0; i < 50; i++) fos_usj_attach_poll(&s, false, false);
    CHECK(!fos_usj_attach_poll(&s, false, true), "late host: first sighting waits");
    CHECK(fos_usj_attach_poll(&s, false, true), "late host: installed");

    if (failures) {
        printf("%d failure(s)\n", failures);
        return 1;
    }
    printf("test_fos_usj_attach: all passed\n");
    return 0;
}
