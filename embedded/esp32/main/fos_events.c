#include "fos_events.h"

#include <stdio.h>
#include <string.h>

#include "esp_err.h"
#include "esp_system.h"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "fos_client.h"
#include "fos_http.h"
#include "fos_scenes.h"
#include "frameos_nim.h"

/* Deliberately IDF-light: FreeRTOS for the restart task and esp_restart() are
 * the only platform calls, and the payload is scanned without cJSON, so the
 * routing below is host-tested with a dozen stubs
 * (main/tests/test_fos_events_dispatch.c).
 *
 * Which task runs this: the render task for the schedule and the buttons, the
 * esp_http_server task for /event/<name>, the cloud WebSocket task for the
 * verbs, the console task for `event`. Everything the firmware does itself is
 * a flag, an event-group bit or a flash write — safe from any of them, and
 * none of it takes the Nim runtime lock. Only the hand-off to the scene does.
 */

#define FOS_EVENT_SCENE_ID_LEN 128
/* How long a `setCurrentScene` waits for the runtime to take the `state` that
 * came with it. The switch itself never waits; see set_current_scene(). */
#define FOS_EVENT_STATE_HANDOFF_MS 2000
/* A restart that was asked for over a connection waits this long first, so the
 * HTTP response or the cloud ack gets onto the wire. */
#define FOS_EVENT_RESTART_DELAY_MS 750
/* The render task's own restart (a schedule entry) flushes the log upload and
 * gives it this long to leave — what fos_schedule.c always did. */
#define FOS_EVENT_RESTART_FLUSH_MS 1500

/* ------------------------------------------------------------ JSON, barely
 *
 * Two questions are asked of a payload here — "which scene?" and "is there a
 * state object?" — and both are about TOP-LEVEL members. The strstr() the HTTP
 * route used found `"sceneId"` anywhere, including inside the `state` the
 * scene is being handed. This walks the object's own members, string-aware,
 * and never recurses, so nesting depth costs no stack. */

static const char *skip_ws(const char *p)
{
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    return p;
}

/* `p` at the opening quote; returns just past the closing one, or NULL. */
static const char *skip_string(const char *p)
{
    p++;
    while (*p && *p != '"') {
        if (*p == '\\' && p[1]) p++;
        p++;
    }
    return *p == '"' ? p + 1 : NULL;
}

/* `p` at the first character of a value; returns just past it, or NULL. */
static const char *skip_value(const char *p)
{
    if (*p == '"') return skip_string(p);
    if (*p == '{' || *p == '[') {
        int depth = 0;
        while (*p) {
            if (*p == '"') {
                p = skip_string(p);
                if (p == NULL) return NULL;
                continue;
            }
            if (*p == '{' || *p == '[') depth++;
            if (*p == '}' || *p == ']') {
                depth--;
                if (depth == 0) return p + 1;
            }
            p++;
        }
        return NULL;
    }
    while (*p && *p != ',' && *p != '}' && *p != ']' &&
           *p != ' ' && *p != '\t' && *p != '\r' && *p != '\n') {
        p++;
    }
    return p;
}

/* The value of top-level member `key` of the object in `json`, or NULL. */
static const char *top_level_value(const char *json, const char *key)
{
    if (json == NULL) return NULL;
    size_t key_len = strlen(key);
    const char *p = skip_ws(json);
    if (*p != '{') return NULL;
    p = skip_ws(p + 1);
    while (*p == '"') {
        const char *name = p + 1;
        const char *after_name = skip_string(p);
        if (after_name == NULL) return NULL;
        size_t name_len = (size_t)(after_name - 1 - name);
        p = skip_ws(after_name);
        if (*p != ':') return NULL;
        p = skip_ws(p + 1);
        if (name_len == key_len && memcmp(name, key, key_len) == 0) return p;
        p = skip_value(p);
        if (p == NULL) return NULL;
        p = skip_ws(p);
        if (*p != ',') return NULL;
        p = skip_ws(p + 1);
    }
    return NULL;
}

/* Copies the string at `value` (its opening quote). False for anything that is
 * not a non-empty string that fits; a scene id has no business carrying an
 * escape beyond \" \\ \/, so any other one fails the id instead of guessing. */
static bool copy_string_value(const char *value, char *out, size_t out_len)
{
    if (value == NULL || *value != '"' || out_len == 0) return false;
    size_t used = 0;
    const char *p = value + 1;
    while (*p && *p != '"') {
        if (*p == '\\') {
            p++;
            if (*p != '"' && *p != '\\' && *p != '/') return false;
        }
        if (used + 1 >= out_len) return false;
        out[used++] = *p++;
    }
    out[used] = '\0';
    return *p == '"' && used > 0;
}

