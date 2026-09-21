/* Host test of fos_events.c, the firmware's one routing function for scene
 * events: who may say what (the contract's allow-list), what the firmware does
 * itself without the Nim runtime (render, scene switches, device commands),
 * what is handed to the scene and with which lock discipline. The firmware
 * functions it calls are the stubs below, which only take notes; FreeRTOS and
 * esp_restart() come from main/tests/host_shim.
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain -Imain/tests/host_shim \
 *      -Icomponents/frameos_nim/include -Icomponents/frameos_display/include \
 *      main/fos_events.c main/tests/test_fos_events_dispatch.c -o t && ./t
 *
 * Run by backend/app/tasks/tests/test_esp32_events_contract.py.
 */
#include <stdio.h>
#include <string.h>

#include "fos_events.h"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "fos_client.h"
#include "fos_http.h"
#include "fos_scenes.h"
#include "frameos_nim.h"

/* ------------------------------------------------------------------ notes */

static struct {
    int renders;
    int wakes;
    int syncs;
    int selects;
    char selected[128];
    int stores;
    char stored[256];
    esp_err_t store_result;
    bool nim_available;
    bool nim_result;
    bool nim_busy;
    bool nim_render_requested;
    int nim_sends;
    int nim_render_polls;
    uint32_t nim_origin;
    char nim_event[96];
    char nim_payload[256];
    int nim_timeout;
    int flushes;
    int restarts;
    int delays;
    uint32_t last_delay;
    int tasks;
    BaseType_t task_result;
    TaskFunction_t task;
    int logs;
    char log[512];
    char all_logs[2048];
    bool (*hook)(const char *command, const char *payload_json);
} n;

static void reset(void)
{
    bool (*hook)(const char *, const char *) = n.hook;
    memset(&n, 0, sizeof(n));
    n.hook = hook;
    n.nim_available = true;
    n.nim_result = true;
    n.task_result = pdPASS;
    n.store_result = ESP_OK;
}

void fos_client_render_now(void) { n.renders++; }
void fos_client_wake_for_events(void) { n.wakes++; }
void fos_scenes_request_sync(void) { n.syncs++; }

esp_err_t fos_scenes_select(const char *scene_id)
{
    n.selects++;
    snprintf(n.selected, sizeof(n.selected), "%s", scene_id ? scene_id : "");
    return scene_id && scene_id[0] ? ESP_OK : ESP_ERR_INVALID_ARG;
}

esp_err_t fos_http_store_uploaded_scenes_payload(const char *body, size_t len)
{
    n.stores++;
    snprintf(n.stored, sizeof(n.stored), "%.*s", (int)len, body);
    return n.store_result;
}

bool frameos_nim_available(void) { return n.nim_available; }

bool frameos_nim_send_event_wait(uint32_t origin, const char *event, const char *payload_json,
                                 int timeout_ms, bool *busy)
{
    n.nim_timeout = timeout_ms;
    if (busy) *busy = n.nim_busy;
    if (n.nim_busy) return false;
    n.nim_sends++;
    n.nim_origin = origin;
    snprintf(n.nim_event, sizeof(n.nim_event), "%s", event);
    snprintf(n.nim_payload, sizeof(n.nim_payload), "%s", payload_json ? payload_json : "(null)");
    return n.nim_result;
}

bool frameos_nim_send_event(uint32_t origin, const char *event, const char *payload_json)
{
    return frameos_nim_send_event_wait(origin, event, payload_json, -1, NULL);
}

bool frameos_nim_render_requested(void)
{
    n.nim_render_polls++;
    return n.nim_render_requested;
}

void frameos_nim_log_hook(const char *msg)
{
    n.logs++;
    snprintf(n.log, sizeof(n.log), "%s", msg);
    size_t used = strlen(n.all_logs);
    snprintf(n.all_logs + used, sizeof(n.all_logs) - used, "%s\n", msg);
}

void frameos_nim_flush_logs(void) { n.flushes++; }

void frameos_nim_set_runtime_command_hook(bool (*hook)(const char *command, const char *payload_json))
{
    n.hook = hook;
}

BaseType_t xTaskCreate(TaskFunction_t task, const char *name, uint32_t stack_depth, void *arg,
                       UBaseType_t priority, TaskHandle_t *handle)
{
    (void)name; (void)stack_depth; (void)arg; (void)priority; (void)handle;
    n.tasks++;
    n.task = task;
    return n.task_result;
}

void vTaskDelay(TickType_t ticks)
{
    n.delays++;
    n.last_delay = ticks;
}

void esp_restart(void) { n.restarts++; }

/* ------------------------------------------------------------------ checks */

static int failures = 0;
static int checks = 0;

