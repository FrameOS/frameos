/* Stand-in for src/lib/lgpio.h in test_busy_budget.nim: ePaper/DEV_Config.h
 * includes lgpio.h but declares nothing in terms of it, and the real header
 * needs <linux/gpio.h>, which a macOS host does not have. */
