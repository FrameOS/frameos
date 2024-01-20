#include <stdio.h>
#include <lgpio.h>

#include "gpioHandler.h" 

#define NUM_MAXBUF 1024

int h; // Handle for gpiochip
simple_button_callback_t global_simple_callback;

int init(simple_button_callback_t callback) {
    char buffer[NUM_MAXBUF];
    FILE *fp;
    int gpioDevice = 0; // Default to gpiochip0

    // Determine the Raspberry Pi model
    fp = popen("grep 'Raspberry Pi 5' /proc/cpuinfo", "r");
    if (fp == NULL) {
        fprintf(stderr, "It is not possible to determine the model of the Raspberry PI\n");
        return -1;
    }

    if (fgets(buffer, sizeof(buffer), fp) != NULL) {
        // Raspberry Pi 5 detected, use gpiochip4
        gpioDevice = 4;
    }

    pclose(fp);

    // Open the appropriate gpiochip device
    h = lgGpiochipOpen(gpioDevice);
    if (h < 0) {
        fprintf(stderr, "gpiochip%d open failed\n", gpioDevice);
        return -1;
    }

    // Store the callback
    global_simple_callback = callback;

    return h;
}

// Intermediate function to handle alerts
void intermediate_button_handler(int num_alerts, lgGpioAlert_p alerts, void *userdata) {
    for (int i = 0; i < num_alerts; i++) {
        global_simple_callback(alerts[i].report.gpio, alerts[i].report.level);
    }
}

// Register a button for alerts
int registerButton(int button) {
    int res;

    // Claim GPIO for input and set pull-up
    res = lgGpioClaimInput(h, 0, button);
    if (res < 0) {
        fprintf(stderr, "Unable to claim GPIO %d for input\n", button);
        return res;
    }

    // Set the intermediate function as the callback for button presses
    lgGpioSetAlertsFunc(h, intermediate_button_handler, NULL, NULL);

    return 0;
}

// Cleanup resources
void cleanup() {
    lgGpiochipClose(h);
}