#define CHECK(cond) do { \
        checks++; \
        if (!(cond)) { \
            printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            failures++; \
        } \
    } while (0)

static void test_allow_list(void)
{
    /* A button press may not reboot the frame. */
    reset();
    CHECK(fos_events_dispatch(FOS_ORIGIN_DRIVER, "reboot", "{}") == FOS_EVENT_REFUSED);
    CHECK(n.restarts == 0 && n.tasks == 0 && n.nim_sends == 0);
    CHECK(n.logs == 1);
    CHECK(strcmp(n.log, "{\"event\":\"event:refused\",\"source\":\"esp32\",\"name\":\"reboot\","
                        "\"origin\":\"driver\",\"reason\":\"origin\"}") == 0);

    /* The frame access key may not reload; the admin may. */
    reset();
    CHECK(fos_events_dispatch(FOS_ORIGIN_HTTP_WRITE, "reload", NULL) == FOS_EVENT_REFUSED);
    CHECK(n.syncs == 0 && n.renders == 0);
    reset();
    CHECK(fos_events_dispatch(FOS_ORIGIN_HTTP_ADMIN, "reload", NULL) == FOS_EVENT_DONE);
    CHECK(n.syncs == 1 && n.renders == 1 && n.nim_sends == 0);

    /* A schedule may not replace the installed scenes; nobody but the device
     * itself and an admin says `open`. */
    reset();
    CHECK(fos_events_dispatch(FOS_ORIGIN_SCHEDULE, "uploadScenes", "[]") == FOS_EVENT_REFUSED);
    CHECK(n.stores == 0);
    CHECK(fos_events_dispatch(FOS_ORIGIN_CLOUD, "open", "{}") == FOS_EVENT_REFUSED);
    CHECK(n.nim_sends == 0);

    /* The refused name goes into a JSON log line: escaped, and bounded. */
    reset();
    CHECK(fos_events_dispatch(FOS_ORIGIN_HTTP_ADMIN, NULL, "{}") == FOS_EVENT_FAILED);
    CHECK(fos_events_dispatch(FOS_ORIGIN_HTTP_ADMIN, "", "{}") == FOS_EVENT_FAILED);
    CHECK(n.logs == 0);
}

static void test_refused_name_is_escaped(void)
{
    /* No origin is refused a custom name outright except by being unknown to
     * the table, so go through an origin that has no bit in any row. */
    reset();
    CHECK(fos_events_dispatch((fos_event_origin_t)0, "say\"hi\"\\\n", "{}") == FOS_EVENT_REFUSED);
    CHECK(strstr(n.log, "\"name\":\"say\\\"hi\\\"\\\\\\u000a\"") != NULL);
    CHECK(strstr(n.log, "\"origin\":\"unknown\"") != NULL);

    char long_name[400];
    memset(long_name, '"', sizeof(long_name) - 1);
    long_name[sizeof(long_name) - 1] = '\0';
    reset();
    CHECK(fos_events_dispatch((fos_event_origin_t)0, long_name, "{}") == FOS_EVENT_REFUSED);
    CHECK(n.logs == 1 && strlen(n.log) < 384);
    CHECK(n.log[strlen(n.log) - 1] == '}');
}

static void test_render(void)
{
    reset();
    CHECK(fos_events_dispatch(FOS_ORIGIN_CLOUD, "render", NULL) == FOS_EVENT_DONE);
    CHECK(n.renders == 1 && n.nim_sends == 0 && n.nim_render_polls == 0);
    /* Also on a thin-client build: a render is the firmware's. */
    reset();
    n.nim_available = false;
    CHECK(fos_events_dispatch(FOS_ORIGIN_SCHEDULE, "render", "{}") == FOS_EVENT_DONE);
    CHECK(n.renders == 1);
}

