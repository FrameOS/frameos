// The whole test framework: CHECK counts, the test's main() returns
// pk_test_result(). A failure prints file:line and the expression and keeps
// going, so one run shows every broken expectation.
#ifndef PK_TEST_H
#define PK_TEST_H

#include <stdio.h>
#include <string.h>

static int pk_test_checks = 0;
static int pk_test_failures = 0;

#define CHECK(expr)                                                        \
    do {                                                                   \
        pk_test_checks++;                                                  \
        if (!(expr)) {                                                     \
            pk_test_failures++;                                            \
            fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #expr); \
        }                                                                  \
    } while (0)

#define CHECK_STR(actual, expected)                                        \
    do {                                                                   \
        pk_test_checks++;                                                  \
        const char *pk_a = (actual);                                       \
        const char *pk_e = (expected);                                     \
        if (strcmp(pk_a, pk_e) != 0) {                                     \
            pk_test_failures++;                                            \
            fprintf(stderr, "%s:%d: expected \"%s\", got \"%s\"\n", __FILE__, __LINE__, pk_e, pk_a); \
        }                                                                  \
    } while (0)

static inline int pk_test_result(const char *name)
{
    if (pk_test_failures) {
        fprintf(stderr, "%s: %d of %d checks FAILED\n", name, pk_test_failures, pk_test_checks);
        return 1;
    }
    printf("%s: %d checks ok\n", name, pk_test_checks);
    return 0;
}

#endif // PK_TEST_H
