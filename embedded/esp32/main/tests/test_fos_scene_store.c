/* Host test of fos_scene_store.c: one scene at a time against a temporary
 * directory, standing in for /state.
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain -I$IDF_PATH/components/json/cJSON \
 *      $IDF_PATH/components/json/cJSON/cJSON.c main/fos_json_guard.c \
 *      main/fos_scene_store.c main/tests/test_fos_scene_store.c -lm -o t && ./t
 *
 * Run by backend/app/tasks/tests/test_esp32_scene_store.py.
 */
#define _DEFAULT_SOURCE
#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE
#include <dirent.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "cJSON.h"
#include "fos_scene_store.h"

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

static char s_dir[128];

static void fresh_dir(void)
{
    DIR *d = opendir(s_dir);
    if (d != NULL) {
        struct dirent *item;
        while ((item = readdir(d)) != NULL) {
            if (item->d_name[0] == '.') continue;
            char path[sizeof(s_dir) + 1 + sizeof(item->d_name)];
            snprintf(path, sizeof(path), "%s/%s", s_dir, item->d_name);
            remove(path);
        }
        closedir(d);
    }
    /* Removed behind its back, as a wipe does: the store forgets its files. */
    fos_scene_store_forget();
}

static long slot_file_size(int slot)
{
    char path[160];
    fos_scene_store_slot_path(slot, path, sizeof(path));
    struct stat st;
    return stat(path, &st) == 0 ? (long)st.st_size : -1;
}

static bool file_exists(const char *name)
{
    char path[160];
    snprintf(path, sizeof(path), "%s/%s", s_dir, name);
    struct stat st;
    return stat(path, &st) == 0;
}

static void write_text(const char *name, const char *text)
{
    char path[160];
    snprintf(path, sizeof(path), "%s/%s", s_dir, name);
    FILE *f = fopen(path, "wb");
    fputs(text, f);
    fclose(f);
}

static bool slot_file_exists(int slot)
{
    char path[160];
    fos_scene_store_slot_path(slot, path, sizeof(path));
    struct stat st;
    return stat(path, &st) == 0;
}

/* The index's entries, as fos_scenes.c reads them. */
typedef struct {
    char id[FOS_SCENE_STORE_ID_LEN];
    int slot;
    size_t bytes;
} entry_t;

static int read_entries(entry_t *out, int max)
{
    cJSON *index = fos_scene_store_read_index();
    if (index == NULL) return -1;
    int count = 0;
    const cJSON *entry = NULL;
    cJSON_ArrayForEach(entry, cJSON_GetObjectItem(index, "scenes")) {
        if (count >= max) break;
        snprintf(out[count].id, sizeof(out[count].id), "%s", cJSON_GetObjectItem(entry, "id")->valuestring);
        out[count].slot = fos_scene_store_entry_slot(entry);
        out[count].bytes = (size_t)cJSON_GetObjectItem(entry, "bytes")->valueint;
        count++;
    }
    cJSON_Delete(index);
    return count;
}

static fos_scene_store_err_t put_one(const char *json, fos_scene_store_result_t *result)
{
    fos_scene_store_put_t put = {json, strlen(json)};
    fos_scene_store_change_t change = {.puts = &put, .put_count = 1};
    return fos_scene_store_apply(&change, result, NULL, NULL);
}

static int slot_of(const char *id)
{
    entry_t entries[FOS_SCENE_STORE_SLOTS];
    int count = read_entries(entries, FOS_SCENE_STORE_SLOTS);
    for (int i = 0; i < count; i++) {
        if (strcmp(entries[i].id, id) == 0) return entries[i].slot;
    }
    return -1;
}

