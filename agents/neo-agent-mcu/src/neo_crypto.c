#include "neo_crypto.h"

#include <string.h>

static uint32_t rotr32(uint32_t x, uint32_t n) {
    return (x >> n) | (x << (32U - n));
}

static uint32_t read_be32(const uint8_t *p) {
    return ((uint32_t)p[0] << 24) |
           ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] << 8) |
           ((uint32_t)p[3]);
}

static void write_be32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)(v >> 24);
    p[1] = (uint8_t)(v >> 16);
    p[2] = (uint8_t)(v >> 8);
    p[3] = (uint8_t)(v);
}

void neo_write_be64(uint8_t out[8], uint64_t v) {
    for (int i = 0; i < 8; i++) {
        out[i] = (uint8_t)(v >> ((7 - i) * 8));
    }
}

uint64_t neo_read_be64(const uint8_t in[8]) {
    uint64_t v = 0;
    for (int i = 0; i < 8; i++) {
        v = (v << 8) | (uint64_t)in[i];
    }
    return v;
}

void neo_write_be16(uint8_t out[2], uint16_t v) {
    out[0] = (uint8_t)(v >> 8);
    out[1] = (uint8_t)(v & 0xFFU);
}

uint16_t neo_read_be16(const uint8_t in[2]) {
    return (uint16_t)(((uint16_t)in[0] << 8) | (uint16_t)in[1]);
}

static const uint32_t SHA256_K[64] = {
    0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U,
    0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
    0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U,
    0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
    0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU,
    0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
    0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U,
    0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
    0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U,
    0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
    0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U,
    0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
    0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U,
    0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
    0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U,
    0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U
};

static void sha256_compress(neo_sha256_ctx_t *ctx, const uint8_t block[64]) {
    uint32_t w[64];
    for (int i = 0; i < 16; i++) {
        w[i] = read_be32(block + (size_t)i * 4U);
    }
    for (int i = 16; i < 64; i++) {
        uint32_t s0 = rotr32(w[i - 15], 7U) ^ rotr32(w[i - 15], 18U) ^ (w[i - 15] >> 3);
        uint32_t s1 = rotr32(w[i - 2], 17U) ^ rotr32(w[i - 2], 19U) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }

    uint32_t a = ctx->state[0];
    uint32_t b = ctx->state[1];
    uint32_t c = ctx->state[2];
    uint32_t d = ctx->state[3];
    uint32_t e = ctx->state[4];
    uint32_t f = ctx->state[5];
    uint32_t g = ctx->state[6];
    uint32_t h = ctx->state[7];

    for (int i = 0; i < 64; i++) {
        uint32_t s1 = rotr32(e, 6U) ^ rotr32(e, 11U) ^ rotr32(e, 25U);
        uint32_t ch = (e & f) ^ ((~e) & g);
        uint32_t t1 = h + s1 + ch + SHA256_K[i] + w[i];
        uint32_t s0 = rotr32(a, 2U) ^ rotr32(a, 13U) ^ rotr32(a, 22U);
        uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
        uint32_t t2 = s0 + maj;

        h = g;
        g = f;
        f = e;
        e = d + t1;
        d = c;
        c = b;
        b = a;
        a = t1 + t2;
    }

    ctx->state[0] += a;
    ctx->state[1] += b;
    ctx->state[2] += c;
    ctx->state[3] += d;
    ctx->state[4] += e;
    ctx->state[5] += f;
    ctx->state[6] += g;
    ctx->state[7] += h;
}

void neo_sha256_init(neo_sha256_ctx_t *ctx) {
    ctx->state[0] = 0x6a09e667U;
    ctx->state[1] = 0xbb67ae85U;
    ctx->state[2] = 0x3c6ef372U;
    ctx->state[3] = 0xa54ff53aU;
    ctx->state[4] = 0x510e527fU;
    ctx->state[5] = 0x9b05688cU;
    ctx->state[6] = 0x1f83d9abU;
    ctx->state[7] = 0x5be0cd19U;
    ctx->count = 0;
}

