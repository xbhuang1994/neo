CC      := gcc
AR      := ar
SIZE    := size
NM      := nm

CFLAGS  := -std=c99 -Wall -Wextra -Werror -Os -Iinclude
LDFLAGS :=

BUILD_DIR := build
LIB       := libneo_mcu.a

LIB_SRCS := src/neo_crypto.c src/neo_cbor.c src/neo_mcu.c
LIB_OBJS := $(patsubst src/%.c,$(BUILD_DIR)/%.o,$(LIB_SRCS))

TEST_BIN := $(BUILD_DIR)/test_neo_mcu
SIM_BIN  := $(BUILD_DIR)/esp32_rack01_sim

.PHONY: all test sim size-check clean

all: $(LIB) $(TEST_BIN) $(SIM_BIN)

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

$(BUILD_DIR)/%.o: src/%.c include/neo_mcu.h include/neo_cbor.h include/neo_crypto.h | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(LIB): $(LIB_OBJS)
	$(AR) rcs $@ $^

$(TEST_BIN): tests/test_neo_mcu.c $(LIB) | $(BUILD_DIR)
	$(CC) $(CFLAGS) $< $(LIB) -o $@ $(LDFLAGS)

$(SIM_BIN): examples/esp32_rack01_sim.c $(LIB) | $(BUILD_DIR)
	$(CC) $(CFLAGS) $< $(LIB) -o $@ $(LDFLAGS)

sim: $(SIM_BIN)

test: $(TEST_BIN)
	./$(TEST_BIN)

size-check: $(LIB)
	@echo "=== size $(LIB) ==="
	@$(SIZE) $(LIB)
	@$(SIZE) $(LIB) | awk 'NR>1 { flash += $$1; ram += $$2 + $$3 } END { \
		printf "Total Flash (text+rodata): %d bytes (limit 40960)\n", flash; \
		printf "Total RAM   (data+bss):    %d bytes (limit 16384)\n", ram; \
		if (flash >= 40960) { print "ERROR: Flash footprint >= 40960" > "/dev/stderr"; exit 1 } \
		if (ram >= 16384)   { print "ERROR: RAM footprint >= 16384" > "/dev/stderr"; exit 1 } \
	}'
	@echo "=== nm -u $(LIB) ==="
	@$(NM) -u $(LIB)
	@if $(NM) -u $(LIB) | grep -qwE 'malloc|calloc|realloc|free'; then \
		echo "ERROR: heap allocation symbols detected in $(LIB)" >&2; \
		exit 1; \
	fi
	@echo "Zero heap allocation symbols verified."

clean:
	rm -rf $(BUILD_DIR) $(LIB)
