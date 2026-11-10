/* Host test of components/frameos_display/fos_refresh_queue.c: the pictures
 * owed to a panel whose full refresh runs on the display's own task. What
 * must hold: the caller never waits for a refresh (a put returns at once),
 * the picture on its way to the glass is never written while it is shown,
 * a picture asked for meanwhile is the next one and the newest wins, and the
 * queue is idle exactly when nothing is owed (a timed render and the park
 * read that).
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Icomponents/frameos_display/include \
 *      components/frameos_display/fos_refresh_queue.c \
 *      main/tests/test_fos_refresh_queue.c -o t && ./t
 *
 * Run by backend/app/tasks/tests/test_esp32_refresh_queue.py.
 */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "fos_refresh_queue.h"

static int checks = 0;
static int failures = 0;

#define CHECK(cond)                                                              \
    do {                                                                         \
        checks++;                                                                \
        if (!(cond)) {                                                           \
            failures++;                                                          \
            printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);               \
        }                                                                        \
    } while (0)

static int s_allocs = 0;
static int s_frees = 0;
static bool s_out_of_memory = false;

static void *fake_alloc(size_t len)
{
    if (s_out_of_memory) return NULL;
    s_allocs++;
    return malloc(len);
}

static void fake_release(void *buf)
{
    if (buf != NULL) s_frees++;
    free(buf);
}

static fos_refresh_queue_t fresh_queue(void)
{
    s_allocs = 0;
    s_frees = 0;
    s_out_of_memory = false;
    return (fos_refresh_queue_t){.alloc = fake_alloc, .release = fake_release};
}

#define LEN 64

static void picture(uint8_t *buf, uint8_t value)
{
    memset(buf, value, LEN);
}

static bool shows(const uint8_t *buf, uint8_t value)
{
    if (buf == NULL) return false;
    for (size_t i = 0; i < LEN; i++) {
        if (buf[i] != value) return false;
    }
    return true;
}

static void test_one_refresh(void)
{
    fos_refresh_queue_t queue = fresh_queue();
    uint8_t buf[LEN];
    CHECK(!fos_refresh_queue_busy(&queue));
    CHECK(fos_refresh_queue_current(&queue) == NULL);
    picture(buf, 0xA1);
    CHECK(fos_refresh_queue_put(&queue, buf, LEN) == FOS_REFRESH_STARTED);
    /* A copy: the caller's buffer is the next render's canvas. */
    picture(buf, 0x00);
    CHECK(fos_refresh_queue_busy(&queue));
    CHECK(shows(fos_refresh_queue_current(&queue), 0xA1));
    CHECK(!fos_refresh_queue_done(&queue));
    CHECK(!fos_refresh_queue_busy(&queue));
    CHECK(fos_refresh_queue_current(&queue) == NULL);
    CHECK(s_allocs == 1 && s_frees == 1);
}

static void test_the_newest_waits_as_the_next(void)
{
    fos_refresh_queue_t queue = fresh_queue();
    uint8_t buf[LEN];
    picture(buf, 1);
    CHECK(fos_refresh_queue_put(&queue, buf, LEN) == FOS_REFRESH_STARTED);
    const uint8_t *shown = fos_refresh_queue_current(&queue);
    /* Three renders while the glass refreshes: none of them waits, none
     * touches the picture being shown, and only the last is kept. */
    picture(buf, 2);
    CHECK(fos_refresh_queue_put(&queue, buf, LEN) == FOS_REFRESH_QUEUED);
    picture(buf, 3);
    CHECK(fos_refresh_queue_put(&queue, buf, LEN) == FOS_REFRESH_QUEUED);
    picture(buf, 4);
    CHECK(fos_refresh_queue_put(&queue, buf, LEN) == FOS_REFRESH_QUEUED);
    CHECK(fos_refresh_queue_current(&queue) == shown);
    CHECK(shows(shown, 1));
    /* The next one reuses its buffer: two pictures' worth at the most. */
    CHECK(s_allocs == 2);
    CHECK(fos_refresh_queue_busy(&queue));
    /* The first refresh ends: the newest is next, still owed. */
    CHECK(fos_refresh_queue_done(&queue));
    CHECK(fos_refresh_queue_busy(&queue));
    CHECK(shows(fos_refresh_queue_current(&queue), 4));
    CHECK(!fos_refresh_queue_done(&queue));
    CHECK(!fos_refresh_queue_busy(&queue));
    CHECK(s_allocs == 2 && s_frees == 2);
}

