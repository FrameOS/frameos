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
    /* Emptied and kept: the next put opens a file that is there. */
    CHECK(slot_file_size(old_slot) == 0);
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
    /* As many scenes as a set holds, and not one more. */
    for (int i = 0; i < FOS_SCENE_STORE_SCENES; i++) {
        snprintf(json, sizeof(json), "{\"id\":\"s%d\"}", i);
        CHECK(put_one(json, &result) == FOS_SCENE_STORE_OK);
    }
    CHECK(put_one("{\"id\":\"one-too-many\"}", &result) == FOS_SCENE_STORE_ERR_NO_SLOTS);
    entry_t entries[FOS_SCENE_STORE_SCENES + 1];
    CHECK(read_entries(entries, FOS_SCENE_STORE_SCENES + 1) == FOS_SCENE_STORE_SCENES);
    /* A full set replaced whole fits beside itself: twice the slots. */
    for (int i = 0; i < FOS_SCENE_STORE_SCENES; i++) {
        snprintf(json, sizeof(json), "{\"id\":\"s%d\",\"v\":2}", i);
        CHECK(put_one(json, &result) == FOS_SCENE_STORE_OK);
    }
    /* A replaced scene's file stays until the sweep: no slot is left now. */
    CHECK(put_one("{\"id\":\"s3\",\"name\":\"x\"}", &result) == FOS_SCENE_STORE_ERR_NO_SLOTS);
    fos_scene_store_sweep();
    CHECK(put_one("{\"id\":\"s3\",\"name\":\"x\"}", &result) == FOS_SCENE_STORE_OK);
    /* A whole set of one too many is refused before anything is written. */
    fos_scene_store_put_t many[FOS_SCENE_STORE_SCENES + 1];
    static char texts[FOS_SCENE_STORE_SCENES + 1][24];
    for (int i = 0; i <= FOS_SCENE_STORE_SCENES; i++) {
        snprintf(texts[i], sizeof(texts[i]), "{\"id\":\"m%d\"}", i);
        many[i] = (fos_scene_store_put_t){texts[i], strlen(texts[i])};
    }
    fos_scene_store_change_t all = {.puts = many, .put_count = FOS_SCENE_STORE_SCENES + 1, .replace_all = true};
    CHECK(fos_scene_store_apply(&all, &result, NULL, NULL) == FOS_SCENE_STORE_ERR_NO_SLOTS);
    fos_scene_store_set_result_t set;
    CHECK(fos_scene_store_apply_set(many, FOS_SCENE_STORE_SCENES + 1, NULL, &set, NULL, NULL) ==
          FOS_SCENE_STORE_ERR_NO_SLOTS);
    CHECK(read_entries(entries, FOS_SCENE_STORE_SCENES + 1) == FOS_SCENE_STORE_SCENES);
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
     * second on 24 MB), so the store lists the directory once, the first
     * time it needs to know, and stops asking flash which slot files exist:
     * from there it wrote and removed them all. */
    fresh_dir();
    fos_scene_store_result_t result;
    put_one("{\"id\":\"a\"}", &result);
    /* A boot: what a crash left is there before the store looks. A file
     * nobody names is kept out of use, it may be one a reader still holds. */
    int next = 1;
    char name[32];
    snprintf(name, sizeof(name), "scene-%d.json", next);
    write_text(name, "{\"id\":\"held\"}");
    write_text(FOS_SCENE_STORE_SLOT_TMP_NAME, "{\"id\":\"half\"");
    /* Names that are not a slot's are nobody's business. */
    write_text("scene-1.json.bak", "x");
    write_text("scene-01.json", "x");
    write_text("scene-999.json", "x");
    fos_scene_store_forget();
    CHECK(put_one("{\"id\":\"b\"}", &result) == FOS_SCENE_STORE_OK);
    CHECK(slot_of("b") != next);
    /* The boot's sweep empties what nobody names and removes an old slot
     * tmp. */
    fos_scene_store_sweep();
    CHECK(slot_file_size(next) == 0);
    CHECK(!file_exists(FOS_SCENE_STORE_SLOT_TMP_NAME));
    CHECK(file_exists("scene-1.json.bak") && file_exists("scene-01.json") && file_exists("scene-999.json"));
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

static bool entry_says(const char *id, const char *key, const char *value)
{
    cJSON *tree = fos_scene_store_read_index();
    const cJSON *entry = NULL;
    bool found = false;
    cJSON_ArrayForEach(entry, cJSON_GetObjectItem(tree, "scenes")) {
        if (strcmp(cJSON_GetObjectItem(entry, "id")->valuestring, id) == 0) {
            const cJSON *item = cJSON_GetObjectItem(entry, key);
            found = value == NULL ? item == NULL : cJSON_IsString(item) && strcmp(item->valuestring, value) == 0;
        }
    }
    cJSON_Delete(tree);
    return found;
}

static bool entry_has_key(const char *id, const char *key)
{
    cJSON *tree = fos_scene_store_read_index();
    const cJSON *entry = NULL;
    bool found = false;
    cJSON_ArrayForEach(entry, cJSON_GetObjectItem(tree, "scenes")) {
        if (strcmp(cJSON_GetObjectItem(entry, "id")->valuestring, id) == 0) {
            found = cJSON_GetObjectItem(entry, key) != NULL;
        }
    }
    cJSON_Delete(tree);
    return found;
}

/* A scene's own window size goes in its entry: a desktop opens it at that size
 * without reading the scene off flash. */
