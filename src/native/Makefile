CC ?= gcc
CFLAGS = -O3 -fPIC -Wall -Wextra $(shell pkg-config --cflags wayland-server libweston-15 libpipewire-0.3)
LDFLAGS = $(shell pkg-config --libs wayland-server libweston-15 libpipewire-0.3) -lturbojpeg

TARGETS = libwstn_injector.so pw_stream

all: $(TARGETS)

libwstn_injector.so: injector.c
	$(CC) $(CFLAGS) -shared -o $@ $< $(LDFLAGS)

pw_stream: pw_stream.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)

clean:
	rm -f $(TARGETS) *.o

.PHONY: all clean
