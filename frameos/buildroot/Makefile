# FrameOS Buildroot helper Makefile
#
# This Makefile automates fetching Buildroot and building images using the
# FrameOS external tree.  It is intentionally light-weight so it can be used
# from a clean checkout without additional tooling.

BUILDROOT_VERSION ?= 2024.02.2
BUILDROOT_SITE ?= https://buildroot.org/downloads
BUILDROOT_ARCHIVE ?= buildroot-$(BUILDROOT_VERSION).tar.xz

ARCHIVE_DL_DIR ?= $(CURDIR)/dl
BUILDROOT_SRC_DIR ?= $(CURDIR)/sources
BUILDROOT_DIR ?= $(BUILDROOT_SRC_DIR)/buildroot-$(BUILDROOT_VERSION)
OUTPUT_DIR ?= $(CURDIR)/output
BR2_EXTERNAL ?= $(CURDIR)/external
BR2_DL_DIR ?= $(CURDIR)/dl/br2
TARGET ?= frameos_luckfox_rv1106

BUILDROOT_ARCHIVE_PATH := $(ARCHIVE_DL_DIR)/$(BUILDROOT_ARCHIVE)

BUILDROOT_MAKE = BR2_DL_DIR=$(BR2_DL_DIR) $(MAKE) -C $(BUILDROOT_DIR) \
	BR2_EXTERNAL=$(BR2_EXTERNAL) O=$(OUTPUT_DIR)

.PHONY: help download extract $(TARGET)_defconfig menuconfig build toolchain sdk \
	legal-info clean distclean printvars

help:
	@echo "FrameOS Buildroot helper"
	@echo "Available targets:"
	@echo "  make download        - download the Buildroot release archive"
	@echo "  make extract         - extract the Buildroot release"
	@echo "  make $(TARGET)_defconfig - configure Buildroot for the Luckfox RV1106"
	@echo "  make build           - build the full image"
	@echo "  make toolchain       - build only the cross-toolchain"
	@echo "  make sdk             - generate the Buildroot SDK"
	@echo "  make menuconfig      - open Buildroot menuconfig"
	@echo "  make legal-info      - gather licensing information"
	@echo "  make clean           - clean the Buildroot output directory"
	@echo "  make distclean       - remove output and extracted sources"
	@echo "Variables may be overridden, e.g. 'make BUILDROOT_VERSION=2023.11 build'"

printvars:
	@echo "BUILDROOT_VERSION=$(BUILDROOT_VERSION)"
	@echo "BUILDROOT_DIR=$(BUILDROOT_DIR)"
	@echo "OUTPUT_DIR=$(OUTPUT_DIR)"
	@echo "BR2_EXTERNAL=$(BR2_EXTERNAL)"
	@echo "BR2_DL_DIR=$(BR2_DL_DIR)"
	@echo "TARGET=$(TARGET)"

$(BUILDROOT_ARCHIVE_PATH):
	@mkdir -p $(ARCHIVE_DL_DIR)
	@if [ ! -f "$(BUILDROOT_ARCHIVE_PATH)" ]; then \
		echo "Downloading $(BUILDROOT_ARCHIVE)..."; \
		curl -fL "$(BUILDROOT_SITE)/$(BUILDROOT_ARCHIVE)" -o "$(BUILDROOT_ARCHIVE_PATH)"; \
	fi

download: $(BUILDROOT_ARCHIVE_PATH)

extract: download
	@mkdir -p $(BUILDROOT_SRC_DIR)
	@if [ ! -d "$(BUILDROOT_DIR)" ]; then \
		echo "Extracting $(BUILDROOT_ARCHIVE)"; \
		tar -xf "$(BUILDROOT_ARCHIVE_PATH)" -C "$(BUILDROOT_SRC_DIR)"; \
	fi

$(TARGET)_defconfig: extract
	@$(BUILDROOT_MAKE) $(TARGET)_defconfig

menuconfig: $(TARGET)_defconfig
	@$(BUILDROOT_MAKE) menuconfig

build: $(TARGET)_defconfig
	@$(BUILDROOT_MAKE)

toolchain: $(TARGET)_defconfig
	@$(BUILDROOT_MAKE) toolchain

sdk: $(TARGET)_defconfig
	@$(BUILDROOT_MAKE) sdk

legal-info: $(TARGET)_defconfig
	@$(BUILDROOT_MAKE) legal-info

clean:
	@if [ -d "$(BUILDROOT_DIR)" ]; then \
		$(BUILDROOT_MAKE) clean; \
	fi

# The Buildroot sources are intentionally left in place so the download cache
# can be re-used.  Remove BUILDROOT_SRC_DIR manually if a pristine tree is
# required.
distclean: clean
	@rm -rf "$(OUTPUT_DIR)"