static void test_add_list_read(void)
{
    fresh_dir();
    fos_scene_store_result_t result;
    CHECK(put_one("{\"id\":\"a\",\"name\":\"Alpha \\\"x\\\"\",\"refreshInterval\":30,\"nodes\":[{\"x\":\"}{\"}]}", &result) == FOS_SCENE_STORE_OK);
    CHECK(result.scene_count == 1);
    CHECK(strcmp(result.first_put_id, "a") == 0);
    CHECK(put_one("{\"name\":\"Beta\",\"id\":\"b\"}", &result) == FOS_SCENE_STORE_OK);
    CHECK(result.scene_count == 2);
    entry_t entries[FOS_SCENE_STORE_SLOTS];
    int count = read_entries(entries, FOS_SCENE_STORE_SLOTS);
    CHECK(count == 2);
    CHECK(strcmp(entries[0].id, "a") == 0 && strcmp(entries[1].id, "b") == 0);
    size_t len = 0;
    char *body = fos_scene_store_read_scene("b", &len);
    CHECK(body != NULL && len == strlen("{\"name\":\"Beta\",\"id\":\"b\"}"));
    free(body);
    CHECK(fos_scene_store_read_scene("c", &len) == NULL);

    cJSON *tree = fos_scene_store_read_index();
    CHECK(cJSON_GetArraySize(cJSON_GetObjectItem(tree, "scenes")) == 2);
    const cJSON *first = cJSON_GetArrayItem(cJSON_GetObjectItem(tree, "scenes"), 0);
    CHECK(strcmp(cJSON_GetObjectItem(first, "name")->valuestring, "Alpha \"x\"") == 0);
    CHECK(cJSON_GetObjectItem(first, "refreshInterval")->valuedouble == 30);
    CHECK(cJSON_GetObjectItem(first, "bytes")->valueint > 0);
    CHECK(strcmp(cJSON_GetObjectItem(tree, "default")->valuestring, "a") == 0);
    cJSON_Delete(tree);
}

static void test_replace_writes_new_slot_keeps_old_until_sweep(void)
{
    fresh_dir();
    fos_scene_store_result_t result;
    CHECK(put_one("{\"id\":\"a\",\"name\":\"one\"}", &result) == FOS_SCENE_STORE_OK);
    CHECK(put_one("{\"id\":\"b\"}", &result) == FOS_SCENE_STORE_OK);
    int old_slot = slot_of("a");
    CHECK(put_one("{\"id\":\"a\",\"name\":\"two\"}", &result) == FOS_SCENE_STORE_OK);
    int new_slot = slot_of("a");
    CHECK(new_slot != old_slot);
    CHECK(slot_file_exists(old_slot) && slot_file_exists(new_slot));
    /* Order and count are unchanged; the content is the new one. */
    CHECK(result.scene_count == 2);
    size_t len = 0;
    char *body = fos_scene_store_read_scene("a", &len);
    CHECK(body != NULL && strstr(body, "two") != NULL);
    free(body);
    /* A slot that still has a file is not reused before the sweep. */
    CHECK(put_one("{\"id\":\"c\"}", &result) == FOS_SCENE_STORE_OK);
    CHECK(slot_of("c") != old_slot);
    fos_scene_store_sweep();
    CHECK(!slot_file_exists(old_slot));
    CHECK(slot_file_exists(new_slot));
    CHECK(slot_file_exists(slot_of("b")));
    /* And after it, it is. */
    CHECK(put_one("{\"id\":\"d\"}", &result) == FOS_SCENE_STORE_OK);
    CHECK(slot_of("d") == old_slot);
}

static void dropped_cb(const char *id, void *ctx)
{
    char *out = ctx;
    strcat(out, id);
    strcat(out, ";");
}

static void test_delete(void)
{
    fresh_dir();
    fos_scene_store_result_t result;
    put_one("{\"id\":\"a\"}", &result);
    put_one("{\"id\":\"b\"}", &result);
    char dropped[64] = "";
    fos_scene_store_change_t remove_a = {.remove_id = "a"};
    CHECK(fos_scene_store_apply(&remove_a, &result, dropped_cb, dropped) == FOS_SCENE_STORE_OK);
    CHECK(strcmp(dropped, "a;") == 0);
    CHECK(slot_of("a") == -1);
    CHECK(result.scene_count == 1);
    cJSON *tree = fos_scene_store_read_index();
    CHECK(strcmp(cJSON_GetObjectItem(tree, "default")->valuestring, "b") == 0);
    cJSON_Delete(tree);
    /* Nothing by that name, and never the last scene. */
    fos_scene_store_change_t remove_missing = {.remove_id = "zzz"};
    CHECK(fos_scene_store_apply(&remove_missing, &result, NULL, NULL) == FOS_SCENE_STORE_ERR_NOT_FOUND);
    fos_scene_store_change_t remove_last = {.remove_id = "b"};
    CHECK(fos_scene_store_apply(&remove_last, &result, NULL, NULL) == FOS_SCENE_STORE_ERR_LAST_SCENE);
    CHECK(slot_of("b") != -1);
}