static void test_window_size_in_the_index(void)
{
    fresh_dir();
    fos_scene_store_result_t result;
    CHECK(put_one("{\"id\":\"player\",\"settings\":{\"windowSize\":\"480x480\"}}", &result) == FOS_SCENE_STORE_OK);
    CHECK(entry_says("player", "windowSize", "480x480"));
    CHECK(put_one("{\"id\":\"plain\",\"settings\":{\"windowSize\":\"\"}}", &result) == FOS_SCENE_STORE_OK);
    CHECK(entry_says("plain", "windowSize", NULL));
    CHECK(put_one("{\"id\":\"odd\",\"settings\":{\"windowSize\":480}}", &result) == FOS_SCENE_STORE_OK);
    CHECK(entry_says("odd", "windowSize", NULL));
    /* A layout has no window of its own. */
    CHECK(put_one("{\"id\":\"desk\",\"settings\":{\"isLayout\":true,\"windowSize\":\"480x480\"}}", &result) == FOS_SCENE_STORE_OK);
    CHECK(entry_says("desk", "windowSize", NULL));
}

/* Its icon too (docs/scene-icons.md): the switcher draws it and a desktop
 * lists it without reading the scene off flash. Only a value too long for an
 * icon stays out; the runtime checks the path. */
static void test_icon_in_the_index(void)
{
    fresh_dir();
    fos_scene_store_result_t result;
    CHECK(put_one("{\"id\":\"sun\",\"settings\":{\"icon\":\"M12 2L2 22h20z\"}}", &result) == FOS_SCENE_STORE_OK);
    CHECK(entry_says("sun", "icon", "M12 2L2 22h20z"));
    CHECK(put_one("{\"id\":\"blank\",\"settings\":{\"icon\":\" \\n\"}}", &result) == FOS_SCENE_STORE_OK);
    CHECK(entry_says("blank", "icon", NULL));
    CHECK(put_one("{\"id\":\"odd\",\"settings\":{\"icon\":24}}", &result) == FOS_SCENE_STORE_OK);
    CHECK(entry_says("odd", "icon", NULL));
    /* 1024 characters between a leading space and a trailing newline fit;
     * one more does not. */
    char scene[1200], icon[1100];
    size_t at = (size_t)snprintf(icon, sizeof(icon), " M0 0");
    while (at < 1 + 1024) at += (size_t)snprintf(icon + at, sizeof(icon) - at, "h1");
    snprintf(scene, sizeof(scene), "{\"id\":\"full\",\"settings\":{\"icon\":\"%s\\n\"}}", icon);
    CHECK(put_one(scene, &result) == FOS_SCENE_STORE_OK);
    CHECK(entry_has_key("full", "icon"));
    snprintf(scene, sizeof(scene), "{\"id\":\"long\",\"settings\":{\"icon\":\"%sz\"}}", icon);
    CHECK(put_one(scene, &result) == FOS_SCENE_STORE_OK);
    CHECK(entry_says("long", "icon", NULL));
    /* A layout is in no list, so it needs none. */
    CHECK(put_one("{\"id\":\"desk\",\"settings\":{\"isLayout\":true,\"icon\":\"M0 0h24v24H0z\"}}", &result) == FOS_SCENE_STORE_OK);
    CHECK(entry_says("desk", "icon", NULL));
}

/* And its category (docs/scene-icons.md "Category"), the name a desktop
 * groups its scene lists by and the frame page its layouts by: kept as it is,
 * text of 128 bytes or fewer, and listed so by the runtime. */
static void test_category_in_the_index(void)
{
    fresh_dir();
    fos_scene_store_result_t result;
    CHECK(put_one("{\"id\":\"sky\",\"settings\":{\"category\":\"Weather\"}}", &result) == FOS_SCENE_STORE_OK);
    CHECK(entry_says("sky", "category", "Weather"));
    CHECK(put_one("{\"id\":\"art\",\"settings\":{\"category\":\"Art & galleries\"}}", &result) == FOS_SCENE_STORE_OK);
    CHECK(entry_says("art", "category", "Art & galleries"));
    char scene[300], name[140];
    memset(name, 'x', 129);
    name[129] = '\0';
    snprintf(scene, sizeof(scene), "{\"id\":\"long\",\"settings\":{\"category\":\"%s\"}}", name);
    CHECK(put_one(scene, &result) == FOS_SCENE_STORE_OK);
    CHECK(entry_says("long", "category", NULL));
    CHECK(put_one("{\"id\":\"odd\",\"settings\":{\"category\":7}}", &result) == FOS_SCENE_STORE_OK);
    CHECK(entry_says("odd", "category", NULL));
    CHECK(put_one("{\"id\":\"desk\",\"settings\":{\"isLayout\":true,\"category\":\"Desktop layouts\"}}", &result) == FOS_SCENE_STORE_OK);
    CHECK(entry_says("desk", "category", "Desktop layouts"));
}

