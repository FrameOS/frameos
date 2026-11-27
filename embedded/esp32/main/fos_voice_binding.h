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

/* The labels a rule naming `triplePress` matches (whatever it does with
 * it): the keys whose pair the dispatcher holds back for a third press, so
 * the button task can sound the third down as one (fos_button_timing.h
 * `triple`). A rule with no `action` does not count, as in event_loop.nim.
 * A rule of the showing scene's map is not here: such a third press sounds
 * as a first. */
size_t fos_voice_binding_triple_labels(const char *event_map_json, char labels[][FOS_VOICE_BINDING_LABEL_LEN],
                                       size_t max);
/* The labels a rule naming `doublePress` matches: the keys whose press the
 * dispatcher holds for a second (every other key's press is a press at its
 * `up`, docs/buttons.md), so the button task sounds a second down as a
 * double press only on them (fos_button_timing.h `pair`). */
size_t fos_voice_binding_double_labels(const char *event_map_json, char labels[][FOS_VOICE_BINDING_LABEL_LEN],
                                       size_t max);

/* How a person at the frame opens its own page (docs/scene-settings.md "The
 * frame page") by hand, for the voice key's words when there is no Wi-Fi to
 * talk over (fos_voice.c): the first rule that emits `sceneSettings` (the
 * panel, whose gear opens the page; straight onto it with
 * `as: {"page": "frame"}`), else the first that emits `sceneSwitcher` (the
 * list, whose header gear opens it), in a few words: "swipe down from the
 * top", "press the Action key thrice". The gear wants a finger, so a key's
 * rule counts only on a map with a rule that is not a key's (a touch board:
 * the switcher's takesNoTaps). The Sticky's AI key is the Action key in
 * every word a person reads. FOS_VOICE_PAGE_NONE and "" when there is no way. */
typedef enum {
    FOS_VOICE_PAGE_NONE = 0,
    FOS_VOICE_PAGE_GEAR, /* the words, then the gear */
    FOS_VOICE_PAGE_OPEN, /* the words open the page itself */
} fos_voice_page_way_t;

fos_voice_page_way_t fos_voice_binding_page_way(const char *event_map_json, char *out, size_t out_len);
