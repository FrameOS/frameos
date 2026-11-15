#include "pk_console_queue.h"

#include <stdio.h>
#include <string.h>

#include "pk_args.h"

static const char *const s_panel_commands[] = {
    "set", "wifi", "restart", "factory-reset", "bootsel",
};

static bool is_panel_command(const char *name)
{
    for (size_t i = 0; i < sizeof(s_panel_commands) / sizeof(s_panel_commands[0]); i++) {
        if (strcmp(name, s_panel_commands[i]) == 0) return true;
    }
    return false;
}

bool pk_console_waits_for_panel(const char *line)
{
    char copy[PK_CONSOLE_QUEUE_LINE_MAX];
    char *argv[3];
    if (line == NULL) return false;
    snprintf(copy, sizeof(copy), "%s", line);
    int argc = pk_args_split(copy, argv, 3);
    if (argc < 1) return false;
    if (strcmp(argv[0], "usb_api") == 0) return argc >= 2 && is_panel_command(argv[1]);
    return is_panel_command(argv[0]);
}

bool pk_console_is_usb_api(const char *line)
{
    if (line == NULL) return false;
    while (*line == ' ' || *line == '\t') line++;
    return strncmp(line, "usb_api", 7) == 0 && (line[7] == '\0' || line[7] == ' ' || line[7] == '\t');
}

void pk_console_queue_init(pk_console_queue_t *queue)
{
    queue->head = 0;
    queue->count = 0;
}

bool pk_console_queue_push(pk_console_queue_t *queue, const char *line)
{
    if (line == NULL || queue->count >= PK_CONSOLE_QUEUE_SLOTS) return false;
    size_t len = strlen(line);
    if (len >= PK_CONSOLE_QUEUE_LINE_MAX) return false;
    uint8_t slot = (uint8_t)((queue->head + queue->count) % PK_CONSOLE_QUEUE_SLOTS);
    memcpy(queue->lines[slot], line, len + 1);
    queue->count++;
    return true;
}

bool pk_console_queue_pop(pk_console_queue_t *queue, char *out, size_t cap)
{
    if (queue->count == 0 || cap == 0) return false;
    snprintf(out, cap, "%s", queue->lines[queue->head]);
    queue->head = (uint8_t)((queue->head + 1) % PK_CONSOLE_QUEUE_SLOTS);
    queue->count--;
    return true;
}
