#include <stdio.h>
#include <stdlib.h>
#include <lgpio.h>

#include "gpioHandler.h" 

#define NUM_MAXBUF 1024

int h; // Handle for gpiochip

event_callback_t global_event_callback;
log_callback_t global_log_callback;

int gpioHandler_init(event_callback_t event_callback, log_callback_t log_callback) {
    global_event_callback = event_callback;
    global_log_callback = log_callback;

    char buffer[NUM_MAXBUF];
    FILE *fp;
    int gpioDevice = 0; // Default to gpiochip0

    // Determine the Raspberry Pi model
    fp = popen("grep 'Raspberry Pi 5' /proc/cpuinfo", "r");
    if (fp == NULL) {
        log_callback("It is not possible to determine the model of the Raspberry PI");
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
        log_callback("gpiochip open failed");
        return -1;
    }
    int i;
    return h;
}

// Intermediate function to handle alerts
void gpioHandler_alertsHandler(int num_alerts, lgGpioAlert_p alerts, void *userdata) {
    for (int i = 0; i < num_alerts; i++) {
        int gpio = alerts[i].report.gpio;
        int level = alerts[i].report.level;
        global_event_callback(gpio, level);
    }
}

// Register a button for alerts
int gpioHandler_registerButton(int button) {
    int res;
    printf("Claiming GPIO %d\n", button);

    res = lgGpioClaimInput(h, 0, button);
    if (res < 0) {
        printf("Unable to claim GPIO %d for input\n", button);
        return res;
    }
    
    res = lgGpioClaimAlert(h, 0, LG_FALLING_EDGE, button, -1);
    if (res < 0)
    {
        printf("can't claim GPIO %d (%s)\n", button, lguErrorText(res));
        return -1;
    }

    // Set the intermediate function as the callback for button presses
    lgGpioSetAlertsFunc(h, button, gpioHandler_alertsHandler, NULL);
    lgGpioSetDebounce(h, button, 100000); // 100ms debounce

    return 0;
}

int gpioHandler_readValue(int button) {
    return lgGpioRead(h, button);
}

// Cleanup resources
void gpioHandler_cleanup() {
    lgGpiochipClose(h);
}