static void test_patch_order_membership_source(void)
{
    fresh_dir();
    fos_scene_store_result_t result;
    put_one("{\"id\":\"a\"}", &result);
    put_one("{\"id\":\"b\"}", &result);
    put_one("{\"id\":\"c\"}", &result);
    fos_scene_store_put_t puts[] = {{"{\"id\":\"b\",\"name\":\"new b\"}", strlen("{\"id\":\"b\",\"name\":\"new b\"}")},
                                    {"{\"id\":\"d\"}", strlen("{\"id\":\"d\"}")}};
    const char *order_ids[] = {"d", "b", "a"};
    cJSON *order = cJSON_CreateStringArray(order_ids, 3);
    char dropped[64] = "";
    fos_scene_store_change_t patch = {.puts = puts, .put_count = 2, .order = order, .source = "cloud"};
    CHECK(fos_scene_store_apply(&patch, &result, dropped_cb, dropped) == FOS_SCENE_STORE_OK);
    CHECK(strcmp(dropped, "c;") == 0);
    CHECK(result.scene_count == 3);
    cJSON *tree = fos_scene_store_read_index();
    const cJSON *scenes = cJSON_GetObjectItem(tree, "scenes");
    CHECK(strcmp(cJSON_GetObjectItem(cJSON_GetArrayItem(scenes, 0), "id")->valuestring, "d") == 0);
    CHECK(strcmp(cJSON_GetObjectItem(cJSON_GetArrayItem(scenes, 2), "id")->valuestring, "a") == 0);
    CHECK(strcmp(cJSON_GetObjectItem(tree, "default")->valuestring, "d") == 0);
    CHECK(strcmp(cJSON_GetObjectItem(tree, "source")->valuestring, "cloud") == 0);
    cJSON_Delete(tree);
    /* An order naming a scene neither stored nor put changes nothing. */
    int b_slot = slot_of("b");
    fos_scene_store_put_t put_e = {"{\"id\":\"e\"}", strlen("{\"id\":\"e\"}")};
    const char *bad_ids[] = {"e", "ghost"};
    cJSON *bad_order = cJSON_CreateStringArray(bad_ids, 2);
    fos_scene_store_change_t bad = {.puts = &put_e, .put_count = 1, .order = bad_order};
    CHECK(fos_scene_store_apply(&bad, &result, NULL, NULL) == FOS_SCENE_STORE_ERR_MISSING_SCENE);
    CHECK(slot_of("e") == -1);
    CHECK(slot_of("b") == b_slot);
    /* Its file went with it (the failed op's slot is free again). */
    int files = 0;
    for (int slot = 0; slot < FOS_SCENE_STORE_SLOTS; slot++) files += slot_file_exists(slot);
    CHECK(files == 5); /* a, b, d, and until the sweep the old b and the dropped c */
    /* The same order twice is a missing scene too. */
    const char *dup_ids[] = {"a", "a"};
    cJSON *dup_order = cJSON_CreateStringArray(dup_ids, 2);
    fos_scene_store_change_t dup = {.order = dup_order};
    CHECK(fos_scene_store_apply(&dup, &result, NULL, NULL) == FOS_SCENE_STORE_ERR_MISSING_SCENE);
    /* An empty order is no scenes at all, and an id that is not a string is
     * no scene. */
    cJSON *empty_order = cJSON_CreateArray();
    fos_scene_store_change_t empty = {.order = empty_order};
    CHECK(fos_scene_store_apply(&empty, &result, NULL, NULL) == FOS_SCENE_STORE_ERR_LAST_SCENE);
    cJSON *odd_order = cJSON_Parse("[\"a\", 7]");
    fos_scene_store_change_t odd = {.order = odd_order};
    CHECK(fos_scene_store_apply(&odd, &result, NULL, NULL) == FOS_SCENE_STORE_ERR_MISSING_SCENE);
    cJSON_Delete(order);
    cJSON_Delete(bad_order);
    cJSON_Delete(dup_order);
    cJSON_Delete(empty_order);
    cJSON_Delete(odd_order);
}

