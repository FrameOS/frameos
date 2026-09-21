/* Host stand-in for freertos/task.h; see FreeRTOS.h next to it. */
#pragma once

#include "freertos/FreeRTOS.h"

typedef void *TaskHandle_t;
typedef void (*TaskFunction_t)(void *arg);

BaseType_t xTaskCreate(TaskFunction_t task, const char *name, uint32_t stack_depth, void *arg,
                       UBaseType_t priority, TaskHandle_t *handle);
void vTaskDelay(TickType_t ticks);