static void test_set_current_scene(void)
{
    reset();
    CHECK(fos_events_dispatch(FOS_ORIGIN_HTTP_ADMIN, "setCurrentScene", "{\"sceneId\":\"abc\"}") == FOS_EVENT_DONE);
    CHECK(n.selects == 1 && strcmp(n.selected, "abc") == 0 && n.renders == 1);
    CHECK(n.nim_sends == 0); /* no state: the runtime is not involved */

    reset();
    CHECK(fos_events_dispatch(FOS_ORIGIN_SCHEDULE, "setCurrentScene", " { \"scene_id\" : \"snake\" } ") == FOS_EVENT_DONE);
    CHECK(strcmp(n.selected, "snake") == 0);

    /* No id, an empty one, not a string, not an object: nothing switches. */
    const char *bad[] = {"{}", "{\"sceneId\":\"\"}", "{\"sceneId\":7}", "[\"sceneId\",\"x\"]",
                         "{\"sceneId\":\"a\\u0041\"}", "{\"sceneId\":\"unterminated", "nonsense"};
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
        reset();
        CHECK(fos_events_dispatch(FOS_ORIGIN_HTTP_ADMIN, "setCurrentScene", bad[i]) == FOS_EVENT_FAILED);
        CHECK(n.selects == 0 && n.renders == 0 && n.nim_sends == 0);
    }

    /* The id is the payload's OWN member — not one inside the state it hands
     * over, in a string, or under another key. */
    reset();
    const char *nested = "{\"state\":{\"sceneId\":\"inner\",\"list\":[\"}\",{\"sceneId\":\"deeper\"}]},"
                         "\"note\":\"\\\"sceneId\\\":\\\"quoted\\\"\",\"sceneId\":\"outer\"}";
    CHECK(fos_events_dispatch(FOS_ORIGIN_CLOUD, "setCurrentScene", nested) == FOS_EVENT_DONE);
    CHECK(strcmp(n.selected, "outer") == 0);
    /* …and the state rides to the runtime: whole event, the caller's origin,
     * a bounded wait, before the render is asked for. */
    CHECK(n.nim_sends == 1 && n.nim_origin == FOS_ORIGIN_CLOUD);
    CHECK(strcmp(n.nim_event, "setCurrentScene") == 0 && strcmp(n.nim_payload, nested) == 0);
    CHECK(n.nim_timeout == 2000);
    CHECK(n.renders == 1 && n.nim_render_polls == 0);

    /* A runtime busy rendering: the scene still switches, the log says what
     * was lost. */
    reset();
    n.nim_busy = true;
    CHECK(fos_events_dispatch(FOS_ORIGIN_CLOUD, "setCurrentScene", "{\"sceneId\":\"a\",\"state\":{\"n\":1}}") == FOS_EVENT_DONE);
    CHECK(n.selects == 1 && n.renders == 1 && n.nim_sends == 0);
    CHECK(strstr(n.log, "event:setCurrentScene:stateDropped") != NULL);

    /* `state` that is not an object is not state; a thin client has nobody to
     * hand it to. */
    reset();
    CHECK(fos_events_dispatch(FOS_ORIGIN_CLOUD, "setCurrentScene", "{\"sceneId\":\"a\",\"state\":null}") == FOS_EVENT_DONE);
    CHECK(n.nim_sends == 0);
    reset();
    n.nim_available = false;
    CHECK(fos_events_dispatch(FOS_ORIGIN_CLOUD, "setCurrentScene", "{\"sceneId\":\"a\",\"state\":{}}") == FOS_EVENT_DONE);
    CHECK(n.nim_sends == 0 && n.selects == 1);

    /* An id that does not fit is refused, not truncated into another scene's. */
    char big[300];
    memset(big, 'x', sizeof(big));
    memcpy(big, "{\"sceneId\":\"", 12);
    memcpy(big + sizeof(big) - 3, "\"}", 3);
    reset();
    CHECK(fos_events_dispatch(FOS_ORIGIN_CLOUD, "setCurrentScene", big) == FOS_EVENT_FAILED);
    CHECK(n.selects == 0);
}

static void test_restart(void)
{
    /* The schedule runs on the render task: in place, log upload first. */
    reset();
    CHECK(fos_events_dispatch(FOS_ORIGIN_SCHEDULE, "reboot", "{}") == FOS_EVENT_DONE);
    CHECK(n.flushes == 1 && n.delays == 1 && n.last_delay == 1500 && n.restarts == 1 && n.tasks == 0);
    CHECK(strstr(n.all_logs, "\"event\":\"event:reboot\"") != NULL);
    CHECK(strstr(n.all_logs, "\"origin\":\"schedule\"") != NULL);

    /* Anyone with an answer still to send: a task, after a moment, and no
     * HTTP log upload on a small stack. */
    reset();
    CHECK(fos_events_dispatch(FOS_ORIGIN_CLOUD, "restart", NULL) == FOS_EVENT_DONE);
    CHECK(n.tasks == 1 && n.restarts == 0 && n.flushes == 0 && n.delays == 0);
    CHECK(n.task != NULL);
    if (n.task != NULL) n.task(NULL);
    CHECK(n.delays == 1 && n.last_delay == 750 && n.restarts == 1);

    /* No task to be had: restart anyway. */
    reset();
    n.task_result = pdFAIL;
    CHECK(fos_events_dispatch(FOS_ORIGIN_HTTP_ADMIN, "reboot", NULL) == FOS_EVENT_DONE);
    CHECK(n.restarts == 1);
}