static void test_patch_from_a_tree(void)
{
    fresh_dir();
    fos_scene_store_result_t result;
    put_one("{\"id\":\"a\"}", &result);
    put_one("{\"id\":\"b\"}", &result);
    /* A control plane's message is a tree already: its scenes are printed for
     * their files, and the order is its array of ids. */
    cJSON *message = cJSON_Parse("{\"put\":[{\"id\":\"b\",\"name\":\"B\"},{\"id\":\"c\"}],"
                                 "\"order\":[\"c\",\"b\",\"a\"]}");
    char dropped[64] = "";
    fos_scene_store_change_t patch = {
        .put_items = cJSON_GetObjectItem(message, "put"),
        .order = cJSON_GetObjectItem(message, "order"),
    };
    CHECK(fos_scene_store_apply(&patch, &result, dropped_cb, dropped) == FOS_SCENE_STORE_OK);
    CHECK(dropped[0] == '\0');
    CHECK(result.scene_count == 3);
    CHECK(result.put_bytes == strlen("{\"id\":\"b\",\"name\":\"B\"}") + strlen("{\"id\":\"c\"}"));
    CHECK(strcmp(result.first_put_id, "b") == 0);
    entry_t entries[4];
    CHECK(read_entries(entries, 4) == 3);
    CHECK(strcmp(entries[0].id, "c") == 0 && strcmp(entries[1].id, "b") == 0 && strcmp(entries[2].id, "a") == 0);
    size_t len = 0;
    char *body = fos_scene_store_read_scene("b", &len);
    CHECK(body != NULL && strcmp(body, "{\"id\":\"b\",\"name\":\"B\"}") == 0);
    free(body);
    /* A scene that is not an object is refused like a broken one. */
    cJSON *bad = cJSON_Parse("{\"put\":[\"nope\"],\"order\":[\"a\"]}");
    fos_scene_store_change_t refused = {
        .put_items = cJSON_GetObjectItem(bad, "put"),
        .order = cJSON_GetObjectItem(bad, "order"),
    };
    CHECK(fos_scene_store_apply(&refused, &result, NULL, NULL) == FOS_SCENE_STORE_ERR_INVALID);
    cJSON_Delete(bad);
    cJSON_Delete(message);
}

static void test_invalid_scenes(void)
{
    fresh_dir();
    fos_scene_store_result_t result;
    const char *bad[] = {
        "not json",
        "[{\"id\":\"a\"}]",               /* an array: use upload-scenes */
        "{\"id\":12}",                    /* id not a string */
        "{\"name\":\"no id\"}",
        "{\"id\":\"a\"",                  /* cut short */
        "{\"id\":\"a\"}{\"id\":\"b\"}",   /* two objects */
        "{\"id\":\"\"}",
    };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
        CHECK(put_one(bad[i], &result) == FOS_SCENE_STORE_ERR_INVALID);
    }
    CHECK(read_entries((entry_t[1]){0}, 1) == -1);
    /* An id that would not fit is refused, not cut short. */
    char long_id[FOS_SCENE_STORE_ID_LEN + 32];
    memset(long_id, 'x', sizeof(long_id) - 1);
    long_id[sizeof(long_id) - 1] = '\0';
    char long_scene[sizeof(long_id) + 32];
    snprintf(long_scene, sizeof(long_scene), "{\"id\":\"%s\"}", long_id);
    CHECK(put_one(long_scene, &result) == FOS_SCENE_STORE_ERR_INVALID);
    /* White space around one object is fine. */
    CHECK(put_one("  {\"id\":\"a\"}\n", &result) == FOS_SCENE_STORE_OK);
}

