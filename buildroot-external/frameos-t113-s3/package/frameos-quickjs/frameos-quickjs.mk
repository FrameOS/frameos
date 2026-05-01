################################################################################
#
# frameos-quickjs
#
################################################################################

FRAMEOS_QUICKJS_VERSION = 2025-04-26
FRAMEOS_QUICKJS_SOURCE = quickjs-$(FRAMEOS_QUICKJS_VERSION).tar.xz
FRAMEOS_QUICKJS_SITE = https://bellard.org/quickjs
FRAMEOS_QUICKJS_LICENSE = MIT
FRAMEOS_QUICKJS_LICENSE_FILES = LICENSE
FRAMEOS_QUICKJS_INSTALL_STAGING = YES
FRAMEOS_QUICKJS_INSTALL_TARGET = NO

define FRAMEOS_QUICKJS_BUILD_CMDS
	$(TARGET_MAKE_ENV) $(MAKE) -C $(@D) \
		CROSS_PREFIX="$(TARGET_CROSS)" \
		libquickjs.a
endef

define FRAMEOS_QUICKJS_INSTALL_STAGING_CMDS
	$(INSTALL) -D -m 0644 $(@D)/libquickjs.a $(STAGING_DIR)/usr/lib/libquickjs.a
	$(INSTALL) -D -m 0644 $(@D)/quickjs.h $(STAGING_DIR)/usr/include/quickjs/quickjs.h
	$(INSTALL) -D -m 0644 $(@D)/quickjs-libc.h $(STAGING_DIR)/usr/include/quickjs/quickjs-libc.h
endef

$(eval $(generic-package))