static void json_escape_into(char *out, size_t out_len, const char *text)
{
    size_t used = 0;
    for (const unsigned char *p = (const unsigned char *)text; *p && used + 7 < out_len; p++) {
        if (*p == '"' || *p == '\\') {
            out[used++] = '\\';
            out[used++] = (char)*p;
        } else if (*p < 0x20) {
            used += (size_t)snprintf(out + used, out_len - used, "\\u%04x", (unsigned)*p);
        } else {
            out[used++] = (char)*p;
        }
    }
    out[used] = '\0';
}

/* ------------------------------------------------------------------- logs */

static void log_event_line(const char *event, fos_event_origin_t origin, const char *name,
                           const char *reason)
{
    char escaped[2 * FOS_CUSTOM_EVENT_MAX_NAME_LENGTH + 8];
    json_escape_into(escaped, sizeof(escaped), name);
    char line[384];
    int used = snprintf(line, sizeof(line),
                        "{\"event\":\"%s\",\"source\":\"esp32\",\"name\":\"%s\",\"origin\":\"%s\"",
                        event, escaped, fos_event_origin_name(origin));
    if (used < 0 || (size_t)used >= sizeof(line)) return;
    if (reason != NULL) {
        snprintf(line + used, sizeof(line) - (size_t)used, ",\"reason\":\"%s\"}", reason);
    } else {
        snprintf(line + used, sizeof(line) - (size_t)used, "}");
    }
    frameos_nim_log_hook(line);
}

/* --------------------------------------------------------- device commands */

static void restart_task(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(FOS_EVENT_RESTART_DELAY_MS));
    esp_restart();
}

/* One process here, so restarting the runtime and rebooting the board are the
 * same thing: a chip reset.
 *
 * On the render task (a schedule entry — the cloud-safe "automatic reboot") it
 * happens in place: nothing can start a render meanwhile, and that task has the
 * stack for the log upload, so the line that says why goes out first. Anywhere
 * else it is a short-lived task, for two reasons. The caller still has an
 * answer to send — the HTTP 200, the cloud ack — and returning is what lets it
 * out. And the log flush is an HTTP(S) POST that does not fit the 8-10 KB
 * stacks of the httpd, WebSocket and console tasks (nor belongs under the
 * runtime lock, when this runs as the Nim hook); the cloud's log tap has
 * carried the line already. */
static void restart_firmware(bool on_render_task)
{
    if (on_render_task) {
        frameos_nim_flush_logs();
        vTaskDelay(pdMS_TO_TICKS(FOS_EVENT_RESTART_FLUSH_MS));
        esp_restart();
        return;
    }
    if (xTaskCreate(restart_task, "fos_restart", 2048, NULL, 5, NULL) != pdPASS) {
        esp_restart();
    }
}

/* The device commands of the contract, as THIS host carries them out. Nothing
 * here calls into the Nim runtime: it also runs as the runtime's own hook,
 * under its lock (runtime_command below). */
static bool run_runtime_command(fos_event_origin_t origin, const char *command,
                                const char *payload, bool on_render_task)
{
    if (strcmp(command, FOS_EVENT_RELOAD) == 0) {
        log_event_line("event:reload", origin, command, NULL);
        fos_scenes_request_sync();
        fos_client_render_now();
        return true;
    }
    if (strcmp(command, FOS_EVENT_RESTART) == 0 || strcmp(command, FOS_EVENT_REBOOT) == 0) {
        log_event_line(strcmp(command, FOS_EVENT_REBOOT) == 0 ? "event:reboot" : "event:restart",
                       origin, command, NULL);
        restart_firmware(on_render_task);
        return true;
    }
    if (strcmp(command, FOS_EVENT_UPLOAD_SCENES) == 0) {
        /* Stored and marked pending; the render task hot-loads it. The store
         * writes its own event:uploadScenes line, with the outcome. */
        if (fos_http_store_uploaded_scenes_payload(payload, strlen(payload)) != ESP_OK) {
            return false;
        }
        fos_client_render_now();
        return true;
    }
    /* `metrics` (hosts.esp32: false): this firmware samples on its own clock
     * and ships the result with the logs; there is nothing to trigger. Also
     * where a device command a newer contract adds lands until it is written. */
    log_event_line("event:unsupported", origin, command, "not on this host");
    return false;
}

/* The Nim runtime's device-command hook (frameos_nim_set_runtime_command_hook):
 * a command a scene reached the dispatcher with — `metrics` is the only one a
 * scene may say, everything else was refused there by its origin. Runs on
 * whatever task called into Nim, UNDER the runtime lock. */
static bool runtime_command(const char *command, const char *payload)
{
    return run_runtime_command(FOS_ORIGIN_SCENE, command,
                               payload && payload[0] ? payload : "{}", false);
}

void fos_events_init(void)
{
    frameos_nim_set_runtime_command_hook(runtime_command);
}

