#include "neo_mcu.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int g_failures = 0;

#define ASSERT_TRUE(cond, msg)                                                 \
    do {                                                                       \
        if (!(cond)) {                                                         \
            fprintf(stderr, "FAIL [%s:%d]: %s\n", __FILE__, __LINE__, (msg));  \
            g_failures++;                                                      \
        }                                                                      \
    } while (0)

#define ASSERT_EQ_INT(a, b, msg)                                               \
    do {                                                                       \
        long long _va = (long long)(a);                                        \
        long long _vb = (long long)(b);                                        \
        if (_va != _vb) {                                                      \
            fprintf(stderr, "FAIL [%s:%d]: %s (got %lld, expected %lld)\n",    \
                    __FILE__, __LINE__, (msg), _va, _vb);                      \
            g_failures++;                                                      \
        }                                                                      \
    } while (0)

static void to_hex(const uint8_t *in, size_t len, char *out) {
    static const char hex[] = "0123456789abcdef";
    for (size_t i = 0; i < len; i++) {
        out[i * 2U] = hex[(in[i] >> 4) & 0x0FU];
        out[i * 2U + 1U] = hex[in[i] & 0x0FU];
    }
    out[len * 2U] = '\0';
}

/* --- Test 1: NIST SHA-256 & RFC 4231 HMAC-SHA256 vectors --- */
static void test_nist_sha256_and_hmac(void) {
    uint8_t digest[32];
    char hex[65];

    neo_sha256("", 0U, digest);
    to_hex(digest, 32U, hex);
    ASSERT_TRUE(strcmp(hex, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") == 0,
                "SHA-256 empty string vector");

    neo_sha256("abc", 3U, digest);
    to_hex(digest, 32U, hex);
    ASSERT_TRUE(strcmp(hex, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") == 0,
                "SHA-256 'abc' vector");

    const char *v3 = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
    neo_sha256(v3, strlen(v3), digest);
    to_hex(digest, 32U, hex);
    ASSERT_TRUE(strcmp(hex, "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1") == 0,
                "SHA-256 448-bit 2-block vector");

    /* RFC 4231 Case 1 */
    uint8_t k1[20];
    memset(k1, 0x0BU, sizeof(k1));
    neo_hmac_sha256(k1, sizeof(k1), "Hi There", 8U, digest);
    to_hex(digest, 32U, hex);
    ASSERT_TRUE(strcmp(hex, "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7") == 0,
                "HMAC-SHA256 RFC 4231 Case 1");

    /* RFC 4231 Case 2 */
    neo_hmac_sha256("Jefe", 4U, "what do ya want for nothing?", 28U, digest);
    to_hex(digest, 32U, hex);
    ASSERT_TRUE(strcmp(hex, "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843") == 0,
                "HMAC-SHA256 RFC 4231 Case 2");

    /* RFC 4231 Case 3 */
    uint8_t k3[20];
    uint8_t d3[50];
    memset(k3, 0xAAU, sizeof(k3));
    memset(d3, 0xDDU, sizeof(d3));
    neo_hmac_sha256(k3, sizeof(k3), d3, sizeof(d3), digest);
    to_hex(digest, 32U, hex);
    ASSERT_TRUE(strcmp(hex, "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe") == 0,
                "HMAC-SHA256 RFC 4231 Case 3");

    /* Constant-time compare */
    uint8_t a[4] = { 1, 2, 3, 4 };
    uint8_t b[4] = { 1, 2, 3, 4 };
    uint8_t c[4] = { 1, 2, 3, 5 };
    ASSERT_EQ_INT(neo_ct_equal(a, b, 4U), 1, "ct_equal matching");
    ASSERT_EQ_INT(neo_ct_equal(a, c, 4U), 0, "ct_equal mismatch");
}

/* --- Test 2: CBOR roundtrip for RFC 8949 subset --- */
static void test_cbor_roundtrip(void) {
    uint8_t buf[512];
    neo_cbor_enc_t enc;
    neo_cbor_enc_init(&enc, buf, sizeof(buf));

    const uint8_t blob[4] = { 0xDE, 0xAD, 0xBE, 0xEF };
    neo_cbor_enc_map(&enc, 8U);
    neo_cbor_enc_tstr(&enc, "u64");
    neo_cbor_enc_uint(&enc, 0x0102030405060708ULL);
    neo_cbor_enc_tstr(&enc, "neg");
    neo_cbor_enc_int(&enc, -500);
    neo_cbor_enc_tstr(&enc, "b");
    neo_cbor_enc_bstr(&enc, blob, sizeof(blob));
    neo_cbor_enc_tstr(&enc, "s");
    neo_cbor_enc_tstr(&enc, "esp32s3");
    neo_cbor_enc_tstr(&enc, "arr");
    neo_cbor_enc_array(&enc, 2U);
    neo_cbor_enc_int(&enc, 42);
    neo_cbor_enc_tstr(&enc, "ok");
    neo_cbor_enc_tstr(&enc, "m");
    neo_cbor_enc_map(&enc, 1U);
    neo_cbor_enc_tstr(&enc, "duty");
    neo_cbor_enc_int(&enc, 85);
    neo_cbor_enc_tstr(&enc, "flag");
    neo_cbor_enc_bool(&enc, true);
    neo_cbor_enc_tstr(&enc, "nil");
    neo_cbor_enc_null(&enc);
    ASSERT_EQ_INT(enc.err, NEO_CBOR_OK, "CBOR encode error");

    neo_cbor_dec_t dec;
    neo_cbor_dec_init(&dec, buf, enc.len);
    size_t mlen = 0U;
    ASSERT_EQ_INT(neo_cbor_dec_map(&dec, &mlen), NEO_CBOR_OK, "decode map");
    ASSERT_EQ_INT((int)mlen, 8, "map len");

    const char *k = NULL;
    size_t klen = 0U;
    uint64_t u64 = 0U;
    ASSERT_EQ_INT(neo_cbor_dec_tstr(&dec, &k, &klen), NEO_CBOR_OK, "k u64");
    ASSERT_EQ_INT(neo_cbor_dec_uint(&dec, &u64), NEO_CBOR_OK, "v u64");
    ASSERT_TRUE(u64 == 0x0102030405060708ULL, "u64 roundtrip");

    int64_t neg = 0;
    ASSERT_EQ_INT(neo_cbor_dec_tstr(&dec, &k, &klen), NEO_CBOR_OK, "k neg");
    ASSERT_EQ_INT(neo_cbor_dec_int(&dec, &neg), NEO_CBOR_OK, "v neg");
    ASSERT_EQ_INT(neg, -500, "negint roundtrip");

    const uint8_t *bp = NULL;
    size_t blen = 0U;
    ASSERT_EQ_INT(neo_cbor_dec_tstr(&dec, &k, &klen), NEO_CBOR_OK, "k b");
    ASSERT_EQ_INT(neo_cbor_dec_bstr(&dec, &bp, &blen), NEO_CBOR_OK, "v b");
    ASSERT_EQ_INT((int)blen, 4, "bstr len");
    ASSERT_TRUE(memcmp(bp, blob, 4U) == 0, "bstr content");

    const char *sp = NULL;
    size_t slen = 0U;
    ASSERT_EQ_INT(neo_cbor_dec_tstr(&dec, &k, &klen), NEO_CBOR_OK, "k s");
    ASSERT_EQ_INT(neo_cbor_dec_tstr(&dec, &sp, &slen), NEO_CBOR_OK, "v s");
    ASSERT_TRUE(neo_cbor_tstr_eq(sp, slen, "esp32s3") == 1, "tstr content");

    size_t alen = 0U;
    int64_t a0 = 0;
    ASSERT_EQ_INT(neo_cbor_dec_tstr(&dec, &k, &klen), NEO_CBOR_OK, "k arr");
    ASSERT_EQ_INT(neo_cbor_dec_array(&dec, &alen), NEO_CBOR_OK, "v arr");
    ASSERT_EQ_INT((int)alen, 2, "arr len");
    ASSERT_EQ_INT(neo_cbor_dec_int(&dec, &a0), NEO_CBOR_OK, "a0");
    ASSERT_EQ_INT(a0, 42, "a0 val");
    ASSERT_EQ_INT(neo_cbor_dec_tstr(&dec, &sp, &slen), NEO_CBOR_OK, "a1");
    ASSERT_TRUE(neo_cbor_tstr_eq(sp, slen, "ok") == 1, "a1 val");

    /* Skip nested map */
    ASSERT_EQ_INT(neo_cbor_dec_tstr(&dec, &k, &klen), NEO_CBOR_OK, "k m");
    ASSERT_EQ_INT(neo_cbor_dec_skip(&dec), NEO_CBOR_OK, "skip nested map");

    bool bval = false;
    ASSERT_EQ_INT(neo_cbor_dec_tstr(&dec, &k, &klen), NEO_CBOR_OK, "k flag");
    ASSERT_EQ_INT(neo_cbor_dec_bool(&dec, &bval), NEO_CBOR_OK, "v flag");
    ASSERT_TRUE(bval == true, "bool roundtrip");

    ASSERT_EQ_INT(neo_cbor_dec_tstr(&dec, &k, &klen), NEO_CBOR_OK, "k nil");
    ASSERT_EQ_INT(neo_cbor_dec_null(&dec), NEO_CBOR_OK, "v nil");
    ASSERT_EQ_INT((int)dec.pos, (int)dec.len, "consumed all CBOR");

    /* Truncated CBOR rejected */
    neo_cbor_dec_init(&dec, buf, enc.len - 2U);
    ASSERT_EQ_INT(neo_cbor_dec_skip(&dec), NEO_CBOR_ERR_EOF, "truncated CBOR rejected");
}

/* --- Mock device fixture for MCU tests --- */
typedef struct {
    int fan_duty;
    int exec_calls;
} test_dev_t;

static int test_set_fan(void *ud, const neo_param_set_t *p, neo_param_set_t *out,
                        char *err, size_t err_cap) {
    (void)err;
    (void)err_cap;
    test_dev_t *d = (test_dev_t *)ud;
    const neo_kv_t *kv = neo_param_set_find(p, "duty");
    d->fan_duty = (int)kv->val.i;
    d->exec_calls++;
    neo_param_set_add_int(out, "duty", d->fan_duty);
    return 0;
}

static int test_read_dht(void *ud, const neo_param_set_t *p, neo_param_set_t *out,
                         char *err, size_t err_cap) {
    (void)p;
    (void)err;
    (void)err_cap;
    test_dev_t *d = (test_dev_t *)ud;
    d->exec_calls++;
    neo_param_set_add_int(out, "temp_c", 23);
    neo_param_set_add_int(out, "humidity", 45);
    return 0;
}

static const neo_param_spec_t TEST_FAN_PARAMS[] = {
    NEO_PARAM_INT("duty", 0, 100, true)
};

static const neo_action_def_t TEST_ACTIONS[] = {
    NEO_ACTION_ENTRY("set_fan_pwm", NEO_RISK_CONFIRM_REQUIRED,
                     TEST_FAN_PARAMS, NEO_ARRAY_LEN(TEST_FAN_PARAMS), test_set_fan),
    NEO_ACTION_ENTRY("read_dht22", NEO_RISK_SAFE_AUTO,
                     NULL, 0U, test_read_dht)
};

static size_t build_cmd_wire(const char *cluster_id,
                             const char *device_id,
                             const char *secret,
                             uint64_t seq_id,
                             const char *action,
                             bool has_duty,
                             int64_t duty,
                             uint8_t *out_wire,
                             size_t cap) {
    uint8_t cbor[256];
    neo_cbor_enc_t enc;
    neo_cbor_enc_init(&enc, cbor, sizeof(cbor));
    neo_cbor_enc_map(&enc, 3U);
    neo_cbor_enc_tstr(&enc, "t");
    neo_cbor_enc_tstr(&enc, "cmd");
    neo_cbor_enc_tstr(&enc, "a");
    neo_cbor_enc_tstr(&enc, action);
    neo_cbor_enc_tstr(&enc, "p");
    if (has_duty) {
        neo_cbor_enc_map(&enc, 1U);
        neo_cbor_enc_tstr(&enc, "duty");
        neo_cbor_enc_int(&enc, duty);
    } else {
        neo_cbor_enc_map(&enc, 0U);
    }

    uint8_t key[32];
    neo_mcu_derive_key(cluster_id, secret, key);
    neo_write_be64(out_wire, seq_id);
    neo_mcu_compute_mac(key, cluster_id, device_id, seq_id, cbor, enc.len, out_wire + 8U);
    memcpy(out_wire + 40U, cbor, enc.len);
    (void)cap;
    return 40U + enc.len;
}

static void decode_res_ok(const uint8_t *res_wire, size_t res_len,
                          const uint8_t key[32], const char *cluster, const char *dev,
                          bool *out_ok) {
    ASSERT_TRUE(res_len > 40U, "res frame length");
    uint64_t seq = neo_read_be64(res_wire);
    const uint8_t *mac = res_wire + 8U;
    const uint8_t *cbor = res_wire + 40U;
    size_t clen = res_len - 40U;
    ASSERT_EQ_INT(neo_mcu_verify_mac(key, cluster, dev, seq, cbor, clen, mac), 1,
                  "res e2e_mac verified");

    neo_cbor_dec_t dec;
    neo_cbor_dec_init(&dec, cbor, clen);
    size_t mlen = 0U;
    ASSERT_EQ_INT(neo_cbor_dec_map(&dec, &mlen), NEO_CBOR_OK, "res map");
    for (size_t i = 0; i < mlen; i++) {
        const char *k = NULL;
        size_t klen = 0U;
        neo_cbor_dec_tstr(&dec, &k, &klen);
        if (neo_cbor_tstr_eq(k, klen, "ok")) {
            neo_cbor_dec_bool(&dec, out_ok);
        } else {
            neo_cbor_dec_skip(&dec);
        }
    }
}

/* --- Test 3: MAC tamper, cross-cluster rejection, bounds, replay --- */
static void test_dispatcher_security_and_bounds(void) {
    test_dev_t dev = { .fan_duty = 0, .exec_calls = 0 };
    neo_mcu_ctx_t ctx;
    ASSERT_EQ_INT(neo_mcu_init(&ctx, "cluster-a", "mcu-esp32-rack01", "secret-a",
                               "esp32s3", "1.0.0", TEST_ACTIONS, NEO_ARRAY_LEN(TEST_ACTIONS), &dev),
                  NEO_MCU_OK, "mcu init");

    /* Verify hello packet */
    uint8_t hello[512];
    size_t hello_len = 0U;
    ASSERT_EQ_INT(neo_mcu_build_hello(&ctx, hello, sizeof(hello), &hello_len),
                  NEO_MCU_OK, "build hello");
    ASSERT_TRUE(hello_len > 40U, "hello len");
    ASSERT_EQ_INT(neo_mcu_verify_mac(ctx.mcu_key, "cluster-a", "mcu-esp32-rack01",
                                     neo_read_be64(hello), hello + 8U + 32U,
                                     hello_len - 40U, hello + 8U),
                  1, "hello MAC valid");

    uint8_t wire[512];
    uint8_t res[512];
    size_t res_len = 0U;

    /* Valid command */
    size_t wlen = build_cmd_wire("cluster-a", "mcu-esp32-rack01", "secret-a",
                                 10U, "set_fan_pwm", true, 75, wire, sizeof(wire));
    ASSERT_EQ_INT(neo_mcu_handle_downlink(&ctx, "cluster-a", "mcu-esp32-rack01",
                                          wire, wlen, res, sizeof(res), &res_len),
                  NEO_MCU_OK, "valid set_fan_pwm(75)");
    ASSERT_EQ_INT(dev.fan_duty, 75, "fan duty updated to 75");
    ASSERT_EQ_INT((int)neo_read_be64(res), 10, "res echoes downlink seq_id=10");
    bool res_ok = false;
    decode_res_ok(res, res_len, ctx.mcu_key, "cluster-a", "mcu-esp32-rack01", &res_ok);
    ASSERT_TRUE(res_ok == true, "res ok == true");

    /* Tamper MAC */
    wlen = build_cmd_wire("cluster-a", "mcu-esp32-rack01", "secret-a",
                          11U, "set_fan_pwm", true, 50, wire, sizeof(wire));
    wire[10] ^= 0x55U;
    ASSERT_EQ_INT(neo_mcu_handle_downlink(&ctx, "cluster-a", "mcu-esp32-rack01",
                                          wire, wlen, res, sizeof(res), &res_len),
                  NEO_MCU_ERR_MAC, "tampered MAC rejected");
    ASSERT_EQ_INT((int)res_len, 0, "no signed response on MAC error");
    ASSERT_EQ_INT(dev.fan_duty, 75, "fan duty unchanged on MAC tamper");

    /* Cross-cluster key / forged MAC */
    wlen = build_cmd_wire("cluster-b", "mcu-esp32-rack01", "secret-b",
                          11U, "set_fan_pwm", true, 10, wire, sizeof(wire));
    ASSERT_EQ_INT(neo_mcu_handle_downlink(&ctx, "cluster-a", "mcu-esp32-rack01",
                                          wire, wlen, res, sizeof(res), &res_len),
                  NEO_MCU_ERR_MAC, "cross-cluster MAC rejected");
    ASSERT_EQ_INT(dev.fan_duty, 75, "fan duty unchanged on cross-cluster forgery");

    /* Replay rejection (seq_id <= 10) */
    wlen = build_cmd_wire("cluster-a", "mcu-esp32-rack01", "secret-a",
                          10U, "set_fan_pwm", true, 20, wire, sizeof(wire));
    ASSERT_EQ_INT(neo_mcu_handle_downlink(&ctx, "cluster-a", "mcu-esp32-rack01",
                                          wire, wlen, res, sizeof(res), &res_len),
                  NEO_MCU_ERR_REPLAY, "replay seq_id==10 rejected");
    ASSERT_EQ_INT(dev.fan_duty, 75, "fan duty unchanged on replay");

    /* Parameter out-of-bounds: duty = 200 > 100 */
    wlen = build_cmd_wire("cluster-a", "mcu-esp32-rack01", "secret-a",
                          12U, "set_fan_pwm", true, 200, wire, sizeof(wire));
    ASSERT_EQ_INT(neo_mcu_handle_downlink(&ctx, "cluster-a", "mcu-esp32-rack01",
                                          wire, wlen, res, sizeof(res), &res_len),
                  NEO_MCU_ERR_BOUNDS, "bounds >100 rejected");
    decode_res_ok(res, res_len, ctx.mcu_key, "cluster-a", "mcu-esp32-rack01", &res_ok);
    ASSERT_TRUE(res_ok == false, "bounds rejection res ok==false");
    ASSERT_EQ_INT(dev.fan_duty, 75, "fan duty unchanged on out-of-bounds");

    /* Parameter out-of-bounds: duty = -1 < 0 */
    wlen = build_cmd_wire("cluster-a", "mcu-esp32-rack01", "secret-a",
                          13U, "set_fan_pwm", true, -1, wire, sizeof(wire));
    ASSERT_EQ_INT(neo_mcu_handle_downlink(&ctx, "cluster-a", "mcu-esp32-rack01",
                                          wire, wlen, res, sizeof(res), &res_len),
                  NEO_MCU_ERR_BOUNDS, "bounds <0 rejected");

    /* Unknown action */
    wlen = build_cmd_wire("cluster-a", "mcu-esp32-rack01", "secret-a",
                          14U, "self_destruct", false, 0, wire, sizeof(wire));
    ASSERT_EQ_INT(neo_mcu_handle_downlink(&ctx, "cluster-a", "mcu-esp32-rack01",
                                          wire, wlen, res, sizeof(res), &res_len),
                  NEO_MCU_ERR_UNKNOWN_ACTION, "unknown action rejected");
}

/* --- Test 4: Deep Sleep shadow wake-pull idempotency --- */
static void test_deep_sleep_shadow_idempotency(void) {
    test_dev_t dev = { .fan_duty = 0, .exec_calls = 0 };
    neo_mcu_ctx_t ctx;
    neo_mcu_init(&ctx, "cluster-a", "mcu-esp32-rack01", "secret-a",
                 "esp32s3", "1.0.0", TEST_ACTIONS, NEO_ARRAY_LEN(TEST_ACTIONS), &dev);

    neo_param_set_t p;
    neo_param_set_init(&p);
    neo_param_set_add_int(&p, "duty", 60);

    ASSERT_EQ_INT(neo_mcu_shadow_set_desired(&ctx, 100U, "set_fan_pwm", &p),
                  NEO_MCU_OK, "set desired seq=100");
    uint8_t res[512];
    size_t res_len = 0U;
    ASSERT_EQ_INT(neo_mcu_shadow_reconcile(&ctx, res, sizeof(res), &res_len),
                  NEO_MCU_OK, "first wake reconcile");
    ASSERT_EQ_INT(dev.fan_duty, 60, "duty applied on first wake");
    ASSERT_EQ_INT(dev.exec_calls, 1, "handler called once");
    ASSERT_TRUE(res_len > 40U, "wake reconcile produced signed res");

    /* Second wake with same seq=100: must be idempotent no-op */
    ASSERT_EQ_INT(neo_mcu_shadow_set_desired(&ctx, 100U, "set_fan_pwm", &p),
                  NEO_MCU_ERR_REPLAY, "duplicate desired seq rejected");
    ASSERT_EQ_INT(neo_mcu_shadow_reconcile(&ctx, res, sizeof(res), &res_len),
                  NEO_MCU_OK, "second wake reconcile");
    ASSERT_EQ_INT(dev.exec_calls, 1, "handler NOT re-executed on duplicate wake");
    ASSERT_EQ_INT((int)res_len, 0, "no redundant res emitted");

    /* Newer seq=101 reconciles */
    neo_param_set_init(&p);
    neo_param_set_add_int(&p, "duty", 90);
    ASSERT_EQ_INT(neo_mcu_shadow_set_desired(&ctx, 101U, "set_fan_pwm", &p),
                  NEO_MCU_OK, "set desired seq=101");
    ASSERT_EQ_INT(neo_mcu_shadow_reconcile(&ctx, res, sizeof(res), &res_len),
                  NEO_MCU_OK, "reconcile seq=101");
    ASSERT_EQ_INT(dev.fan_duty, 90, "duty updated to 90");
    ASSERT_EQ_INT(dev.exec_calls, 2, "handler executed for seq=101");
}

/* --- Test 5: COBS roundtrip, UART frame & CRC16-CCITT error detection --- */
static void test_cobs_and_uart_crc(void) {
    uint8_t raw[300];
    for (size_t i = 0; i < sizeof(raw); i++) {
        raw[i] = (uint8_t)((i % 37U == 0U) ? 0x00U : (i & 0xFFU));
    }
    uint8_t cobs[310];
    size_t cobs_len = 0U;
    ASSERT_EQ_INT(neo_cobs_encode(raw, sizeof(raw), cobs, sizeof(cobs), &cobs_len),
                  NEO_CRYPTO_OK, "COBS encode");
    for (size_t i = 0; i < cobs_len; i++) {
        ASSERT_TRUE(cobs[i] != 0x00U, "COBS output contains no zero byte");
    }

    uint8_t decoded[300];
    size_t dec_len = 0U;
    ASSERT_EQ_INT(neo_cobs_decode(cobs, cobs_len, decoded, sizeof(decoded), &dec_len),
                  NEO_CRYPTO_OK, "COBS decode");
    ASSERT_EQ_INT((int)dec_len, (int)sizeof(raw), "COBS decoded len");
    ASSERT_TRUE(memcmp(raw, decoded, sizeof(raw)) == 0, "COBS roundtrip match");

    /* UART frame roundtrip + CRC error detection */
    test_dev_t dev = { .fan_duty = 0, .exec_calls = 0 };
    neo_mcu_ctx_t ctx;
    neo_mcu_init(&ctx, "cluster-a", "mcu-esp32-rack01", "secret-a",
                 "esp32s3", "1.0.0", TEST_ACTIONS, NEO_ARRAY_LEN(TEST_ACTIONS), &dev);

    uint8_t wire[512];
    size_t wlen = build_cmd_wire("cluster-a", "mcu-esp32-rack01", "secret-a",
                                 1U, "read_dht22", false, 0, wire, sizeof(wire));
    uint8_t uart_tx[NEO_COBS_MAX_FRAME_SIZE];
    size_t uart_tx_len = 0U;
    ASSERT_EQ_INT(neo_uart_frame_encode("mcu-esp32-rack01",
                                        neo_read_be64(wire),
                                        wire + 8U,
                                        wire + 40U,
                                        wlen - 40U,
                                        uart_tx, sizeof(uart_tx), &uart_tx_len),
                  NEO_CRYPTO_OK, "UART frame encode");
    ASSERT_TRUE(uart_tx_len <= NEO_COBS_MAX_FRAME_SIZE, "UART frame <= 4096");
    ASSERT_EQ_INT(uart_tx[uart_tx_len - 1U], 0x00U, "UART frame ends with 0x00");

    /* Corrupt 1 byte inside COBS payload -> CRC16 error */
    uint8_t corrupted[NEO_COBS_MAX_FRAME_SIZE];
    memcpy(corrupted, uart_tx, uart_tx_len);
    corrupted[10] ^= 0x01U;
    char out_id[65];
    uint64_t out_seq = 0U;
    uint8_t out_mac[32];
    uint8_t out_cbor[512];
    size_t out_cbor_len = 0U;
    ASSERT_EQ_INT(neo_uart_frame_decode(corrupted, uart_tx_len,
                                        out_id, sizeof(out_id),
                                        &out_seq, out_mac,
                                        out_cbor, sizeof(out_cbor), &out_cbor_len),
                  NEO_CRYPTO_ERR_CRC, "corrupted UART frame detected by CRC16");

    /* Valid UART downlink dispatch */
    uint8_t uart_res[NEO_COBS_MAX_FRAME_SIZE];
    size_t uart_res_len = 0U;
    ASSERT_EQ_INT(neo_mcu_handle_uart_downlink(&ctx, uart_tx, uart_tx_len,
                                               uart_res, sizeof(uart_res), &uart_res_len),
                  NEO_MCU_OK, "UART downlink dispatch");
    ASSERT_TRUE(uart_res_len > 48U && uart_res_len <= NEO_COBS_MAX_FRAME_SIZE,
                "UART response frame valid");
}

/* --- Test 6: A/B OTA staging, boot_ok commit, and rollback --- */
static void test_ab_ota_state_machine(void) {
    neo_ota_state_t ota;
    ASSERT_EQ_INT(neo_mcu_ota_init(&ota, 0U, "1.0.0"), NEO_MCU_OK, "OTA init slot A");

    const uint8_t fw_img[64] = "NEO_FIRMWARE_V1_1_0_IMAGE_PAYLOAD_TEST_BYTES_0123456789ABCDEF";
    uint8_t fw_hash[32];
    neo_sha256(fw_img, sizeof(fw_img), fw_hash);

    /* Bad hash rejected */
    uint8_t bad_hash[32];
    memcpy(bad_hash, fw_hash, 32U);
    bad_hash[0] ^= 0xFFU;
    ASSERT_EQ_INT(neo_mcu_ota_begin(&ota, "1.1.0", sizeof(fw_img), bad_hash), NEO_MCU_OK, "OTA begin");
    ASSERT_EQ_INT(neo_mcu_ota_write(&ota, 0U, fw_img, sizeof(fw_img)), NEO_MCU_OK, "OTA write");
    ASSERT_EQ_INT(neo_mcu_ota_finalize(&ota), NEO_MCU_ERR_OTA_HASH, "OTA bad hash rejected");

    /* Valid staging -> activate -> rollback (unconfirmed boot) */
    ASSERT_EQ_INT(neo_mcu_ota_begin(&ota, "1.1.0", sizeof(fw_img), fw_hash), NEO_MCU_OK, "OTA begin valid");
    ASSERT_EQ_INT(neo_mcu_ota_write(&ota, 0U, fw_img, 32U), NEO_MCU_OK, "OTA chunk 1");
    ASSERT_EQ_INT(neo_mcu_ota_write(&ota, 32U, fw_img + 32U, 32U), NEO_MCU_OK, "OTA chunk 2");
    ASSERT_EQ_INT(neo_mcu_ota_finalize(&ota), NEO_MCU_OK, "OTA finalize valid");
    ASSERT_EQ_INT(neo_mcu_ota_activate(&ota), NEO_MCU_OK, "OTA activate slot B");
    ASSERT_EQ_INT(ota.active_slot, 1, "active slot switched to B");
    ASSERT_TRUE(ota.rollback_pending == true, "rollback_pending true before boot_ok");

    ASSERT_EQ_INT(neo_mcu_ota_rollback(&ota), NEO_MCU_OK, "OTA rollback triggered");
    ASSERT_EQ_INT(ota.active_slot, 0, "rolled back to slot A");
    ASSERT_TRUE(strcmp(ota.active_fw, "1.0.0") == 0, "rolled back fw 1.0.0");
    ASSERT_TRUE(ota.rollback_pending == false, "rollback flag cleared after rollback");

    /* Valid staging -> activate -> boot_ok clears rollback flag */
    ASSERT_EQ_INT(neo_mcu_ota_begin(&ota, "1.2.0", sizeof(fw_img), fw_hash), NEO_MCU_OK, "OTA begin 1.2.0");
    ASSERT_EQ_INT(neo_mcu_ota_write(&ota, 0U, fw_img, sizeof(fw_img)), NEO_MCU_OK, "OTA write 1.2.0");
    ASSERT_EQ_INT(neo_mcu_ota_finalize(&ota), NEO_MCU_OK, "OTA finalize 1.2.0");
    ASSERT_EQ_INT(neo_mcu_ota_activate(&ota), NEO_MCU_OK, "OTA activate 1.2.0");
    ASSERT_EQ_INT(neo_mcu_ota_boot_ok(&ota), NEO_MCU_OK, "OTA boot_ok");
    ASSERT_TRUE(ota.rollback_pending == false, "boot_ok clears rollback_pending");
    ASSERT_EQ_INT(ota.phase, NEO_OTA_COMMITTED, "OTA phase COMMITTED");
    ASSERT_EQ_INT(neo_mcu_ota_rollback(&ota), NEO_MCU_OK, "rollback after boot_ok is no-op");
    ASSERT_EQ_INT(ota.active_slot, 1, "active slot remains B after boot_ok");
}

int main(void) {
    test_nist_sha256_and_hmac();
    test_cbor_roundtrip();
    test_dispatcher_security_and_bounds();
    test_deep_sleep_shadow_idempotency();
    test_cobs_and_uart_crc();
    test_ab_ota_state_machine();

    if (g_failures > 0) {
        fprintf(stderr, "FAILED: %d assertions failed\n", g_failures);
        return 1;
    }
    printf("ALL TESTS PASSED (6 test suites)\n");
    return 0;
}
