CC ?= gcc

# Some desktop sessions (AppImage wrappers, launcher shims) export LD_LIBRARY_PATH.
# The linker would then resolve host libraries instead of the toolchain's, which
# breaks on glibc version mismatches, so build without it.
ENV_CLEAN := env -u LD_LIBRARY_PATH

# Match the libweston API to the weston binary that will load the module, so the
# plugin cannot be built against a different major version than it runs on.
WESTON_MAJOR := $(shell weston --version 2>/dev/null | awk '/^weston /{print $$2}' | cut -d. -f1)
ifeq ($(WESTON_MAJOR),)
WESTON_MAJOR := $(shell for v in 16 15; do pkg-config --exists libweston-$$v 2>/dev/null && { echo $$v; break; }; done)
endif
ifeq ($(WESTON_MAJOR),)
WESTON_MAJOR := 15
endif

WESTON_PC := libweston-$(WESTON_MAJOR)

INJECTOR_DEPS := wayland-server $(WESTON_PC)
CAPTURE_DEPS := libpipewire-0.3
TURBOJPEG_LIBS := $(shell pkg-config --libs libturbojpeg 2>/dev/null || echo -lturbojpeg)

INJECTOR_CFLAGS = -O3 -fPIC -Wall -Wextra -DWSTN_LIBWESTON_MAJOR=$(WESTON_MAJOR) \
	-I$(shell pkg-config --variable=includedir $(WESTON_PC) 2>/dev/null) \
	$(shell pkg-config --cflags $(INJECTOR_DEPS) 2>/dev/null)
INJECTOR_LIBS = $(shell pkg-config --libs $(INJECTOR_DEPS) 2>/dev/null)

CAPTURE_CFLAGS = -O3 -fPIC -Wall -Wextra $(shell pkg-config --cflags $(CAPTURE_DEPS) 2>/dev/null)
CAPTURE_LIBS = $(shell pkg-config --libs $(CAPTURE_DEPS) 2>/dev/null) $(TURBOJPEG_LIBS)

TARGETS = libwstn_injector.so pw_stream

# Make compares mtimes, not flags, so a weston upgrade would otherwise leave a
# module built against the old libweston. The stamp only changes when the major
# version changes, which forces the injector to relink.
VERSION_STAMP = .libweston-major

all: check-deps $(TARGETS)

check-deps:
	@command -v pkg-config >/dev/null 2>&1 || { \
		echo "Error: pkg-config not found. Install it (e.g. apt-get install pkg-config, pacman -S pkgconf)."; exit 1; }
	@pkg-config --exists $(INJECTOR_DEPS) 2>/dev/null || { \
		echo "Error: missing development packages: $(INJECTOR_DEPS)"; \
		echo "  Debian/Ubuntu: sudo apt-get install libweston-$(WESTON_MAJOR)-dev libwayland-dev"; \
		echo "  Arch:          sudo pacman -S weston"; \
		echo "  NixOS:         nix develop   (this repository provides a dev shell)"; exit 1; }
	@pkg-config --exists $(CAPTURE_DEPS) 2>/dev/null || { \
		echo "Error: missing development packages: $(CAPTURE_DEPS)"; \
		echo "  Debian/Ubuntu: sudo apt-get install libpipewire-0.3-dev"; \
		echo "  Arch:          sudo pacman -S pipewire"; \
		echo "  NixOS:         nix develop   (this repository provides a dev shell)"; exit 1; }

$(VERSION_STAMP): FORCE
	@echo '$(WESTON_MAJOR)' | cmp -s - $@ || echo '$(WESTON_MAJOR)' > $@

libwstn_injector.so: injector.c $(VERSION_STAMP)
	$(ENV_CLEAN) $(CC) $(INJECTOR_CFLAGS) -shared -o $@ $< $(INJECTOR_LIBS)

pw_stream: pw_stream.c
	$(ENV_CLEAN) $(CC) $(CAPTURE_CFLAGS) -o $@ $< $(CAPTURE_LIBS)

clean:
	rm -f $(TARGETS) *.o $(VERSION_STAMP)

FORCE:

.PHONY: all clean check-deps
