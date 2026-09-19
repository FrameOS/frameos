# Host tests for the Pico firmware's portable modules: plain C, no pico-sdk,
# no hardware. `make -C embedded/pico/tests` builds and runs all of them
# under ASan + UBSan; CI runs the same (pull-request-tests.yml, pico-firmware).
#
# A module belongs here when it includes nothing from the SDK — keep it that
# way (the list below is FRAMEOS_PICO_PORTABLE_SOURCES in ../CMakeLists.txt).
#
# A toolchain without the sanitizer runtimes (some GCC builds): make SANITIZE=
CC ?= cc
SANITIZE ?= -fsanitize=address,undefined -fno-omit-frame-pointer
CFLAGS ?= -std=c11 -D_DEFAULT_SOURCE -O1 -g -Wall -Wextra -Werror -Wno-unused-parameter $(SANITIZE)
INCLUDES = -I../src -I../../esp32/main

PORTABLE = \
	../src/pk_args.c \
	../src/pk_bmp.c \
	../src/pk_config_keys.c \
	../src/pk_fosb.c \
	../src/pk_hotspot.c \
	../src/pk_http_response.c \
	../src/pk_httpd_parse.c \
	../src/pk_json.c \
	../src/pk_log.c \
	../src/pk_settings_parse.c \
	../src/pk_state.c \
	../src/pk_status_screen.c

TESTS = \
	test_pk_args \
	test_pk_bmp \
	test_pk_config_keys \
	test_pk_datetime \
	test_pk_fosb \
	test_pk_hotspot \
	test_pk_http_response \
	test_pk_httpd_parse \
	test_pk_json \
	test_pk_log \
	test_pk_settings_parse \
	test_pk_state \
	test_pk_status_screen

BUILD = build

.PHONY: all clean
all: $(TESTS:%=$(BUILD)/%.ok)

$(BUILD)/%: %.c pk_test.h $(PORTABLE) $(wildcard ../src/*.h)
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(INCLUDES) -o $@ $< $(PORTABLE)

$(BUILD)/%.ok: $(BUILD)/%
	./$<
	@touch $@

clean:
	rm -rf $(BUILD)