static void test_slots_run_out(void)
{
    fresh_dir();
    fos_scene_store_result_t result;
    char json[64];
    for (int i = 0; i < FOS_SCENE_STORE_SLOTS; i++) {
        snprintf(json, sizeof(json), "{\"id\":\"s%d\"}", i);
        CHECK(put_one(json, &result) == FOS_SCENE_STORE_OK);
    }
    CHECK(put_one("{\"id\":\"one-too-many\"}", &result) == FOS_SCENE_STORE_ERR_NO_SLOTS);
    /* Replacing also needs a free slot until a scene is removed and swept. */
    CHECK(put_one("{\"id\":\"s3\",\"name\":\"x\"}", &result) == FOS_SCENE_STORE_ERR_NO_SLOTS);
    fos_scene_store_change_t remove_one = {.remove_id = "s0"};
    CHECK(fos_scene_store_apply(&remove_one, &result, NULL, NULL) == FOS_SCENE_STORE_OK);
    fos_scene_store_sweep();
    CHECK(put_one("{\"id\":\"s3\",\"name\":\"x\"}", &result) == FOS_SCENE_STORE_OK);
}

static void test_repoint(void)
{
    fresh_dir();
    fos_scene_store_result_t result;
    put_one("{\"id\":\"a\",\"name\":\"good\"}", &result);
    int good_slot = slot_of("a");
    put_one("{\"id\":\"a\",\"name\":\"broken\"}", &result);
    CHECK(fos_scene_store_repoint("a", good_slot) == FOS_SCENE_STORE_OK);
    size_t len = 0;
    char *body = fos_scene_store_read_scene("a", &len);
    CHECK(body != NULL && strstr(body, "good") != NULL);
    free(body);
    entry_t entries[2];
    CHECK(read_entries(entries, 2) == 1);
    CHECK(entries[0].bytes == strlen("{\"id\":\"a\",\"name\":\"good\"}"));
    CHECK(fos_scene_store_repoint("zzz", good_slot) == FOS_SCENE_STORE_ERR_NOT_FOUND);
}

static void test_sweep_needs_a_good_index(void)
{
    fresh_dir();
    fos_scene_store_result_t result;
    put_one("{\"id\":\"a\"}", &result);
    int slot = slot_of("a");
    char path[160];
    snprintf(path, sizeof(path), "%s/%s", s_dir, FOS_SCENE_STORE_INDEX_NAME);
    /* Damaged: every slot file stays. */
    FILE *f = fopen(path, "wb");
    fputs("{broken", f);
    fclose(f);
    fos_scene_store_sweep();
    CHECK(slot_file_exists(slot));
    /* Gone: every slot file stays too. */
    remove(path);
    fos_scene_store_sweep();
    CHECK(slot_file_exists(slot));
}

static void test_recover_index_after_power_cut(void)
{
    fresh_dir();
    fos_scene_store_result_t result;
    put_one("{\"id\":\"a\"}", &result);
    /* The copy is written first and stays: it is the change made. */
    CHECK(file_exists(FOS_SCENE_STORE_INDEX_TMP_NAME));
    put_one("{\"id\":\"b\"}", &result);
    /* A power cut while the index was rewritten in place: torn. Readers take
     * the copy, which holds both scenes. */
    write_text(FOS_SCENE_STORE_INDEX_NAME, "{\"scenes\":[{\"id\":\"a\",\"sl");
    CHECK(read_entries((entry_t[2]){0}, 2) == 2);
    CHECK(slot_of("b") != -1);
    /* And the boot puts it back in place. */
    CHECK(fos_scene_store_recover_index());
    CHECK(file_exists(FOS_SCENE_STORE_INDEX_NAME));
    CHECK(read_entries((entry_t[2]){0}, 2) == 2);
    /* Nothing to do when the index is whole. */
    CHECK(!fos_scene_store_recover_index());
    /* Gone (firmware before 2026.11.6 removed it, then renamed the tmp): the
     * copy too. */
    char path[160];
    char tmp[160];
    snprintf(path, sizeof(path), "%s/%s", s_dir, FOS_SCENE_STORE_INDEX_NAME);
    snprintf(tmp, sizeof(tmp), "%s/%s", s_dir, FOS_SCENE_STORE_INDEX_TMP_NAME);
    put_one("{\"id\":\"c\"}", &result);
    remove(tmp);
    rename(path, tmp);
    CHECK(slot_of("c") != -1);
    CHECK(fos_scene_store_recover_index());
    CHECK(slot_of("c") != -1);
    /* No index and no copy: a removed index is gone, not taken from a copy. */
    fos_scene_store_remove_index();
    CHECK(read_entries((entry_t[1]){0}, 1) == -1);
    CHECK(!fos_scene_store_recover_index());
}