static void test_a_picture_asked_for_during_the_last_refresh(void)
{
    fos_refresh_queue_t queue = fresh_queue();
    uint8_t buf[LEN];
    picture(buf, 1);
    fos_refresh_queue_put(&queue, buf, LEN);
    picture(buf, 2);
    fos_refresh_queue_put(&queue, buf, LEN);
    CHECK(fos_refresh_queue_done(&queue)); /* 2 on its way */
    picture(buf, 3);
    CHECK(fos_refresh_queue_put(&queue, buf, LEN) == FOS_REFRESH_QUEUED);
    CHECK(shows(fos_refresh_queue_current(&queue), 2));
    CHECK(fos_refresh_queue_done(&queue));
    CHECK(shows(fos_refresh_queue_current(&queue), 3));
    CHECK(!fos_refresh_queue_done(&queue));
    /* Idle again: the next put starts the task again. */
    picture(buf, 5);
    CHECK(fos_refresh_queue_put(&queue, buf, LEN) == FOS_REFRESH_STARTED);
    CHECK(!fos_refresh_queue_done(&queue));
    CHECK(s_allocs == s_frees);
}

static void test_no_memory_changes_nothing(void)
{
    fos_refresh_queue_t queue = fresh_queue();
    uint8_t buf[LEN];
    s_out_of_memory = true;
    picture(buf, 1);
    /* The caller refreshes in place: the queue stays idle. */
    CHECK(fos_refresh_queue_put(&queue, buf, LEN) == FOS_REFRESH_NO_MEMORY);
    CHECK(!fos_refresh_queue_busy(&queue));
    CHECK(fos_refresh_queue_current(&queue) == NULL);
    s_out_of_memory = false;
    CHECK(fos_refresh_queue_put(&queue, buf, LEN) == FOS_REFRESH_STARTED);
    s_out_of_memory = true;
    picture(buf, 2);
    /* Busy and no room for the next: the refresh running is untouched. */
    CHECK(fos_refresh_queue_put(&queue, buf, LEN) == FOS_REFRESH_NO_MEMORY);
    CHECK(shows(fos_refresh_queue_current(&queue), 1));
    CHECK(!fos_refresh_queue_done(&queue));
    CHECK(!fos_refresh_queue_busy(&queue));
    s_out_of_memory = false;
}

static void test_a_new_size_gets_a_new_buffer(void)
{
    fos_refresh_queue_t queue = fresh_queue();
    uint8_t small[LEN / 2];
    uint8_t buf[LEN];
    memset(small, 7, sizeof(small));
    picture(buf, 1);
    fos_refresh_queue_put(&queue, buf, LEN);
    fos_refresh_queue_put(&queue, buf, LEN);
    /* A next picture of another size (a panel re-selected) does not write
     * past the buffer it would have reused. */
    CHECK(fos_refresh_queue_put(&queue, small, sizeof(small)) == FOS_REFRESH_QUEUED);
    CHECK(queue.len == sizeof(small));
    CHECK(fos_refresh_queue_done(&queue));
    CHECK(memcmp(fos_refresh_queue_current(&queue), small, sizeof(small)) == 0);
    CHECK(!fos_refresh_queue_done(&queue));
    CHECK(s_allocs == s_frees);
}

int main(void)
{
    test_one_refresh();
    test_the_newest_waits_as_the_next();
    test_a_picture_asked_for_during_the_last_refresh();
    test_no_memory_changes_nothing();
    test_a_new_size_gets_a_new_buffer();
    printf("%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
