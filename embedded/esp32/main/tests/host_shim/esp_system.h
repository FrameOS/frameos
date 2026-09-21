/* Host stand-in for esp_system.h: the one call fos_events.c makes. On the
 * chip it does not return; the test's version records that it was asked. */
#pragma once

void esp_restart(void);