static void test_the_store_knows_its_slot_files(void)
{
    /* A lookup by name walks every block of a SPIFFS partition (about half a
     * second on 24 MB), so after the first sweep the store stops asking
     * flash which slot files exist: it wrote and removed them all. */
    fresh_dir();
    fos_scene_store_result_t result;
    put_one("{\"id\":\"a\"}", &result);
    /* Not known yet (a boot before its sweep): a file nobody names is kept
     * out of use, it may be one a reader still holds. */
    int next = 1;
    char name[32];
    snprintf(name, sizeof(name), "scene-%d.json", next);
    write_text(name, "{\"id\":\"held\"}");
    CHECK(put_one("{\"id\":\"b\"}", &result) == FOS_SCENE_STORE_OK);
    CHECK(slot_of("b") != next);
    /* The boot's sweep removes what nobody names, an old slot tmp included,
     * and from then on the store knows its files. */
    write_text(FOS_SCENE_STORE_SLOT_TMP_NAME, "{\"id\":\"half\"");
    fos_scene_store_sweep();
    CHECK(!slot_file_exists(next));
    CHECK(!file_exists(FOS_SCENE_STORE_SLOT_TMP_NAME));
    CHECK(slot_file_exists(slot_of("a")) && slot_file_exists(slot_of("b")));
    /* A slot the store retired stays out of use until the sweep, which
     * empties it and keeps the file: the next put opens a file that is there
     * (a lookup that finds it) instead of creating one (two that walk the
     * whole partition). */
    int retired = slot_of("a");
    CHECK(put_one("{\"id\":\"a\",\"name\":\"two\"}", &result) == FOS_SCENE_STORE_OK);
    CHECK(put_one("{\"id\":\"c\"}", &result) == FOS_SCENE_STORE_OK);
    CHECK(slot_of("a") != retired && slot_of("c") != retired);
    CHECK(slot_file_size(retired) > 0);
    fos_scene_store_sweep();
    CHECK(slot_file_size(retired) == 0);
    CHECK(put_one("{\"id\":\"d\"}", &result) == FOS_SCENE_STORE_OK);
    CHECK(slot_of("d") == retired);
    CHECK(slot_file_size(retired) == (long)strlen("{\"id\":\"d\"}"));
    size_t len = 0;
    char *body = fos_scene_store_read_scene("d", &len);
    CHECK(body != NULL && strcmp(body, "{\"id\":\"d\"}") == 0);
    free(body);
    /* A whole set starts over from empty files: no slot holds a scene. */
    fos_scene_store_remove_slots();
    int scenes = 0;
    for (int slot = 0; slot < FOS_SCENE_STORE_SLOTS; slot++) scenes += slot_file_size(slot) > 0;
    CHECK(scenes == 0);
    /* And a whole set written over them uses those files first. */
    fos_scene_store_put_t two[] = {{"{\"id\":\"x\"}", 10}, {"{\"id\":\"y\"}", 10}};
    fos_scene_store_change_t all = {.puts = two, .put_count = 2, .replace_all = true};
    CHECK(fos_scene_store_apply(&all, &result, NULL, NULL) == FOS_SCENE_STORE_OK);
    CHECK(slot_file_size(slot_of("x")) == 10 && slot_file_size(slot_of("y")) == 10);
    /* Never two scenes in one file, spare or not. */
    CHECK(slot_of("x") != slot_of("y"));
    /* A slot is written straight to its name: no slot tmp. */
    CHECK(!file_exists(FOS_SCENE_STORE_SLOT_TMP_NAME));
}