void neo_sha256_update(neo_sha256_ctx_t *ctx, const void *data, size_t len) {
    if (len == 0U) {
        return;
    }
    const uint8_t *src = (const uint8_t *)data;
    size_t idx = (size_t)(ctx->count & 63U);
    ctx->count += (uint64_t)len;

    if (idx > 0U) {
        size_t take = NEO_SHA256_BLOCK_SIZE - idx;
        if (take > len) {
            take = len;
        }
        memcpy(ctx->buf + idx, src, take);
        src += take;
        len -= take;
        if (idx + take == NEO_SHA256_BLOCK_SIZE) {
            sha256_compress(ctx, ctx->buf);
        }
    }

    while (len >= NEO_SHA256_BLOCK_SIZE) {
        sha256_compress(ctx, src);
        src += NEO_SHA256_BLOCK_SIZE;
        len -= NEO_SHA256_BLOCK_SIZE;
    }

    if (len > 0U) {
        memcpy(ctx->buf, src, len);
    }
}

void neo_sha256_final(neo_sha256_ctx_t *ctx, uint8_t out[NEO_SHA256_DIGEST_SIZE]) {
    uint64_t bit_len = ctx->count * 8U;
    uint8_t pad = 0x80U;
    neo_sha256_update(ctx, &pad, 1U);

    size_t idx = (size_t)(ctx->count & 63U);
    if (idx > 56U) {
        memset(ctx->buf + idx, 0, NEO_SHA256_BLOCK_SIZE - idx);
        sha256_compress(ctx, ctx->buf);
        idx = 0U;
    }
    memset(ctx->buf + idx, 0, 56U - idx);
    neo_write_be64(ctx->buf + 56U, bit_len);
    sha256_compress(ctx, ctx->buf);

    for (int i = 0; i < 8; i++) {
        write_be32(out + (size_t)i * 4U, ctx->state[i]);
    }
}

void neo_sha256(const void *data, size_t len, uint8_t out[NEO_SHA256_DIGEST_SIZE]) {
    neo_sha256_ctx_t ctx;
    neo_sha256_init(&ctx);
    neo_sha256_update(&ctx, data, len);
    neo_sha256_final(&ctx, out);
}

void neo_hmac_sha256_init(neo_hmac_ctx_t *ctx, const void *key, size_t key_len) {
    uint8_t k_block[NEO_SHA256_BLOCK_SIZE];
    uint8_t k_ipad[NEO_SHA256_BLOCK_SIZE];

    memset(k_block, 0, sizeof(k_block));
    if (key_len > NEO_SHA256_BLOCK_SIZE) {
        neo_sha256(key, key_len, k_block);
    } else if (key_len > 0U) {
        memcpy(k_block, key, key_len);
    }

    for (size_t i = 0; i < NEO_SHA256_BLOCK_SIZE; i++) {
        k_ipad[i] = (uint8_t)(k_block[i] ^ 0x36U);
        ctx->k_opad[i] = (uint8_t)(k_block[i] ^ 0x5cU);
    }

    neo_sha256_init(&ctx->inner);
    neo_sha256_update(&ctx->inner, k_ipad, sizeof(k_ipad));

    neo_sha256_init(&ctx->outer);
    neo_sha256_update(&ctx->outer, ctx->k_opad, sizeof(ctx->k_opad));

    memset(k_block, 0, sizeof(k_block));
    memset(k_ipad, 0, sizeof(k_ipad));
}

void neo_hmac_sha256_update(neo_hmac_ctx_t *ctx, const void *data, size_t len) {
    neo_sha256_update(&ctx->inner, data, len);
}

void neo_hmac_sha256_final(neo_hmac_ctx_t *ctx, uint8_t out[NEO_HMAC_SHA256_SIZE]) {
    uint8_t inner_hash[NEO_SHA256_DIGEST_SIZE];
    neo_sha256_final(&ctx->inner, inner_hash);
    neo_sha256_update(&ctx->outer, inner_hash, sizeof(inner_hash));
    neo_sha256_final(&ctx->outer, out);
    memset(inner_hash, 0, sizeof(inner_hash));
}

void neo_hmac_sha256(const void *key, size_t key_len,
                     const void *data, size_t data_len,
                     uint8_t out[NEO_HMAC_SHA256_SIZE]) {
    neo_hmac_ctx_t ctx;
    neo_hmac_sha256_init(&ctx, key, key_len);
    neo_hmac_sha256_update(&ctx, data, data_len);
    neo_hmac_sha256_final(&ctx, out);
}

