#ifndef GPIO_HANDLER_H
#define GPIO_HANDLER_H

// Simplified callback function prototype
typedef void (*simple_button_callback_t)(int gpio, int level);

// Function to initialize the GPIO system and set the simplified callback
int init(simple_button_callback_t callback);

// Function to register a button for alerts
int registerButton(int button);

// Function to cleanup resources
void cleanup();

#endif // GPIO_HANDLER_H