static void test_layouts_and_the_default(void)
{
    fresh_dir();
    fos_scene_store_result_t result;
    /* A layout is never what a frame boots to, even first in the list. */
    CHECK(put_one("{\"id\":\"wrap\",\"settings\":{\"isLayout\":true}}", &result) == FOS_SCENE_STORE_OK);
    CHECK(entry_has("wrap", "isLayout"));
    CHECK(!entry_has("wrap", "desktop"));
    CHECK(put_one("{\"id\":\"desk\",\"settings\":{\"isLayout\":true,\"desktop\":true}}", &result) == FOS_SCENE_STORE_OK);
    CHECK(entry_has("desk", "isLayout") && entry_has("desk", "desktop"));
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
    for (int slot = 0; slot < FOS_SCENE_STORE_SLOTS; slot++) files += slot_file_size(slot) > 0;
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

static void test_a_set_file_from_its_scenes(void)
{
    /* A backend set read in pieces (fos_scene_pieces.h) is written as the
     * combined file it would have been, without a block of its size. */
    fresh_dir();
    char path[160], tmp[160];
    snprintf(path, sizeof(path), "%s/scenes.json", s_dir);
    snprintf(tmp, sizeof(tmp), "%s/scenes.tmp", s_dir);
    fos_scene_store_put_t scenes[] = {{"{\"id\":\"a\"}", 10}, {"{\"id\":\"b\"}", 10}};
    const char *want[] = {"[]", "[{\"id\":\"a\"}]", "[{\"id\":\"a\"},{\"id\":\"b\"}]"};
    for (int count = 0; count <= 2; count++) {
        CHECK(fos_scene_store_write_set(path, tmp, scenes, count) == FOS_SCENE_STORE_OK);
        size_t len = 0;
        char *text = fos_scene_store_read_file(path, &len);
        CHECK(text != NULL && len == strlen(want[count]) && strcmp(text, want[count]) == 0);
        free(text);
    }
}

/* Every file in the directory, in bytes: what /state holds. */
static long dir_bytes(void)
{
    long total = 0;
    DIR *d = opendir(s_dir);
    struct dirent *item;
    while (d != NULL && (item = readdir(d)) != NULL) {
        if (item->d_name[0] == '.') continue;
        char path[sizeof(s_dir) + 1 + sizeof(item->d_name)];
        snprintf(path, sizeof(path), "%s/%s", s_dir, item->d_name);
        struct stat st;
        if (stat(path, &st) == 0) total += (long)st.st_size;
    }
    if (d != NULL) closedir(d);
    return total;
}

/* The most /state held, a write's bytes counted before it starts (the store
 * asks make_room for them first). */
static long s_peak = 0;
static int s_writes = 0;
static int s_between = 0;
static void count_between(void) { s_between++; }
static void track_room(size_t bytes)
{
    s_writes++;
    long now = dir_bytes() + (long)bytes;
    if (now > s_peak) s_peak = now;
}

static char *scene_text(const char *id, char fill, size_t size)
{
    char *text = malloc(size + 1);
    int head = snprintf(text, size + 1, "{\"id\":\"%s\",\"pad\":\"", id);
    memset(text + head, fill, size - (size_t)head - 2);
    memcpy(text + size - 2, "\"}", 3);
    return text;
}

static void test_a_whole_set_one_scene_at_a_time(void)
{
    fresh_dir();
    fos_scene_store_set_result_t set;
    fos_scene_store_put_t one = {"{\"id\":\"a\"}", 10};
    /* No index: the caller stores a first set another way. */
    CHECK(fos_scene_store_apply_set(&one, 1, "cloud", &set, NULL, NULL) == FOS_SCENE_STORE_ERR_NOT_FOUND);
    CHECK(dir_bytes() == 0);

    /* Five scenes of 3 KB on flash. */
    enum { SIZE = 3000 };
    char *v1[5], *v2[5];
    const char *names[5] = {"a", "b", "c", "d", "e"};
    fos_scene_store_put_t puts[5];
    for (int i = 0; i < 5; i++) {
        v1[i] = scene_text(names[i], 'x', SIZE);
        v2[i] = scene_text(names[i], 'y', SIZE);
        puts[i] = (fos_scene_store_put_t){v1[i], SIZE};
    }
    fos_scene_store_result_t result;
    fos_scene_store_change_t all = {.puts = puts, .put_count = 5, .replace_all = true, .source = "cloud"};
    CHECK(fos_scene_store_apply(&all, &result, NULL, NULL) == FOS_SCENE_STORE_OK);
    fos_scene_store_sweep();

    /* The same set again: nothing is written, not even the index. */
    fos_scene_store_hooks_t hooks = {.make_room = track_room, .between = count_between};
    fos_scene_store_set_hooks(&hooks);
    s_writes = 0;
    s_between = 0;
    CHECK(fos_scene_store_apply_set(puts, 5, "cloud", &set, NULL, NULL) == FOS_SCENE_STORE_OK);
    CHECK(set.written == 0 && set.kept == 5 && set.dropped == 0 && set.scene_count == 5);
    CHECK(s_writes == 0 && s_between == 0);

    /* Every scene new: /state never holds more than the set and one scene
     * (and the index twice); a whole set beside the old one was twice that. */
    for (int i = 0; i < 5; i++) puts[i].json = v2[i];
    long before = dir_bytes();
    s_peak = 0;
    CHECK(fos_scene_store_apply_set(puts, 5, "cloud", &set, NULL, NULL) == FOS_SCENE_STORE_OK);
    CHECK(set.written == 5 && set.kept == 0 && set.written_bytes == 5 * SIZE);
    /* The caller's moment after each committed scene and after the file it
     * replaced is emptied: its lock goes there. */
    CHECK(s_between == 10);
    printf("  a whole set one scene at a time: peak %ld bytes over a %ld-byte store\n", s_peak, before);
    CHECK(s_peak <= before + SIZE + 1024);
    size_t len = 0;
    char *body = fos_scene_store_read_scene("c", &len);
    CHECK(body != NULL && len == SIZE && body[SIZE - 3] == 'y');
    free(body);

    /* One changed, one new, one dropped, in a new order: only two written. */
    char *v3 = scene_text("b", 'z', SIZE);
    char *f = scene_text("f", 'f', 200);
    fos_scene_store_put_t mixed[5] = {{f, 200}, {v2[0], SIZE}, {v3, SIZE}, {v2[3], SIZE}, {v2[4], SIZE}};
    char dropped[64] = "";
    CHECK(fos_scene_store_apply_set(mixed, 5, "backend", &set, dropped_cb, dropped) == FOS_SCENE_STORE_OK);
    CHECK(set.written == 2 && set.kept == 3 && set.dropped == 1);
    CHECK(strcmp(dropped, "c;") == 0);
    entry_t entries[FOS_SCENE_STORE_SLOTS];
    CHECK(read_entries(entries, FOS_SCENE_STORE_SLOTS) == 5);
    CHECK(strcmp(entries[0].id, "f") == 0 && strcmp(entries[1].id, "a") == 0 && strcmp(entries[2].id, "b") == 0 &&
          strcmp(entries[3].id, "d") == 0 && strcmp(entries[4].id, "e") == 0);
    cJSON *index = fos_scene_store_read_index();
    CHECK(strcmp(cJSON_GetObjectItem(index, "source")->valuestring, "backend") == 0);
    cJSON_Delete(index);
    body = fos_scene_store_read_scene("b", &len);
    CHECK(body != NULL && body[SIZE - 3] == 'z');
    free(body);
    /* What the old b and the dropped c held is emptied, not left beside them. */
    int full = 0;
    for (int slot = 0; slot < FOS_SCENE_STORE_SLOTS; slot++) full += slot_file_size(slot) > 0;
    CHECK(full == 5);

    /* A set with none of the scenes stored: the new one first, then the old
     * ones go (a frame keeps a scene throughout). */
    fos_scene_store_put_t fresh_set[2] = {{"{\"id\":\"p\"}", 10}, {"{\"id\":\"q\"}", 10}};
    dropped[0] = '\0';
    CHECK(fos_scene_store_apply_set(fresh_set, 2, NULL, &set, dropped_cb, dropped) == FOS_SCENE_STORE_OK);
    CHECK(set.written == 2 && set.dropped == 5);
    CHECK(strcmp(dropped, "f;a;b;d;e;") == 0);
    CHECK(read_entries(entries, FOS_SCENE_STORE_SLOTS) == 2);
    CHECK(strcmp(entries[0].id, "p") == 0 && strcmp(entries[1].id, "q") == 0);

    /* A set that is not whole is refused before anything is written. */
    fos_scene_store_put_t twice[2] = {{"{\"id\":\"p\",\"v\":2}", 16}, {"{\"id\":\"p\"}", 10}};
    s_writes = 0;
    CHECK(fos_scene_store_apply_set(twice, 2, NULL, &set, NULL, NULL) == FOS_SCENE_STORE_ERR_INVALID);
    fos_scene_store_put_t broken = {"{\"id\":\"p\"", 9};
    CHECK(fos_scene_store_apply_set(&broken, 1, NULL, &set, NULL, NULL) == FOS_SCENE_STORE_ERR_INVALID);
    CHECK(s_writes == 0);

    /* An index from before the hash: every scene is written once, then kept. */
    write_text("scene-index.json", "{\"scenes\":[{\"id\":\"p\",\"slot\":0,\"bytes\":10}]}");
    write_text("scene-0.json", "{\"id\":\"p\"}");
    fos_scene_store_forget();
    fos_scene_store_put_t p = {"{\"id\":\"p\"}", 10};
    CHECK(fos_scene_store_apply_set(&p, 1, NULL, &set, NULL, NULL) == FOS_SCENE_STORE_OK && set.written == 1);
    CHECK(fos_scene_store_apply_set(&p, 1, NULL, &set, NULL, NULL) == FOS_SCENE_STORE_OK && set.written == 0);
    /* A scene pointed back at an older file loses its hash: written again. */
    int slot = slot_of("p");
    CHECK(fos_scene_store_repoint("p", slot) == FOS_SCENE_STORE_OK);
    CHECK(fos_scene_store_apply_set(&p, 1, NULL, &set, NULL, NULL) == FOS_SCENE_STORE_OK && set.written == 1);

    fos_scene_store_hooks_t none = {0};
    fos_scene_store_set_hooks(&none);
    for (int i = 0; i < 5; i++) {
        free(v1[i]);
        free(v2[i]);
    }
    free(v3);
    free(f);
}

static bool s_room = true;
static size_t s_room_asked = 0;
static bool has_room(size_t bytes)
{
    s_room_asked = bytes;
    return s_room;
}

/* With room for it, a whole set is one change: every changed scene written,
 * the index once. */
static void test_a_whole_set_at_once_where_there_is_room(void)
{
    fresh_dir();
    enum { SIZE = 3000, N = 6 };
    char *v1[N], *v2[N], *v3[N];
    const char *names[N] = {"a", "b", "c", "d", "e", "f"};
    fos_scene_store_put_t puts[N];
    for (int i = 0; i < N; i++) {
        v1[i] = scene_text(names[i], 'x', SIZE);
        v2[i] = scene_text(names[i], 'y', SIZE);
        v3[i] = scene_text(names[i], 'z', SIZE);
        puts[i] = (fos_scene_store_put_t){v1[i], SIZE};
    }
    fos_scene_store_result_t result;
    fos_scene_store_change_t all = {.puts = puts, .put_count = N, .replace_all = true, .source = "backend"};
    CHECK(fos_scene_store_apply(&all, &result, NULL, NULL) == FOS_SCENE_STORE_OK);
    fos_scene_store_sweep();

    fos_scene_store_hooks_t hooks = {.make_room = track_room, .between = count_between, .has_room = has_room};
    fos_scene_store_set_hooks(&hooks);
    fos_scene_store_set_result_t set;

    /* Four of six changed, one dropped, a new order: one step. */
    fos_scene_store_put_t next[5] = {{v2[4], SIZE}, {v2[0], SIZE}, {v1[1], SIZE}, {v2[2], SIZE}, {v2[3], SIZE}};
    char dropped[64] = "";
    s_room = true;
    s_between = 0;
    s_writes = 0;
    CHECK(fos_scene_store_apply_set(next, 5, "cloud", &set, dropped_cb, dropped) == FOS_SCENE_STORE_OK);
    CHECK(set.at_once && set.written == 4 && set.kept == 1 && set.dropped == 1 && set.scene_count == 5);
    CHECK(set.written_bytes == 4 * SIZE);
    /* Four scene files, then the index and its copy: six files written. A
     * step a scene writes the index twice for each. */
    CHECK(s_writes == 6);
    /* The caller's moment after each piece written, after the change and
     * after each of the five files it emptied (four replaced, one dropped):
     * its lock is never held across the set. */
    CHECK(s_between == 10);
    /* Asked for the changed scenes and the index twice, not the whole set. */
    CHECK(s_room_asked >= 4 * SIZE && s_room_asked < 4 * SIZE + 5 * 4096);
    CHECK(strcmp(dropped, "f;") == 0);
    entry_t entries[FOS_SCENE_STORE_SLOTS];
    CHECK(read_entries(entries, FOS_SCENE_STORE_SLOTS) == 5);
    CHECK(strcmp(entries[0].id, "e") == 0 && strcmp(entries[1].id, "a") == 0 && strcmp(entries[2].id, "b") == 0 &&
          strcmp(entries[3].id, "c") == 0 && strcmp(entries[4].id, "d") == 0);
    cJSON *index = fos_scene_store_read_index();
    CHECK(strcmp(cJSON_GetObjectItem(index, "source")->valuestring, "cloud") == 0);
    cJSON_Delete(index);
    size_t len = 0;
    char *body = fos_scene_store_read_scene("c", &len);
    CHECK(body != NULL && len == SIZE && body[SIZE - 3] == 'y');
    free(body);
    body = fos_scene_store_read_scene("b", &len);
    CHECK(body != NULL && body[SIZE - 3] == 'x');
    free(body);
    /* The files the old scenes had are emptied, as the long way leaves them. */
    int full = 0;
    for (int slot = 0; slot < FOS_SCENE_STORE_SLOTS; slot++) full += slot_file_size(slot) > 0;
    CHECK(full == 5);

    /* Without the room, one scene at a time as before. */
    for (int i = 0; i < 5; i++) next[i].json = v3[i];
    s_room = false;
    s_between = 0;
    s_writes = 0;
    CHECK(fos_scene_store_apply_set(next, 5, "cloud", &set, NULL, NULL) == FOS_SCENE_STORE_OK);
    CHECK(!set.at_once && set.written == 5 && set.dropped == 0);
    CHECK(s_between >= 5 && s_writes >= 15);
    CHECK(read_entries(entries, FOS_SCENE_STORE_SLOTS) == 5);
    CHECK(strcmp(entries[0].id, "a") == 0 && strcmp(entries[4].id, "e") == 0);

    /* One changed scene is one step either way: nothing to ask. */
    next[2].json = v1[2];
    s_room = true;
    s_room_asked = 0;
    CHECK(fos_scene_store_apply_set(next, 5, "cloud", &set, NULL, NULL) == FOS_SCENE_STORE_OK);
    CHECK(!set.at_once && set.written == 1 && s_room_asked == 0);

    /* Room but no slots for all of them at once: the long way, which gives
     * each replaced file back before the next. */
    fresh_dir();
    enum { MANY = 100 };
    static char small[3][MANY][32];
    fos_scene_store_put_t lots[MANY];
    for (int v = 0; v < 3; v++) {
        for (int i = 0; i < MANY; i++) snprintf(small[v][i], sizeof(small[v][i]), "{\"id\":\"s%d\",\"v\":%d}", i, v);
    }
    for (int i = 0; i < MANY; i++) lots[i] = (fos_scene_store_put_t){small[0][i], strlen(small[0][i])};
    fos_scene_store_change_t first = {.puts = lots, .put_count = MANY, .replace_all = true};
    CHECK(fos_scene_store_apply(&first, &result, NULL, NULL) == FOS_SCENE_STORE_OK);
    /* Each replaced once, no sweep: two hundred slots hold a file. */
    for (int i = 0; i < MANY; i++) {
        fos_scene_store_put_t put = {small[1][i], strlen(small[1][i])};
        fos_scene_store_change_t one = {.puts = &put, .put_count = 1};
        CHECK(fos_scene_store_apply(&one, &result, NULL, NULL) == FOS_SCENE_STORE_OK);
    }
    for (int i = 0; i < MANY; i++) lots[i] = (fos_scene_store_put_t){small[2][i], strlen(small[2][i])};
    CHECK(fos_scene_store_apply_set(lots, MANY, NULL, &set, NULL, NULL) == FOS_SCENE_STORE_OK);
    CHECK(!set.at_once && set.written == MANY);
    body = fos_scene_store_read_scene("s99", &len);
    CHECK(body != NULL && strcmp(body, small[2][99]) == 0);
    free(body);
    /* Swept, the same change fits at once. */
    fos_scene_store_sweep();
    for (int i = 0; i < MANY; i++) lots[i] = (fos_scene_store_put_t){small[0][i], strlen(small[0][i])};
    CHECK(fos_scene_store_apply_set(lots, MANY, NULL, &set, NULL, NULL) == FOS_SCENE_STORE_OK);
    CHECK(set.at_once && set.written == MANY);

    fos_scene_store_hooks_t none = {0};
    fos_scene_store_set_hooks(&none);
    for (int i = 0; i < N; i++) {
        free(v1[i]);
        free(v2[i]);
        free(v3[i]);
    }
}

/* One scene staged, its bytes `piece` at a time. */
static fos_scene_store_err_t stage_scene(unsigned int id, const char *text, size_t piece, bool *kept)
{
    fos_scene_store_err_t err = fos_scene_store_stage_begin(id);
    size_t len = strlen(text);
    for (size_t at = 0; err == FOS_SCENE_STORE_OK && at < len; at += piece) {
        err = fos_scene_store_stage_write(id, text + at, len - at < piece ? len - at : piece);
    }
    if (err == FOS_SCENE_STORE_OK) err = fos_scene_store_stage_end(id, kept);
    return err;
}

/* The index entry of `scene_id` as text, its slot aside. */
static char *entry_text(const char *scene_id)
{
    cJSON *index = fos_scene_store_read_index();
    char *text = NULL;
    cJSON *entry = NULL;
    cJSON_ArrayForEach(entry, cJSON_GetObjectItem(index, "scenes")) {
        if (strcmp(cJSON_GetObjectItem(entry, "id")->valuestring, scene_id) != 0) continue;
        cJSON_DeleteItemFromObject(entry, "slot");
        text = cJSON_PrintUnformatted(entry);
    }
    cJSON_Delete(index);
    return text;
}

/* A set written as it arrives: straight to slot files, then one change. */
static void test_a_set_staged_as_it_arrives(void)
{
    fresh_dir();
    fos_scene_store_result_t result;
    const char *clock = "{\"apps\":{\"a\":{\"name\":\"not it\",\"sources\":{\"app.ts\":\"{}}\"}}},\"default\":true,"
                        "\"id\":\"clock\",\"name\":\"Cl\\u00f6ck\",\"nodes\":[{\"id\":\"n\"}],"
                        "\"settings\":{\"category\":\"Real time\",\"icon\":\"M1 2Z\",\"windowSize\":\"800x600\"}}";
    const char *desk = "{\"id\":\"desk\",\"name\":\"Desk\",\"settings\":{\"desktop\":true,\"isLayout\":true}}";
    const char *photo = "{\"id\":\"photo\",\"name\":\"Photo\",\"refreshInterval\":300}";

    /* What the index keeps of each, as a put of the whole text makes it. */
    fos_scene_store_put_t whole[3] = {{clock, strlen(clock)}, {desk, strlen(desk)}, {photo, strlen(photo)}};
    fos_scene_store_change_t all = {.puts = whole, .put_count = 3, .replace_all = true, .source = "backend"};
    CHECK(fos_scene_store_apply(&all, &result, NULL, NULL) == FOS_SCENE_STORE_OK);
    char *want[3] = {entry_text("clock"), entry_text("desk"), entry_text("photo")};
    cJSON *index = fos_scene_store_read_index();
    char *want_default = cJSON_PrintUnformatted(cJSON_GetObjectItem(index, "default"));
    cJSON_Delete(index);

    /* No store yet: the staged set is the first, at every read size. */
    size_t pieces[] = {1, 7, 4096};
    for (size_t p = 0; p < sizeof(pieces) / sizeof(pieces[0]); p++) {
        fresh_dir();
        unsigned int id = fos_scene_store_stage_open();
        CHECK(id != 0);
        bool kept = true;
        CHECK(stage_scene(id, clock, pieces[p], &kept) == FOS_SCENE_STORE_OK && !kept);
        CHECK(stage_scene(id, desk, pieces[p], &kept) == FOS_SCENE_STORE_OK && !kept);
        CHECK(stage_scene(id, photo, pieces[p], &kept) == FOS_SCENE_STORE_OK && !kept);
        int written = 0, stored = 0;
        size_t bytes = 0;
        fos_scene_store_stage_counts(id, &written, &stored, &bytes);
        CHECK(written == 3 && stored == 0 && bytes == strlen(clock) + strlen(desk) + strlen(photo));
        /* Nothing the index names yet: there is none. */
        CHECK(fos_scene_store_read_index() == NULL);
        fos_scene_store_change_t commit = {.staged = id, .source = "backend"};
        CHECK(fos_scene_store_apply(&commit, &result, NULL, NULL) == FOS_SCENE_STORE_OK);
        CHECK(result.scene_count == 3 && strcmp(result.first_put_id, "clock") == 0 && result.put_bytes == bytes);
        entry_t entries[8];
        CHECK(read_entries(entries, 8) == 3);
        CHECK(strcmp(entries[0].id, "clock") == 0 && strcmp(entries[1].id, "desk") == 0 &&
              strcmp(entries[2].id, "photo") == 0);
        const char *ids[3] = {"clock", "desk", "photo"};
        for (int i = 0; i < 3; i++) {
            char *got = entry_text(ids[i]);
            CHECK(got != NULL && strcmp(got, want[i]) == 0);
            if (got != NULL && strcmp(got, want[i]) != 0) printf("  staged %s\n  whole  %s\n", got, want[i]);
            cJSON_free(got);
            size_t len = 0;
            char *body = fos_scene_store_read_scene(ids[i], &len);
            CHECK(body != NULL && len == whole[i].len && memcmp(body, whole[i].json, len) == 0);
            free(body);
        }
        index = fos_scene_store_read_index();
        char *got_default = cJSON_PrintUnformatted(cJSON_GetObjectItem(index, "default"));
        CHECK(strcmp(got_default, want_default) == 0);
        CHECK(strcmp(cJSON_GetObjectItem(index, "source")->valuestring, "backend") == 0);
        cJSON_free(got_default);
        cJSON_Delete(index);
        /* The id is spent: a second commit of it changes nothing. */
        CHECK(fos_scene_store_apply(&commit, &result, NULL, NULL) == FOS_SCENE_STORE_ERR_INVALID);
        CHECK(read_entries(entries, 8) == 3);
    }

    /* Against the set stored: a scene that is there byte for byte is kept in
     * its file, a changed one and a new one are written, the rest go. */
    fos_scene_store_sweep();
    int clock_slot = slot_of("clock");
    const char *photo2 = "{\"id\":\"photo\",\"name\":\"Photo\",\"refreshInterval\":600}";
    const char *fresh = "{\"id\":\"new\"}";
    unsigned int id = fos_scene_store_stage_open();
    bool kept = false;
    CHECK(stage_scene(id, fresh, 5, &kept) == FOS_SCENE_STORE_OK && !kept);
    CHECK(stage_scene(id, clock, 5, &kept) == FOS_SCENE_STORE_OK && kept);
    CHECK(stage_scene(id, photo2, 5, &kept) == FOS_SCENE_STORE_OK && !kept);
    int written = 0, stored = 0;
    fos_scene_store_stage_counts(id, &written, &stored, NULL);
    CHECK(written == 2 && stored == 1);
    /* Until the commit the set is as it was, and a sweep leaves the staged
     * files alone. */
    fos_scene_store_sweep();
    entry_t entries[8];
    CHECK(read_entries(entries, 8) == 3 && slot_of("photo") >= 0);
    size_t len = 0;
    char *body = fos_scene_store_read_scene("photo", &len);
    CHECK(body != NULL && strcmp(body, photo) == 0);
    free(body);
    /* Another change in between takes none of the staged files. */
    CHECK(put_one("{\"id\":\"desk\",\"name\":\"Desk 2\",\"settings\":{\"isLayout\":true}}", &result) ==
          FOS_SCENE_STORE_OK);
    char dropped[64] = "";
    fos_scene_store_change_t commit = {.staged = id, .source = "backend"};
    CHECK(fos_scene_store_apply(&commit, &result, dropped_cb, dropped) == FOS_SCENE_STORE_OK);
    CHECK(strcmp(dropped, "desk;") == 0);
    CHECK(read_entries(entries, 8) == 3);
    CHECK(strcmp(entries[0].id, "new") == 0 && strcmp(entries[1].id, "clock") == 0 &&
          strcmp(entries[2].id, "photo") == 0);
    CHECK(slot_of("clock") == clock_slot);
    body = fos_scene_store_read_scene("photo", &len);
    CHECK(body != NULL && strcmp(body, photo2) == 0);
    free(body);
    body = fos_scene_store_read_scene("new", &len);
    CHECK(body != NULL && strcmp(body, fresh) == 0);
    free(body);
    fos_scene_store_sweep();
    int full = 0;
    for (int slot = 0; slot < FOS_SCENE_STORE_SLOTS; slot++) full += slot_file_size(slot) > 0;
    CHECK(full == 3);

    /* A patch: the staged scenes with an order of the caller's, naming scenes
     * that stay as they are. A staged scene the order leaves out is nobody's. */
    id = fos_scene_store_stage_open();
    CHECK(stage_scene(id, desk, 3, &kept) == FOS_SCENE_STORE_OK && !kept);
    CHECK(stage_scene(id, "{\"id\":\"stray\"}", 3, &kept) == FOS_SCENE_STORE_OK && !kept);
    cJSON *order = cJSON_Parse("[\"photo\",\"desk\",\"clock\"]");
    fos_scene_store_change_t patch = {.staged = id, .order = order};
    dropped[0] = '\0';
    CHECK(fos_scene_store_apply(&patch, &result, dropped_cb, dropped) == FOS_SCENE_STORE_OK);
    CHECK(strcmp(dropped, "new;") == 0);
    CHECK(read_entries(entries, 8) == 3);
    CHECK(strcmp(entries[0].id, "photo") == 0 && strcmp(entries[1].id, "desk") == 0 &&
          strcmp(entries[2].id, "clock") == 0);
    cJSON_Delete(order);
    fos_scene_store_sweep();
    full = 0;
    for (int slot = 0; slot < FOS_SCENE_STORE_SLOTS; slot++) full += slot_file_size(slot) > 0;
    CHECK(full == 3);

    /* A scene found stored already that another change replaced meanwhile is
     * not that scene any more: the commit is refused and nothing changes. */
    id = fos_scene_store_stage_open();
    CHECK(stage_scene(id, clock, 100, &kept) == FOS_SCENE_STORE_OK && kept);
    CHECK(stage_scene(id, fresh, 100, &kept) == FOS_SCENE_STORE_OK && !kept);
    CHECK(put_one("{\"id\":\"clock\",\"name\":\"edited\"}", &result) == FOS_SCENE_STORE_OK);
    fos_scene_store_change_t stale = {.staged = id};
    CHECK(fos_scene_store_apply(&stale, &result, NULL, NULL) == FOS_SCENE_STORE_ERR_MISSING_SCENE);
    CHECK(read_entries(entries, 8) == 3 && slot_of("new") < 0);
    fos_scene_store_sweep();
    full = 0;
    for (int slot = 0; slot < FOS_SCENE_STORE_SLOTS; slot++) full += slot_file_size(slot) > 0;
    CHECK(full == 3);

    /* Dropped: its files are given back and its id is nothing's. */
    id = fos_scene_store_stage_open();
    CHECK(stage_scene(id, fresh, 100, &kept) == FOS_SCENE_STORE_OK);
    CHECK(fos_scene_store_stage_begin(id) == FOS_SCENE_STORE_OK);
    CHECK(fos_scene_store_stage_write(id, "{\"id\":\"half", 11) == FOS_SCENE_STORE_OK);
    fos_scene_store_stage_drop(id);
    CHECK(fos_scene_store_stage_write(id, "\"}", 2) == FOS_SCENE_STORE_ERR_INVALID);
    CHECK(fos_scene_store_stage_begin(id) == FOS_SCENE_STORE_ERR_INVALID);
    fos_scene_store_change_t gone = {.staged = id};
    CHECK(fos_scene_store_apply(&gone, &result, NULL, NULL) == FOS_SCENE_STORE_ERR_INVALID);
    full = 0;
    for (int slot = 0; slot < FOS_SCENE_STORE_SLOTS; slot++) full += slot_file_size(slot) > 0;
    CHECK(full == 3);

    /* A new staging ends the one before; a whole payload's split ends it too. */
    unsigned int earlier = fos_scene_store_stage_open();
    CHECK(stage_scene(earlier, fresh, 100, &kept) == FOS_SCENE_STORE_OK);
    id = fos_scene_store_stage_open();
    CHECK(id != earlier);
    CHECK(fos_scene_store_stage_begin(earlier) == FOS_SCENE_STORE_ERR_INVALID);
    fos_scene_store_change_t wrong = {.staged = earlier};
    CHECK(fos_scene_store_apply(&wrong, &result, NULL, NULL) == FOS_SCENE_STORE_ERR_INVALID);
    CHECK(stage_scene(id, fresh, 100, &kept) == FOS_SCENE_STORE_OK);
    CHECK(fos_scene_store_stage_begin(id) == FOS_SCENE_STORE_OK);
    fos_scene_store_remove_slots();
    CHECK(fos_scene_store_stage_write(id, "{}", 2) == FOS_SCENE_STORE_ERR_INVALID);
    CHECK(fos_scene_store_stage_end(id, &kept) == FOS_SCENE_STORE_ERR_INVALID);

    /* What is not one scene with an id of its own is refused where it ends,
     * and its file given back; the scenes before it stay staged. */
    fresh_dir();
    id = fos_scene_store_stage_open();
    CHECK(stage_scene(id, fresh, 100, &kept) == FOS_SCENE_STORE_OK);
    CHECK(stage_scene(id, "{\"name\":\"no id\"}", 100, &kept) == FOS_SCENE_STORE_ERR_INVALID);
    CHECK(stage_scene(id, "{\"id\":\"\"}", 100, &kept) == FOS_SCENE_STORE_ERR_INVALID);
    CHECK(stage_scene(id, fresh, 100, &kept) == FOS_SCENE_STORE_ERR_INVALID); /* twice */
    char deep[256] = "{\"id\":\"deep\",\"a\":";
    for (int i = 0; i < 40; i++) strcat(deep, "[");
    for (int i = 0; i < 40; i++) strcat(deep, "]");
    strcat(deep, "}");
    CHECK(stage_scene(id, deep, 100, &kept) == FOS_SCENE_STORE_ERR_INVALID);
    fos_scene_store_stage_counts(id, &written, &stored, NULL);
    CHECK(written == 1);
    full = 0;
    for (int slot = 0; slot < FOS_SCENE_STORE_SLOTS; slot++) full += slot_file_size(slot) > 0;
    CHECK(full == 1);
    /* A scene too big to ever be read back is refused as it comes. */
    char *huge = malloc(FOS_SCENE_STORE_MAX_BYTES + 64);
    memset(huge, 'x', FOS_SCENE_STORE_MAX_BYTES + 63);
    huge[FOS_SCENE_STORE_MAX_BYTES + 63] = '\0';
    const char *huge_head = "{\"id\":\"huge\",\"p\":\"";
    memcpy(huge, huge_head, strlen(huge_head));
    CHECK(stage_scene(id, huge, 60000, &kept) == FOS_SCENE_STORE_ERR_INVALID);
    free(huge);
    fos_scene_store_change_t rest = {.staged = id};
    CHECK(fos_scene_store_apply(&rest, &result, NULL, NULL) == FOS_SCENE_STORE_OK && result.scene_count == 1);

    /* As many scenes as a set holds, each asked room for and paced as any
     * write; one more is refused. */
    fresh_dir();
    fos_scene_store_hooks_t hooks = {.make_room = track_room, .pace = count_pace};
    fos_scene_store_set_hooks(&hooks);
    s_writes = 0;
    s_paced = 0;
    id = fos_scene_store_stage_open();
    char text[48];
    for (int i = 0; i < FOS_SCENE_STORE_SCENES; i++) {
        snprintf(text, sizeof(text), "{\"id\":\"s%d\"}", i);
        CHECK(stage_scene(id, text, 100, &kept) == FOS_SCENE_STORE_OK);
    }
    CHECK(s_writes == FOS_SCENE_STORE_SCENES && s_paced == FOS_SCENE_STORE_SCENES);
    CHECK(fos_scene_store_stage_begin(id) == FOS_SCENE_STORE_ERR_NO_SLOTS);
    fos_scene_store_change_t full_set = {.staged = id};
    CHECK(fos_scene_store_apply(&full_set, &result, NULL, NULL) == FOS_SCENE_STORE_OK);
    CHECK(result.scene_count == FOS_SCENE_STORE_SCENES);
    /* The whole set again, every scene changed: it fits beside itself. */
    id = fos_scene_store_stage_open();
    for (int i = 0; i < FOS_SCENE_STORE_SCENES; i++) {
        snprintf(text, sizeof(text), "{\"id\":\"s%d\",\"v\":2}", i);
        CHECK(stage_scene(id, text, 100, &kept) == FOS_SCENE_STORE_OK && !kept);
    }
    fos_scene_store_change_t again = {.staged = id};
    CHECK(fos_scene_store_apply(&again, &result, NULL, NULL) == FOS_SCENE_STORE_OK);
    body = fos_scene_store_read_scene("s127", &len);
    CHECK(body != NULL && strcmp(body, "{\"id\":\"s127\",\"v\":2}") == 0);
    free(body);
    /* A long scene asks for its room as it grows, and is paced each 2 KB. */
    fos_scene_store_sweep();
    s_writes = 0;
    s_paced = 0;
    char *big = scene_text("big", 'b', 200 * 1024);
    id = fos_scene_store_stage_open();
    CHECK(stage_scene(id, big, 5000, &kept) == FOS_SCENE_STORE_OK);
    /* Room asked for each 64 KB ahead; 41 writes of up to 5000 bytes, three
     * 2 KB pieces each. */
    CHECK(s_writes == 4 && s_paced == 123);
    fos_scene_store_stage_drop(id);
    free(big);
    fos_scene_store_hooks_t none = {0};
    fos_scene_store_set_hooks(&none);

    for (int i = 0; i < 3; i++) cJSON_free(want[i]);
    cJSON_free(want_default);
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
    test_window_size_in_the_index();
    test_icon_in_the_index();
    test_category_in_the_index();
    test_replace_all();
    test_every_2_kb_written_is_paced();
    test_a_set_file_from_its_scenes();
    test_a_whole_set_one_scene_at_a_time();
    test_a_whole_set_at_once_where_there_is_room();
    test_a_set_staged_as_it_arrives();

    fresh_dir();
    rmdir(s_dir);
    printf("%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