int neo_ct_equal(const uint8_t *a, const uint8_t *b, size_t len) {
    volatile uint8_t diff = 0;
    for (size_t i = 0; i < len; i++) {
        diff |= (uint8_t)(a[i] ^ b[i]);
    }
    return diff == 0U ? 1 : 0;
}

void neo_mcu_derive_key(const char *cluster_id,
                        const char *e2e_master_secret,
                        uint8_t out_key[NEO_SHA256_DIGEST_SIZE]) {
    static const char prefix[] = "neo-mcu-e2e-v1:";
    static const char sep = ':';
    neo_sha256_ctx_t ctx;
    neo_sha256_init(&ctx);
    neo_sha256_update(&ctx, prefix, sizeof(prefix) - 1U);
    if (cluster_id != NULL) {
        neo_sha256_update(&ctx, cluster_id, strlen(cluster_id));
    }
    neo_sha256_update(&ctx, &sep, 1U);
    if (e2e_master_secret != NULL) {
        neo_sha256_update(&ctx, e2e_master_secret, strlen(e2e_master_secret));
    }
    neo_sha256_final(&ctx, out_key);
}

void neo_mcu_compute_mac(const uint8_t mcu_key[NEO_SHA256_DIGEST_SIZE],
                         const char *cluster_id,
                         const char *target_mcu_id,
                         uint64_t seq_id,
                         const uint8_t *cbor_bytes,
                         size_t cbor_len,
                         uint8_t out_mac[NEO_HMAC_SHA256_SIZE]) {
    static const uint8_t zero = 0x00U;
    uint8_t seq_be[8];
    neo_hmac_ctx_t ctx;

    neo_write_be64(seq_be, seq_id);
    neo_hmac_sha256_init(&ctx, mcu_key, NEO_SHA256_DIGEST_SIZE);
    if (cluster_id != NULL) {
        neo_hmac_sha256_update(&ctx, cluster_id, strlen(cluster_id));
    }
    neo_hmac_sha256_update(&ctx, &zero, 1U);
    if (target_mcu_id != NULL) {
        neo_hmac_sha256_update(&ctx, target_mcu_id, strlen(target_mcu_id));
    }
    neo_hmac_sha256_update(&ctx, &zero, 1U);
    neo_hmac_sha256_update(&ctx, seq_be, sizeof(seq_be));
    if (cbor_bytes != NULL && cbor_len > 0U) {
        neo_hmac_sha256_update(&ctx, cbor_bytes, cbor_len);
    }
    neo_hmac_sha256_final(&ctx, out_mac);
}

int neo_mcu_verify_mac(const uint8_t mcu_key[NEO_SHA256_DIGEST_SIZE],
                       const char *cluster_id,
                       const char *target_mcu_id,
                       uint64_t seq_id,
                       const uint8_t *cbor_bytes,
                       size_t cbor_len,
                       const uint8_t expected_mac[NEO_HMAC_SHA256_SIZE]) {
    uint8_t actual[NEO_HMAC_SHA256_SIZE];
    neo_mcu_compute_mac(mcu_key, cluster_id, target_mcu_id, seq_id,
                        cbor_bytes, cbor_len, actual);
    return neo_ct_equal(actual, expected_mac, NEO_HMAC_SHA256_SIZE);
}

uint16_t neo_crc16_ccitt(const uint8_t *data, size_t len) {
    uint16_t crc = 0xFFFFU;
    for (size_t i = 0; i < len; i++) {
        crc ^= (uint16_t)data[i] << 8;
        for (int b = 0; b < 8; b++) {
            if (crc & 0x8000U) {
                crc = (uint16_t)((crc << 1) ^ 0x1021U);
            } else {
                crc = (uint16_t)(crc << 1);
            }
        }
    }
    return crc;
}

