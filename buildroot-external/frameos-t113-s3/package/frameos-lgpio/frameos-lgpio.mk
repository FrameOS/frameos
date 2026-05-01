################################################################################
#
# frameos-lgpio
#
################################################################################

FRAMEOS_LGPIO_VERSION = v0.2.2
FRAMEOS_LGPIO_SITE = https://github.com/joan2937/lg.git
FRAMEOS_LGPIO_SITE_METHOD = git
FRAMEOS_LGPIO_LICENSE = Unlicense
FRAMEOS_LGPIO_LICENSE_FILES = UNLICENCE
FRAMEOS_LGPIO_INSTALL_STAGING = YES

FRAMEOS_LGPIO_LGPIO_OBJS = \
	lgCtx.o \
	lgDbg.o \
	lgErr.o \
	lgGpio.o \
	lgHdl.o \
	lgI2C.o \
	lgNotify.o \
	lgPthAlerts.o \
	lgPthTx.o \
	lgSerial.o \
	lgSPI.o \
	lgThread.o \
	lgUtil.o

FRAMEOS_LGPIO_RGPIO_OBJS = \
	rgpio.o \
	lgCfg.o \
	lgErr.o \
	lgDbg.o \
	lgMD5.o

define FRAMEOS_LGPIO_BUILD_CMDS
	$(TARGET_MAKE_ENV) $(MAKE) -C $(@D) \
		CROSS_PREFIX="$(TARGET_CROSS)" \
		prefix=/usr \
		lib
	cd $(@D) && $(TARGET_AR) rcs liblgpio.a $(FRAMEOS_LGPIO_LGPIO_OBJS)
	cd $(@D) && $(TARGET_AR) rcs librgpio.a $(FRAMEOS_LGPIO_RGPIO_OBJS)
endef

define FRAMEOS_LGPIO_INSTALL_STAGING_CMDS
	$(INSTALL) -D -m 0644 $(@D)/lgpio.h $(STAGING_DIR)/usr/include/lgpio.h
	$(INSTALL) -D -m 0644 $(@D)/rgpio.h $(STAGING_DIR)/usr/include/rgpio.h
	$(INSTALL) -D -m 0644 $(@D)/liblgpio.a $(STAGING_DIR)/usr/lib/liblgpio.a
	$(INSTALL) -D -m 0644 $(@D)/librgpio.a $(STAGING_DIR)/usr/lib/librgpio.a
	$(INSTALL) -D -m 0755 $(@D)/liblgpio.so.1 $(STAGING_DIR)/usr/lib/liblgpio.so.1
	$(INSTALL) -D -m 0755 $(@D)/librgpio.so.1 $(STAGING_DIR)/usr/lib/librgpio.so.1
	ln -sf liblgpio.so.1 $(STAGING_DIR)/usr/lib/liblgpio.so
	ln -sf librgpio.so.1 $(STAGING_DIR)/usr/lib/librgpio.so
endef

define FRAMEOS_LGPIO_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0755 $(@D)/liblgpio.so.1 $(TARGET_DIR)/usr/lib/liblgpio.so.1
	$(INSTALL) -D -m 0755 $(@D)/librgpio.so.1 $(TARGET_DIR)/usr/lib/librgpio.so.1
	ln -sf liblgpio.so.1 $(TARGET_DIR)/usr/lib/liblgpio.so
	ln -sf librgpio.so.1 $(TARGET_DIR)/usr/lib/librgpio.so
endef

$(eval $(generic-package))