static void test_old_index_without_bytes(void)
{
    fresh_dir();
    char path[160];
    snprintf(path, sizeof(path), "%s/%s", s_dir, FOS_SCENE_STORE_INDEX_NAME);
    FILE *f = fopen(path, "wb");
    fputs("{\"scenes\":[{\"id\":\"a\",\"slot\":4}],\"default\":\"a\"}", f);
    fclose(f);
    fos_scene_store_slot_path(4, path, sizeof(path));
    f = fopen(path, "wb");
    fputs("{\"id\":\"a\"}", f);
    fclose(f);
    cJSON *tree = fos_scene_store_read_index();
    const cJSON *entry = cJSON_GetArrayItem(cJSON_GetObjectItem(tree, "scenes"), 0);
    CHECK(cJSON_GetObjectItem(entry, "bytes")->valueint == (int)strlen("{\"id\":\"a\"}"));
    cJSON_Delete(tree);
    fos_scene_store_result_t result;
    /* A put keeps the old entry's slot out of use. */
    CHECK(put_one("{\"id\":\"b\"}", &result) == FOS_SCENE_STORE_OK);
    CHECK(slot_of("b") != 4);
    CHECK(result.scene_count == 2);
}

static const char *default_id(void)
{
    static char out[FOS_SCENE_STORE_ID_LEN];
    cJSON *tree = fos_scene_store_read_index();
    const cJSON *value = cJSON_GetObjectItem(tree, "default");
    snprintf(out, sizeof(out), "%s", cJSON_IsString(value) ? value->valuestring : "");
    cJSON_Delete(tree);
    return out;
}

static bool entry_has(const char *id, const char *flag)
{
    cJSON *tree = fos_scene_store_read_index();
    const cJSON *entry = NULL;
    bool found = false;
    cJSON_ArrayForEach(entry, cJSON_GetObjectItem(tree, "scenes")) {
        if (strcmp(cJSON_GetObjectItem(entry, "id")->valuestring, id) == 0) {
            found = cJSON_IsTrue(cJSON_GetObjectItem(entry, flag));
        }
    }
    cJSON_Delete(tree);
    return found;
}

static void test_layouts_and_the_default(void)
{
    fresh_dir();
    fos_scene_store_result_t result;
    /* A layout is never what a frame boots to, even first in the list. */
    CHECK(put_one("{\"id\":\"wrap\",\"settings\":{\"isLayout\":true}}", &result) == FOS_SCENE_STORE_OK);
    CHECK(entry_has("wrap", "isLayout"));
    CHECK(default_id()[0] == '\0');
    CHECK(put_one("{\"id\":\"a\"}", &result) == FOS_SCENE_STORE_OK);
    CHECK(strcmp(default_id(), "a") == 0);
    /* The scene marked default wins, and keeps winning while others change. */
    CHECK(put_one("{\"id\":\"b\",\"default\":true}", &result) == FOS_SCENE_STORE_OK);
    CHECK(entry_has("b", "default") && !entry_has("a", "default"));
    CHECK(strcmp(default_id(), "b") == 0);
    CHECK(put_one("{\"id\":\"a\",\"name\":\"again\"}", &result) == FOS_SCENE_STORE_OK);
    CHECK(strcmp(default_id(), "b") == 0);
    fos_scene_store_change_t remove_b = {.remove_id = "b"};
    CHECK(fos_scene_store_apply(&remove_b, &result, NULL, NULL) == FOS_SCENE_STORE_OK);
    CHECK(strcmp(default_id(), "a") == 0);
    /* Two puts of one id in one change are not one scene. */
    fos_scene_store_put_t twice[] = {{"{\"id\":\"c\"}", 10}, {"{\"id\":\"c\"}", 10}};
    fos_scene_store_change_t dup = {.puts = twice, .put_count = 2};
    CHECK(fos_scene_store_apply(&dup, &result, NULL, NULL) == FOS_SCENE_STORE_ERR_INVALID);
    CHECK(slot_of("c") == -1);
}

