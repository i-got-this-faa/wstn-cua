.PHONY: all build native ts test clean install

all: build

build: native ts

native:
	$(MAKE) -C src/native

ts:
	bun run build:ts

test:
	bun test tests/

clean:
	$(MAKE) -C src/native clean
	rm -rf dist/

install:
	./install.sh