int neo_cobs_encode(const uint8_t *in, size_t in_len,
                    uint8_t *out, size_t out_cap, size_t *out_len) {
    if (out == NULL || out_len == NULL || (in == NULL && in_len > 0U)) {
        return NEO_CRYPTO_ERR_INVALID;
    }
    if (out_cap == 0U) {
        return NEO_CRYPTO_ERR_OVERFLOW;
    }

    size_t code_idx = 0U;
    size_t write_idx = 1U;
    uint8_t code = 1U;

    for (size_t i = 0; i < in_len; i++) {
        if (in[i] == 0U) {
            out[code_idx] = code;
            code = 1U;
            code_idx = write_idx++;
            if (write_idx > out_cap) {
                return NEO_CRYPTO_ERR_OVERFLOW;
            }
        } else {
            if (write_idx >= out_cap) {
                return NEO_CRYPTO_ERR_OVERFLOW;
            }
            out[write_idx++] = in[i];
            code++;
            if (code == 0xFFU) {
                out[code_idx] = code;
                code = 1U;
                code_idx = write_idx++;
                if (write_idx > out_cap && i + 1U < in_len) {
                    return NEO_CRYPTO_ERR_OVERFLOW;
                }
            }
        }
    }

    if (code_idx >= out_cap) {
        return NEO_CRYPTO_ERR_OVERFLOW;
    }
    out[code_idx] = code;
    *out_len = write_idx;
    return NEO_CRYPTO_OK;
}

int neo_cobs_decode(const uint8_t *in, size_t in_len,
                    uint8_t *out, size_t out_cap, size_t *out_len) {
    if (in == NULL || out == NULL || out_len == NULL || in_len == 0U) {
        return NEO_CRYPTO_ERR_INVALID;
    }

    size_t read_idx = 0U;
    size_t write_idx = 0U;

    while (read_idx < in_len) {
        uint8_t code = in[read_idx++];
        if (code == 0U) {
            return NEO_CRYPTO_ERR_FORMAT;
        }
        size_t copy_len = (size_t)code - 1U;
        if (read_idx + copy_len > in_len) {
            return NEO_CRYPTO_ERR_FORMAT;
        }
        if (write_idx + copy_len > out_cap) {
            return NEO_CRYPTO_ERR_OVERFLOW;
        }
        for (size_t j = 0; j < copy_len; j++) {
            uint8_t byte = in[read_idx++];
            if (byte == 0U) {
                return NEO_CRYPTO_ERR_FORMAT;
            }
            out[write_idx++] = byte;
        }
        if (code < 0xFFU && read_idx < in_len) {
            if (write_idx >= out_cap) {
                return NEO_CRYPTO_ERR_OVERFLOW;
            }
            out[write_idx++] = 0U;
        }
    }

    *out_len = write_idx;
    return NEO_CRYPTO_OK;
}

int neo_uart_frame_encode(const char *mcu_id,
                          uint64_t seq_id,
                          const uint8_t e2e_mac[NEO_HMAC_SHA256_SIZE],
                          const uint8_t *cbor_bytes,
                          size_t cbor_len,
                          uint8_t *out_frame,
                          size_t out_cap,
                          size_t *out_len) {
    if (mcu_id == NULL || e2e_mac == NULL || out_frame == NULL || out_len == NULL) {
        return NEO_CRYPTO_ERR_INVALID;
    }
    if (cbor_bytes == NULL && cbor_len > 0U) {
        return NEO_CRYPTO_ERR_INVALID;
    }

    size_t id_len = strlen(mcu_id);
    if (id_len == 0U || id_len > NEO_UART_MAX_ID_LEN || cbor_len > 0xFFFFU) {
        return NEO_CRYPTO_ERR_INVALID;
    }

    /* Pre-COBS: 2(hdr) + 1(id_len) + id_len + 8(seq) + 32(mac) + 2(cbor_len) + cbor_len + 2(crc) */
    size_t pre_len = 2U + 1U + id_len + 8U + 32U + 2U + cbor_len + 2U;
    if (pre_len > NEO_COBS_MAX_FRAME_SIZE) {
        return NEO_CRYPTO_ERR_OVERFLOW;
    }

    uint8_t pre[NEO_COBS_MAX_FRAME_SIZE];
    size_t pos = 0U;
    pre[pos++] = NEO_UART_MAGIC_0;
    pre[pos++] = NEO_UART_VERSION;
    pre[pos++] = (uint8_t)id_len;
    memcpy(pre + pos, mcu_id, id_len);
    pos += id_len;
    neo_write_be64(pre + pos, seq_id);
    pos += 8U;
    memcpy(pre + pos, e2e_mac, NEO_HMAC_SHA256_SIZE);
    pos += NEO_HMAC_SHA256_SIZE;
    neo_write_be16(pre + pos, (uint16_t)cbor_len);
    pos += 2U;
    if (cbor_len > 0U) {
        memcpy(pre + pos, cbor_bytes, cbor_len);
        pos += cbor_len;
    }

    uint16_t crc = neo_crc16_ccitt(pre, pos);
    neo_write_be16(pre + pos, crc);
    pos += 2U;

    size_t cobs_len = 0U;
    size_t max_cap = out_cap < NEO_COBS_MAX_FRAME_SIZE ? out_cap : NEO_COBS_MAX_FRAME_SIZE;
    if (max_cap < 2U) {
        return NEO_CRYPTO_ERR_OVERFLOW;
    }
    int rc = neo_cobs_encode(pre, pos, out_frame, max_cap - 1U, &cobs_len);
    if (rc != NEO_CRYPTO_OK) {
        return rc;
    }
    out_frame[cobs_len] = 0x00U;
    *out_len = cobs_len + 1U;
    return NEO_CRYPTO_OK;
}

