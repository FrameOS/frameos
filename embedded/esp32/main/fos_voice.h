/*
 * Voice chat sessions (docs/voice-chat.md): the frame listens while the LEFT
 * and RIGHT buttons are held, streams what it hears to its control plane as
 * it is said, and sounds the answer.
 *
 * The button task starts and ends a session (fos_voice_begin / fos_voice_end,
 * on the chord in fos_voice_chord.c); everything else happens on two tasks
 * that exist only while a session runs: a capture task that drains the I2S
 * DMA into a PSRAM buffer (fos_mic.c) and a relay task that uploads the
 * buffer a chunk at a time to
 *
 *   POST {base}/voice/{session}?seq={n}&done={0|1}
 *
 * with the frame's own bearer — the self-hosted backend's
 * /api/frames/{id}/embedded/voice when a backend is configured, else the
 * cloud's /api/frames/{id}/voice — and waits for the answer on the last
 * chunk: the transcript, the reply and the tools the chat ran. The reply is
 * logged (both planes' frame logs show it) and sounded; a scene switch the
 * chat queued is applied by asking for a commands sync.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

/* The most audio one session carries, and the PSRAM it costs (960 KB). */
#define FOS_VOICE_MAX_SECONDS 30

/* Once at boot, after the config and the buzzer: nothing runs until a chord. */
void fos_voice_init(void);
/* This frame can take a session: voice chat on, microphone pins set, a
 * control plane to send to, and no session running. */
bool fos_voice_available(void);
/* The chord held: start listening. False when fos_voice_available() is
 * false (the caller sounds the refusal). Returns at once. */
bool fos_voice_begin(void);
/* A key let go: stop listening, send what is left, wait for the answer.
 * Returns at once; no-op without a session. */
void fos_voice_end(void);
/* A session is listening or waiting for its answer. */
bool fos_voice_busy(void);
