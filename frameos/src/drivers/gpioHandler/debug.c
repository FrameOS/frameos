#include <stdio.h>
#include <unistd.h> // For sleep()
#include "gpioHandler.h"
#include <lgpio.h>

// User-defined callback function for button press
void event_callback(int gpio, int level) {
    printf("Button on GPIO %d changed to level %d\n", gpio, level);
}

// User-defined callback function for button press
void log_callback(char *message) {
    printf(message);
}

int main() {
    // Initialize GPIO system
    if (gpioHandler_init(event_callback, log_callback) < 0) {
        fprintf(stderr, "Failed to initialize GPIO\n");
        return 1;
    }

    if (gpioHandler_registerButton(16) < 0) {
        fprintf(stderr, "Failed to register button\n");
        gpioHandler_cleanup();
        return 1;
    }
    if (gpioHandler_registerButton(24) < 0) {
        fprintf(stderr, "Failed to register button\n");
        gpioHandler_cleanup();
        return 1;
    }
    if (gpioHandler_registerButton(5) < 0) {
        fprintf(stderr, "Failed to register button\n");
        gpioHandler_cleanup();
        return 1;
    }
    if (gpioHandler_registerButton(6) < 0) {
        fprintf(stderr, "Failed to register button\n");
        gpioHandler_cleanup();
        return 1;
    }

    // Main loop
    printf("Waiting for button press. Press CTRL+C to exit.\n");
    while (1) {
        fprintf(stdout, "GPIO value: %d", gpioHandler_readValue(5));
        sleep(100); // Wait for button press (callback handles the press)
    }

    // Cleanup (not reachable in this example, but good practice)
    gpioHandler_cleanup();
    return 0;
}