int neo_uart_frame_decode(const uint8_t *frame,
                          size_t frame_len,
                          char *out_mcu_id,
                          size_t mcu_id_cap,
                          uint64_t *out_seq_id,
                          uint8_t out_mac[NEO_HMAC_SHA256_SIZE],
                          uint8_t *out_cbor,
                          size_t cbor_cap,
                          size_t *out_cbor_len) {
    if (frame == NULL || out_mcu_id == NULL || out_seq_id == NULL ||
        out_mac == NULL || out_cbor == NULL || out_cbor_len == NULL) {
        return NEO_CRYPTO_ERR_INVALID;
    }
    if (frame_len == 0U || frame_len > NEO_COBS_MAX_FRAME_SIZE) {
        return NEO_CRYPTO_ERR_FORMAT;
    }

    size_t cobs_len = frame_len;
    if (frame[cobs_len - 1U] == 0x00U) {
        cobs_len--;
    }
    if (cobs_len == 0U) {
        return NEO_CRYPTO_ERR_FORMAT;
    }

    uint8_t pre[NEO_COBS_MAX_FRAME_SIZE];
    size_t pre_len = 0U;
    int rc = neo_cobs_decode(frame, cobs_len, pre, sizeof(pre), &pre_len);
    if (rc != NEO_CRYPTO_OK) {
        return rc;
    }

    /* Minimum size: 2 + 1 + 1 + 8 + 32 + 2 + 0 + 2 = 48 */
    if (pre_len < 48U) {
        return NEO_CRYPTO_ERR_FORMAT;
    }
    if (pre[0] != NEO_UART_MAGIC_0 || pre[1] != NEO_UART_VERSION) {
        return NEO_CRYPTO_ERR_FORMAT;
    }

    uint16_t expected_crc = neo_read_be16(pre + pre_len - 2U);
    uint16_t actual_crc = neo_crc16_ccitt(pre, pre_len - 2U);
    if (expected_crc != actual_crc) {
        return NEO_CRYPTO_ERR_CRC;
    }

    size_t id_len = (size_t)pre[2];
    if (id_len == 0U || id_len > NEO_UART_MAX_ID_LEN) {
        return NEO_CRYPTO_ERR_FORMAT;
    }
    if (3U + id_len + 8U + 32U + 2U + 2U > pre_len) {
        return NEO_CRYPTO_ERR_FORMAT;
    }
    if (id_len + 1U > mcu_id_cap) {
        return NEO_CRYPTO_ERR_OVERFLOW;
    }

    size_t pos = 3U;
    memcpy(out_mcu_id, pre + pos, id_len);
    out_mcu_id[id_len] = '\0';
    pos += id_len;

    *out_seq_id = neo_read_be64(pre + pos);
    pos += 8U;

    memcpy(out_mac, pre + pos, NEO_HMAC_SHA256_SIZE);
    pos += NEO_HMAC_SHA256_SIZE;

    size_t cbor_len = (size_t)neo_read_be16(pre + pos);
    pos += 2U;

    if (pos + cbor_len + 2U != pre_len) {
        return NEO_CRYPTO_ERR_FORMAT;
    }
    if (cbor_len > cbor_cap) {
        return NEO_CRYPTO_ERR_OVERFLOW;
    }
    if (cbor_len > 0U) {
        memcpy(out_cbor, pre + pos, cbor_len);
    }
    *out_cbor_len = cbor_len;
    return NEO_CRYPTO_OK;
}
