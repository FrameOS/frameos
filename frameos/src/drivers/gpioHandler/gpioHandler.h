#ifndef GPIO_HANDLER_H
#define GPIO_HANDLER_H

typedef void (*event_callback_t)(int gpio, int level);
typedef void (*log_callback_t)(char *message);

int gpioHandler_init(event_callback_t event_callback, log_callback_t log_callback);

int gpioHandler_registerButton(int button);

int gpioHandler_readValue(int button);

void gpioHandler_cleanup();

#endif // GPIO_HANDLER_H
