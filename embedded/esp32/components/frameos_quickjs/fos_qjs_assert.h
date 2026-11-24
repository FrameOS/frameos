// QuickJS's assert, for quickjs_hot.c alone: the copy step in CMakeLists.txt
// includes this after quickjs.c's own headers.
//
// Under CONFIG_COMPILER_OPTIMIZATION_ASSERTIONS_SILENT a failed assert is
// newlib's __assert_func(NULL, 0, NULL, NULL), which prints "assert failed:
// 0x<address of the call>" and aborts (ESP-IDF's components/newlib/src/
// assert.c): four null arguments set up at each of quickjs.c's assert sites.
// This prints the same line from the same place and aborts the same way, from
// a call that takes none (-624 B on the S3).
#pragma once

#include "sdkconfig.h"

#if CONFIG_COMPILER_OPTIMIZATION_ASSERTIONS_SILENT && !defined(NDEBUG)
#include <stdint.h>
#include <stdlib.h>
#include "esp_system.h"

#if __XTENSA__
#define FOS_QJS_ASSERT_INST_LEN 3
#else
#define FOS_QJS_ASSERT_INST_LEN 4
#endif

static __attribute__((noreturn, noinline)) void fos_qjs_assert_failed(void)
{
    char buff[sizeof("assert failed: ") + 11 + 1] = "assert failed: ";
    char *addr = &buff[sizeof("assert failed: ") - 1];
    addr[0] = '0';
    addr[1] = 'x';
    itoa((uint32_t)(__builtin_return_address(0) - FOS_QJS_ASSERT_INST_LEN), addr + 2, 16);
    esp_system_abort(buff);
}

#undef assert
#define assert(e) (__builtin_expect(!!(e), 1) ? (void)0 : fos_qjs_assert_failed())
#endif
