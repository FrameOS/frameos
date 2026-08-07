#ifndef PK_CONSOLE_H
#define PK_CONSOLE_H

#include <stdbool.h>

// Poll the USB CDC console for one pending command; call from the main loop.
// Returns true when a command requested an immediate render.
bool pk_console_poll(void);

#endif // PK_CONSOLE_H