/* ---------------------------------------------------------- scene switches */

/* Switching is the firmware's: the scene may have to come off flash, and the
 * choice is persisted. fos_scenes_select() only queues (the render task does
 * the work on its next pass), so this answers at once from any task.
 *
 * `state` that rides along is the runtime's: it has to reach the scene once it
 * IS the current one. The Nim dispatcher does exactly that for a
 * `setCurrentScene` it is handed — it asks for the same switch through the
 * scene-select hook (the same id queued twice is one switch) and keeps the
 * state pending, or applies it right away when that scene is already showing.
 * Handed over BEFORE the render is requested, so the pending state is in place
 * when the render task wakes; bounded, because a caller here may be the
 * WebSocket or the HTTP task and the switch itself must not wait for a render
 * to finish. If the runtime stays busy the scene still switches, with its
 * default state, and the log says what was lost. */
static fos_event_result_t set_current_scene(fos_event_origin_t origin, const char *payload)
{
    char scene_id[FOS_EVENT_SCENE_ID_LEN];
    if (!copy_string_value(top_level_value(payload, "sceneId"), scene_id, sizeof(scene_id)) &&
        !copy_string_value(top_level_value(payload, "scene_id"), scene_id, sizeof(scene_id))) {
        return FOS_EVENT_FAILED;
    }
    if (fos_scenes_select(scene_id) != ESP_OK) return FOS_EVENT_FAILED;

    const char *state = top_level_value(payload, "state");
    if (state != NULL && *state == '{' && frameos_nim_available()) {
        bool busy = false;
        frameos_nim_send_event_wait(origin, FOS_EVENT_SET_CURRENT_SCENE, payload,
                                    FOS_EVENT_STATE_HANDOFF_MS, &busy);
        if (busy) {
            frameos_nim_log_hook("{\"event\":\"event:setCurrentScene:stateDropped\","
                                 "\"source\":\"esp32\",\"reason\":\"runtime busy\"}");
        }
    }
    fos_client_render_now();
    return FOS_EVENT_DONE;
}

/* ---------------------------------------------------------------- dispatch */

fos_event_result_t fos_events_dispatch_wait(fos_event_origin_t origin, const char *name,
                                            const char *payload_json, int timeout_ms)
{
    if (name == NULL || name[0] == '\0') return FOS_EVENT_FAILED;
    const char *payload = payload_json && payload_json[0] ? payload_json : "{}";

    /* Who may say what is the contract's (docs/events-contract.json), asked
     * here of every origin, once. A custom event from an origin a scene opts
     * into (a schedule, the cloud) passes: whether the scene showing declared
     * it is the Nim dispatcher's to say, and it logs its own refusal. */
    if (!fos_event_origin_may_emit(origin, name)) {
        log_event_line("event:refused", origin, name, "origin");
        return FOS_EVENT_REFUSED;
    }

    /* The firmware's own: no runtime lock, done when this returns. `render`
     * is a request — the scene hears "render" from the render pass. */
    if (strcmp(name, FOS_EVENT_RENDER) == 0) {
        fos_client_render_now();
        return FOS_EVENT_DONE;
    }
    if (strcmp(name, FOS_EVENT_SET_CURRENT_SCENE) == 0) {
        return set_current_scene(origin, payload);
    }
    if (fos_event_is_device_command(name)) {
        /* Of the producers only the schedule runs on the render task AND may
         * say a command (a button press may not). */
        return run_runtime_command(origin, name, payload, origin == FOS_ORIGIN_SCHEDULE)
                   ? FOS_EVENT_DONE : FOS_EVENT_FAILED;
    }

    /* Everything a scene hears: input, custom events, setSceneState, turnOn /
     * turnOff. The Nim dispatcher queues it, drains the queue and applies the
     * contract's render rule; all that is left to do here is pass the render
     * request on. */
    if (!frameos_nim_available()) return FOS_EVENT_FAILED;
    bool delivered;
    if (timeout_ms < 0) {
        delivered = frameos_nim_send_event(origin, name, payload);
        if (frameos_nim_render_requested()) fos_client_render_now();
    } else {
        bool busy = false;
        delivered = frameos_nim_send_event_wait(origin, name, payload, timeout_ms, &busy);
        if (busy) return FOS_EVENT_BUSY;
        /* frameos_nim_render_requested() waits for the same lock, and a render
         * may have started since: end the render task's wait instead — its
         * loop reads the flag on its own task. */
        fos_client_wake_for_events();
    }
    return delivered ? FOS_EVENT_DONE : FOS_EVENT_FAILED;
}

fos_event_result_t fos_events_dispatch(fos_event_origin_t origin, const char *name,
                                       const char *payload_json)
{
    return fos_events_dispatch_wait(origin, name, payload_json, -1);
}