static void test_other_commands(void)
{
    reset();
    CHECK(fos_events_dispatch(FOS_ORIGIN_HTTP_ADMIN, "uploadScenes", "{\"scenes\":[]}") == FOS_EVENT_DONE);
    CHECK(n.stores == 1 && strcmp(n.stored, "{\"scenes\":[]}") == 0 && n.renders == 1);

    reset();
    n.store_result = ESP_FAIL;
    CHECK(fos_events_dispatch(FOS_ORIGIN_HTTP_ADMIN, "uploadScenes", "[]") == FOS_EVENT_FAILED);
    CHECK(n.stores == 1 && n.renders == 0);

    /* `metrics` is not on this host: said so, and never sent to a scene. */
    reset();
    CHECK(fos_events_dispatch(FOS_ORIGIN_HTTP_ADMIN, "metrics", NULL) == FOS_EVENT_FAILED);
    CHECK(n.nim_sends == 0 && strstr(n.log, "event:unsupported") != NULL);
}

static void test_scene_events(void)
{
    /* Unbounded: delivered, then the scene's render request is passed on. */
    reset();
    n.nim_render_requested = true;
    CHECK(fos_events_dispatch(FOS_ORIGIN_DRIVER, "button", "{\"label\":\"A\"}") == FOS_EVENT_DONE);
    CHECK(n.nim_sends == 1 && n.nim_origin == FOS_ORIGIN_DRIVER && n.nim_timeout == -1);
    CHECK(strcmp(n.nim_event, "button") == 0 && strcmp(n.nim_payload, "{\"label\":\"A\"}") == 0);
    CHECK(n.nim_render_polls == 1 && n.renders == 1 && n.wakes == 0);

    reset();
    CHECK(fos_events_dispatch(FOS_ORIGIN_HTTP_ADMIN, "setSceneState", NULL) == FOS_EVENT_DONE);
    CHECK(strcmp(n.nim_payload, "{}") == 0 && n.renders == 0);

    /* The dispatcher's "came to nothing" is the caller's FAILED. */
    reset();
    n.nim_result = false;
    CHECK(fos_events_dispatch(FOS_ORIGIN_HTTP_ADMIN, "turnOn", "{}") == FOS_EVENT_FAILED);

    /* A custom event from a schedule or the cloud is the scene's to allow: it
     * reaches the Nim dispatcher, stamped, and is not refused here. */
    reset();
    CHECK(fos_events_dispatch(FOS_ORIGIN_SCHEDULE, "morningBriefing", "{}") == FOS_EVENT_DONE);
    CHECK(n.nim_sends == 1 && n.nim_origin == FOS_ORIGIN_SCHEDULE && n.logs == 0);

    /* Bounded: never the lock-taking render poll — the render task is woken
     * and reads the flag itself. */
    reset();
    n.nim_render_requested = true;
    CHECK(fos_events_dispatch_wait(FOS_ORIGIN_CLOUD, "button", "{}", 3000) == FOS_EVENT_DONE);
    CHECK(n.nim_timeout == 3000 && n.nim_render_polls == 0 && n.wakes == 1 && n.renders == 0);

    reset();
    n.nim_busy = true;
    CHECK(fos_events_dispatch_wait(FOS_ORIGIN_CLOUD, "button", "{}", 3000) == FOS_EVENT_BUSY);
    CHECK(n.nim_sends == 0 && n.wakes == 0 && n.renders == 0);

    /* No runtime in this build. */
    reset();
    n.nim_available = false;
    CHECK(fos_events_dispatch(FOS_ORIGIN_HTTP_ADMIN, "button", "{}") == FOS_EVENT_FAILED);
    CHECK(n.nim_sends == 0);
}

static void test_runtime_hook(void)
{
    /* What the Nim dispatcher hands back lands in the same code — and that
     * code never calls into the runtime, whose lock the caller holds. */
    n.hook = NULL;
    fos_events_init();
    CHECK(n.hook != NULL);
    if (n.hook == NULL) return;

    reset();
    CHECK(!n.hook("metrics", "{}"));
    CHECK(strstr(n.log, "event:unsupported") != NULL && strstr(n.log, "\"origin\":\"scene\"") != NULL);
    CHECK(n.nim_sends == 0 && n.nim_render_polls == 0);

    reset();
    CHECK(n.hook("reload", NULL));
    CHECK(n.syncs == 1 && n.renders == 1 && n.nim_sends == 0 && n.nim_render_polls == 0);

    /* Under the runtime lock a restart is always the deferred one: no log
     * upload while the lock is held. */
    reset();
    CHECK(n.hook("reboot", "{}"));
    CHECK(n.tasks == 1 && n.flushes == 0 && n.restarts == 0);
}

int main(void)
{
    test_allow_list();
    test_refused_name_is_escaped();
    test_render();
    test_set_current_scene();
    test_restart();
    test_other_commands();
    test_scene_events();
    test_runtime_hook();
    printf("%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