static void test_replace_all(void)
{
    fresh_dir();
    fos_scene_store_result_t result;
    put_one("{\"id\":\"a\"}", &result);
    put_one("{\"id\":\"b\"}", &result);
    /* A whole set, straight from the payload's bytes: no NUL after each. */
    const char *payload = "[{\"id\":\"x\",\"name\":\"X\"},{\"id\":\"y\",\"default\":true}]";
    fos_scene_store_put_t puts[] = {{payload + 1, 21}, {payload + 23, 25}};
    char dropped[64] = "";
    fos_scene_store_change_t all = {.puts = puts, .put_count = 2, .replace_all = true, .source = "backend"};
    CHECK(fos_scene_store_apply(&all, &result, dropped_cb, dropped) == FOS_SCENE_STORE_OK);
    CHECK(strcmp(dropped, "a;b;") == 0);
    CHECK(result.scene_count == 2);
    entry_t entries[FOS_SCENE_STORE_SLOTS];
    CHECK(read_entries(entries, FOS_SCENE_STORE_SLOTS) == 2);
    CHECK(strcmp(entries[0].id, "x") == 0 && strcmp(entries[1].id, "y") == 0);
    CHECK(entries[0].bytes == 21);
    CHECK(strcmp(default_id(), "y") == 0);
    size_t len = 0;
    char *body = fos_scene_store_read_scene("x", &len);
    CHECK(body != NULL && strcmp(body, "{\"id\":\"x\",\"name\":\"X\"}") == 0);
    free(body);
    fos_scene_store_sweep();
    int files = 0;
    for (int slot = 0; slot < FOS_SCENE_STORE_SLOTS; slot++) files += slot_file_exists(slot);
    CHECK(files == 2);
}

static int s_paced = 0;
static void count_pace(void) { s_paced++; }

static void test_every_2_kb_written_is_paced(void)
{
    /* fos_scenes.c's hook waits out renders and taps there (a flash write
     * stalls both cores): every write of the store goes through it, a slot,
     * the index and a whole file alike. */
    fresh_dir();
    fos_scene_store_hooks_t hooks = {.pace = count_pace};
    fos_scene_store_set_hooks(&hooks);
    static char big[5000];
    memset(big, 'x', sizeof(big));
    char path[160], tmp[160];
    snprintf(path, sizeof(path), "%s/big.json", s_dir);
    snprintf(tmp, sizeof(tmp), "%s/big.tmp", s_dir);
    s_paced = 0;
    CHECK(fos_scene_store_write_file(path, tmp, big, sizeof(big)) == FOS_SCENE_STORE_OK);
    CHECK(s_paced == 3); /* 2048 + 2048 + 904 */
    s_paced = 0;
    fos_scene_store_result_t result;
    CHECK(put_one("{\"id\":\"paced\"}", &result) == FOS_SCENE_STORE_OK);
    CHECK(s_paced >= 2); /* the slot, then the index */
    fos_scene_store_hooks_t none = {0};
    fos_scene_store_set_hooks(&none);
    s_paced = 0;
    CHECK(fos_scene_store_write_file(path, tmp, big, sizeof(big)) == FOS_SCENE_STORE_OK);
    CHECK(s_paced == 0);
}

int main(void)
{
    snprintf(s_dir, sizeof(s_dir), "/tmp/fos_scene_store_%d", (int)getpid());
    mkdir(s_dir, 0700);
    fos_scene_store_set_dir(s_dir);

    test_add_list_read();
    test_replace_writes_new_slot_keeps_old_until_sweep();
    test_delete();
    test_patch_order_membership_source();
    test_patch_from_a_tree();
    test_invalid_scenes();
    test_slots_run_out();
    test_repoint();
    test_sweep_needs_a_good_index();
    test_recover_index_after_power_cut();
    test_the_store_knows_its_slot_files();
    test_old_index_without_bytes();
    test_layouts_and_the_default();
    test_replace_all();
    test_every_2_kb_written_is_paced();

    fresh_dir();
    rmdir(s_dir);
    printf("%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
