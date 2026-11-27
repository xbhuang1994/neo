#ifndef NEO_CBOR_H
#define NEO_CBOR_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define NEO_CBOR_OK             0
#define NEO_CBOR_ERR_OVERFLOW  -1
#define NEO_CBOR_ERR_EOF       -2
#define NEO_CBOR_ERR_FORMAT    -3
#define NEO_CBOR_ERR_TYPE      -4
#define NEO_CBOR_ERR_RANGE     -5
#define NEO_CBOR_ERR_DEPTH     -6

#define NEO_CBOR_MAX_DEPTH     16

typedef enum {
    NEO_CBOR_UINT = 0,
    NEO_CBOR_NEGINT = 1,
    NEO_CBOR_BSTR = 2,
    NEO_CBOR_TSTR = 3,
    NEO_CBOR_ARRAY = 4,
    NEO_CBOR_MAP = 5,
    NEO_CBOR_BOOL = 6,
    NEO_CBOR_NULL = 7
} neo_cbor_type_t;

typedef struct {
    uint8_t *buf;
    size_t cap;
    size_t len;
    int err;
} neo_cbor_enc_t;

typedef struct {
    const uint8_t *buf;
    size_t len;
    size_t pos;
} neo_cbor_dec_t;

/* Encoder API (zero-allocation, RFC 8949 minimal integer length) */
void neo_cbor_enc_init(neo_cbor_enc_t *enc, uint8_t *buf, size_t cap);
int neo_cbor_enc_uint(neo_cbor_enc_t *enc, uint64_t val);
int neo_cbor_enc_int(neo_cbor_enc_t *enc, int64_t val);
int neo_cbor_enc_bstr(neo_cbor_enc_t *enc, const uint8_t *data, size_t len);
int neo_cbor_enc_tstr(neo_cbor_enc_t *enc, const char *str);
int neo_cbor_enc_tstr_n(neo_cbor_enc_t *enc, const char *str, size_t len);
int neo_cbor_enc_array(neo_cbor_enc_t *enc, size_t count);
int neo_cbor_enc_map(neo_cbor_enc_t *enc, size_t count);
int neo_cbor_enc_bool(neo_cbor_enc_t *enc, bool val);
int neo_cbor_enc_null(neo_cbor_enc_t *enc);

/* Decoder API (zero-allocation, zero-copy string/bytes slices) */
void neo_cbor_dec_init(neo_cbor_dec_t *dec, const uint8_t *buf, size_t len);
int neo_cbor_dec_peek_type(const neo_cbor_dec_t *dec, neo_cbor_type_t *out_type);
int neo_cbor_dec_uint(neo_cbor_dec_t *dec, uint64_t *out_val);
int neo_cbor_dec_int(neo_cbor_dec_t *dec, int64_t *out_val);
int neo_cbor_dec_bstr(neo_cbor_dec_t *dec, const uint8_t **out_ptr, size_t *out_len);
int neo_cbor_dec_tstr(neo_cbor_dec_t *dec, const char **out_ptr, size_t *out_len);
int neo_cbor_dec_array(neo_cbor_dec_t *dec, size_t *out_count);
int neo_cbor_dec_map(neo_cbor_dec_t *dec, size_t *out_count);
int neo_cbor_dec_bool(neo_cbor_dec_t *dec, bool *out_val);
int neo_cbor_dec_null(neo_cbor_dec_t *dec);
int neo_cbor_dec_skip(neo_cbor_dec_t *dec);

/* Helper to compare a decoded tstr slice against a NUL-terminated literal. */
int neo_cbor_tstr_eq(const char *s, size_t slen, const char *lit);

#ifdef __cplusplus
}
#endif

#endif /* NEO_CBOR_H */
