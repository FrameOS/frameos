/*
 * NVS's new[] (std::nothrow) and delete[] without libstdc++'s exception
 * runtime.
 *
 * Two NVS sources (nvs_page.cpp, nvs_encrypted_partition.cpp) allocate
 * arrays with new (std::nothrow) and free them with delete[]. libstdc++'s
 * nothrow new[] is a try/catch around the throwing operator new, so it
 * linked the exception runtime, std::bad_alloc and the type_info classes
 * (libstdc++ 1.5 KB) for a catch that never runs: IDF builds without C++
 * exceptions, and its stub for __cxa_allocate_exception aborts. On this
 * firmware libstdc++'s pair comes to this: malloc of at least one byte,
 * abort() when that fails (nothing installs a new-handler), and free.
 *
 * C with the Itanium names (size_t is unsigned int, "j", on both chips);
 * "-u" in main/CMakeLists.txt links this object before libstdc++ is
 * searched.
 */
#include <stdlib.h>

void *_ZnajRKSt9nothrow_t(size_t size, const void *nothrow);
void _ZdaPv(void *block);

void *_ZnajRKSt9nothrow_t(size_t size, const void *nothrow)
{
    (void)nothrow;
    void *block = malloc(size ? size : 1);
    if (block == NULL) abort();
    return block;
}

void _ZdaPv(void *block)
{
    free(block);
}
