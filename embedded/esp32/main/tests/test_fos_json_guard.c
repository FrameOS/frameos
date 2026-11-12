/* Host test for fos_json_guard.c — no IDF, plain C. Built and run by
 * e2e-docker.yml next to the contract walker. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "fos_json_guard.h"

static int failures = 0;

static void check(bool got, bool want, const char *what)
{
    if (got != want) {
        printf("FAIL %s: got %s\n", what, got ? "true" : "false");
        failures++;
    } else {
        printf("ok   %s\n", what);
    }
}

int main(void)
{
    check(fos_json_depth_ok("{\"a\":[1,2,{\"b\":[]}]}", 21, 32), true, "ordinary payload passes");
    check(fos_json_depth_ok(NULL, 0, 32), true, "NULL is nothing to overflow on");
    check(fos_json_depth_ok("[[[[", 4, 3), false, "four deep against a cap of three");
    check(fos_json_depth_ok("[[[]]]", 6, 3), true, "exactly the cap passes");
    check(fos_json_depth_ok("\"[[[[[[[[[[\"", 12, 3), true, "brackets inside a string do not nest");
    check(fos_json_depth_ok("\"\\\"[[[[\"", 9, 2), true, "an escaped quote does not end the string");
    check(fos_json_depth_ok("]]]]]]]]{", 9, 1), true, "stray closers never go negative");

    char *bomb = malloc(2001);
    memset(bomb, '[', 2000);
    bomb[2000] = '\0';
    check(fos_json_depth_ok(bomb, 2000, FOS_JSON_MAX_DEPTH), false, "a 2000-bracket bomb is refused");
    free(bomb);

    /* fos_json_whole: one whole array or object, white space aside. */
    check(fos_json_whole("[{\"id\":\"a\"}]", strlen("[{\"id\":\"a\"}]")), true, "an array of scenes is whole");
    check(fos_json_whole(" \n{\"scenes\":[]}\r\n", strlen(" \n{\"scenes\":[]}\r\n")), true, "an object, space around it, is whole");
    /* What a "\r\n"-ended upload command stored (2026-11-08): the LF in
     * front, the last byte left on the wire. */
    check(fos_json_whole("\n{\"scenes\":[{}],\"sceneId\":\"jsx-counter\"", strlen("\n{\"scenes\":[{}],\"sceneId\":\"jsx-counter\"")), false,
          "an object without its closing brace is not");
    check(fos_json_whole("\n[{\"id\":\"a\"}", strlen("\n[{\"id\":\"a\"}")), false, "an array without its closing bracket is not");
    check(fos_json_whole("[{}}", strlen("[{}}")), false, "a bracket closed by a brace is not");
    check(fos_json_whole("  ", strlen("  ")), false, "space alone is not");
    check(fos_json_whole(NULL, 0), false, "NULL is not");

    if (failures) {
        printf("%d failure(s)\n", failures);
        return 1;
    }
    printf("all fos_json_guard checks passed\n");
    return 0;
}
