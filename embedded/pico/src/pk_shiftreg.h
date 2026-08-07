// The Inky Frame routes the panel BUSY line and the front buttons through a
// 74HC165-style parallel-in shift register instead of spending GPIOs.
#ifndef PK_SHIFTREG_H
#define PK_SHIFTREG_H

#include <stdbool.h>
#include <stdint.h>

#include "pk_config.h"

// Read all 8 bits (bit 7 first out). Returns 0xFF when unconfigured.
uint8_t pk_shiftreg_read(const pk_pins_t *pins);

// The display busy state, from either the plain BUSY GPIO or the shift
// register bit, per config. Returns false (idle) when nothing is wired.
bool pk_display_busy(const pk_pins_t *pins);

#endif // PK_SHIFTREG_H
