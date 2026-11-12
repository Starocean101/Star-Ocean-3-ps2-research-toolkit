# Star Ocean Utility Tool - build with the OpenOrbis toolchain.
#   export OO_PS4_TOOLCHAIN=/path/to/OpenOrbis
#   make DEPS=/path/to/prefix-with-libarchive-liblzma-zlib

TITLE       := Star Ocean Utility Tool
VERSION     := 01.37

# v1.36 GPU experiment: sign as a system executable so the process carries a system-level
# program authentication id. On GoldHEN the fake-self handler copies PAID from here but fills
# the rest of the auth_info from its own template, so PAID + PTYPE are the only levers that
# actually reach the kernel. 0x3800000000000011 = normal fake; 0x3100000000000002 = system.
PAID        ?= 0x3800000000000011
PTYPE       ?= fake
TITLE_ID    := CUSA99901
CONTENT_ID  := UP0001-CUSA99901_00-STAROCEANUTILITY

TOOLCHAIN   ?= $(OO_PS4_TOOLCHAIN)
DEPS        ?= $(CURDIR)/deps
INTDIR      := build

LIBS        := -larchive -llzma -lz -lc -lkernel -lScePad -lSceUserService \
               -lSceVideoOut -lSceSystemService -lSceAudioOut -lSceRtc -lSceImeDialog -lSceCommonDialog -lSceSysmodule -lpthread

CFLAGS      := --target=x86_64-pc-freebsd12-elf -fPIC -funwind-tables -O2 -Wall \
               -isysroot $(TOOLCHAIN) -isystem $(TOOLCHAIN)/include -I$(DEPS)/include -D__PS4__
LDFLAGS     := -m elf_x86_64 -pie --script $(TOOLCHAIN)/link.x --eh-frame-hdr \
               -L$(DEPS)/lib -L$(TOOLCHAIN)/lib $(LIBS) $(TOOLCHAIN)/lib/crt1.o

UNAME_S     := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
CC          := /usr/local/opt/llvm/bin/clang
LD          := /usr/local/opt/llvm/bin/ld.lld
CDIR        := macos
else
CC          := clang
LD          := ld.lld
CDIR        := linux
endif

SRCS        := $(wildcard src/*.c)
OBJS        := $(patsubst src/%.c,$(INTDIR)/%.o,$(SRCS))
ASSETS      := assets/bg.bin assets/music.pcm
PKGFILES    := eboot.bin sce_sys/param.sfo sce_sys/icon0.png sce_sys/about/right.sprx \
               sce_module/libc.prx sce_module/libSceFios2.prx $(ASSETS)

all: eboot.bin sce_sys/param.sfo pkg.gp4

$(INTDIR)/%.o: src/%.c src/*.h
	@mkdir -p $(INTDIR)
	$(CC) $(CFLAGS) -c -o $@ $<

eboot.bin: $(OBJS)
	$(LD) $(OBJS) -o $(INTDIR)/soutil.elf $(LDFLAGS)
	$(TOOLCHAIN)/bin/$(CDIR)/create-fself -in=$(INTDIR)/soutil.elf -out=$(INTDIR)/soutil.oelf --eboot eboot.bin --paid $(PAID) --ptype $(PTYPE)

sce_sys/param.sfo: Makefile tools/make_sfo.py
	python3 tools/make_sfo.py $@ --title "$(TITLE)" --title-id $(TITLE_ID) --content-id $(CONTENT_ID) --version $(VERSION)

pkg.gp4: $(PKGFILES)
	$(TOOLCHAIN)/bin/$(CDIR)/create-gp4 -out $@ --content-id=$(CONTENT_ID) --files "$(PKGFILES)"

pkg: pkg.gp4
	$(TOOLCHAIN)/bin/$(CDIR)/PkgTool.Core pkg_build $< .

clean:
	rm -rf $(INTDIR) eboot.bin pkg.gp4 sce_sys/param.sfo *.pkg

.PHONY: all pkg clean
