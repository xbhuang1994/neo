#ifndef NEO_CRYPTO_H
#define NEO_CRYPTO_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define NEO_SHA256_DIGEST_SIZE 32
#define NEO_SHA256_BLOCK_SIZE  64
#define NEO_HMAC_SHA256_SIZE   32

#define NEO_COBS_MAX_FRAME_SIZE 4096U
#define NEO_UART_MAGIC_0        0xA5U
#define NEO_UART_VERSION        0x01U
#define NEO_UART_MAX_ID_LEN     64U

#define NEO_CRYPTO_OK           0
#define NEO_CRYPTO_ERR_INVALID -1
#define NEO_CRYPTO_ERR_OVERFLOW -2
#define NEO_CRYPTO_ERR_FORMAT  -3
#define NEO_CRYPTO_ERR_CRC     -4

typedef struct {
    uint32_t state[8];
    uint64_t count;
    uint8_t buf[NEO_SHA256_BLOCK_SIZE];
} neo_sha256_ctx_t;

typedef struct {
    neo_sha256_ctx_t inner;
    neo_sha256_ctx_t outer;
    uint8_t k_opad[NEO_SHA256_BLOCK_SIZE];
} neo_hmac_ctx_t;

void neo_sha256_init(neo_sha256_ctx_t *ctx);
void neo_sha256_update(neo_sha256_ctx_t *ctx, const void *data, size_t len);
void neo_sha256_final(neo_sha256_ctx_t *ctx, uint8_t out[NEO_SHA256_DIGEST_SIZE]);
void neo_sha256(const void *data, size_t len, uint8_t out[NEO_SHA256_DIGEST_SIZE]);

void neo_hmac_sha256_init(neo_hmac_ctx_t *ctx, const void *key, size_t key_len);
void neo_hmac_sha256_update(neo_hmac_ctx_t *ctx, const void *data, size_t len);
void neo_hmac_sha256_final(neo_hmac_ctx_t *ctx, uint8_t out[NEO_HMAC_SHA256_SIZE]);
void neo_hmac_sha256(const void *key, size_t key_len,
                     const void *data, size_t data_len,
                     uint8_t out[NEO_HMAC_SHA256_SIZE]);

/* Constant-time byte comparison: returns 1 if equal, 0 otherwise. */
int neo_ct_equal(const uint8_t *a, const uint8_t *b, size_t len);

/*
 * Derive 32-byte MCU E2E key:
 *   SHA-256("neo-mcu-e2e-v1:" + cluster_id + ":" + e2e_master_secret)
 */
void neo_mcu_derive_key(const char *cluster_id,
                        const char *e2e_master_secret,
                        uint8_t out_key[NEO_SHA256_DIGEST_SIZE]);

/*
 * Compute 32-byte MCU E2E MAC:
 *   HMAC-SHA256(mcu_key, UTF8(cluster_id) || 0x00 || UTF8(target_mcu_id) || 0x00 || uint64_be(seq_id) || cbor_bytes)
 */
void neo_mcu_compute_mac(const uint8_t mcu_key[NEO_SHA256_DIGEST_SIZE],
                         const char *cluster_id,
                         const char *target_mcu_id,
                         uint64_t seq_id,
                         const uint8_t *cbor_bytes,
                         size_t cbor_len,
                         uint8_t out_mac[NEO_HMAC_SHA256_SIZE]);

/* Constant-time MAC verification: returns 1 if valid, 0 if invalid. */
int neo_mcu_verify_mac(const uint8_t mcu_key[NEO_SHA256_DIGEST_SIZE],
                       const char *cluster_id,
                       const char *target_mcu_id,
                       uint64_t seq_id,
                       const uint8_t *cbor_bytes,
                       size_t cbor_len,
                       const uint8_t expected_mac[NEO_HMAC_SHA256_SIZE]);

/* CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no xorout. */
uint16_t neo_crc16_ccitt(const uint8_t *data, size_t len);

/* COBS encode/decode (without trailing 0x00 delimiter). */
int neo_cobs_encode(const uint8_t *in, size_t in_len,
                    uint8_t *out, size_t out_cap, size_t *out_len);
int neo_cobs_decode(const uint8_t *in, size_t in_len,
                    uint8_t *out, size_t out_cap, size_t *out_len);

/*
 * Non-IP UART/RS485 COBS frame (<= 4096 bytes including trailing 0x00):
 * Pre-COBS:
 *   [0xA5, 0x01, mcu_id_len(u8), mcu_id, seq_id(8B BE), e2e_mac(32B),
 *    cbor_len(u16 BE), cbor_bytes, crc16_ccitt(u16 BE)]
 * Encoded as COBS + 0x00 delimiter.
 */
int neo_uart_frame_encode(const char *mcu_id,
                          uint64_t seq_id,
                          const uint8_t e2e_mac[NEO_HMAC_SHA256_SIZE],
                          const uint8_t *cbor_bytes,
                          size_t cbor_len,
                          uint8_t *out_frame,
                          size_t out_cap,
                          size_t *out_len);

int neo_uart_frame_decode(const uint8_t *frame,
                          size_t frame_len,
                          char *out_mcu_id,
                          size_t mcu_id_cap,
                          uint64_t *out_seq_id,
                          uint8_t out_mac[NEO_HMAC_SHA256_SIZE],
                          uint8_t *out_cbor,
                          size_t cbor_cap,
                          size_t *out_cbor_len);

/* Big-endian 64-bit / 16-bit helpers. */
void neo_write_be64(uint8_t out[8], uint64_t v);
uint64_t neo_read_be64(const uint8_t in[8]);
void neo_write_be16(uint8_t out[2], uint16_t v);
uint16_t neo_read_be16(const uint8_t in[2]);

#ifdef __cplusplus
}
#endif

#endif /* NEO_CRYPTO_H */
