/*
 * Which keys are voice keys (docs/voice-chat.md): the frame's event map
 * (docs/events.md "Event map", fos_config_t.event_map) names them. A rule
 *
 *   {"event":"button","match":{"label":"REFRESH","action":"longPress"},"emit":"voiceChat"}
 *
 * binds a key's long press to `voiceChat` — the one emit the firmware acts
 * on while the key is still held: the dispatcher makes a `longPress` only at
 * the release, and a voice session has to be listening long before that. So
 * the button task reads the bindings here, starts the session at the hold
 * (fos_voice_hold.c) and claims the press; the rule itself never fires on
 * the device. Within a map the first rule matching a label's long press
 * wins, as the dispatcher's own walk has it (event_map.nim), so a rule that
 * sends REFRESH held somewhere else first keeps it from being a voice key.
 *
 * Pure cJSON, no IDF: main/tests/test_fos_voice_binding.c builds it on a
 * laptop with ESP-IDF's cJSON.
 */
#pragma once

#include <stddef.h>

/* The reTerminal's labels are a word; the config's own slot is 32. */
#define FOS_VOICE_BINDING_LABEL_LEN 32

/* The labels (upper-cased, as the config keeps them) whose long press the
 * map binds to `voiceChat`, in map order, at most `max`. 0 for no map, an
 * unparsable one, or one without such a rule. */
size_t fos_voice_binding_labels(const char *event_map_json, char labels[][FOS_VOICE_BINDING_LABEL_LEN],
                                size_t max);
