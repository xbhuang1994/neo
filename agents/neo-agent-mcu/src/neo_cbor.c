#include "neo_cbor.h"

#include <limits.h>
#include <string.h>

static int enc_put_byte(neo_cbor_enc_t *enc, uint8_t b) {
    if (enc->err != NEO_CBOR_OK) {
        return enc->err;
    }
    if (enc->len >= enc->cap) {
        enc->err = NEO_CBOR_ERR_OVERFLOW;
        return enc->err;
    }
    enc->buf[enc->len++] = b;
    return NEO_CBOR_OK;
}

static int enc_put_bytes(neo_cbor_enc_t *enc, const uint8_t *p, size_t n) {
    if (enc->err != NEO_CBOR_OK) {
        return enc->err;
    }
    if (n > enc->cap - enc->len) {
        enc->err = NEO_CBOR_ERR_OVERFLOW;
        return enc->err;
    }
    if (n > 0U) {
        memcpy(enc->buf + enc->len, p, n);
        enc->len += n;
    }
    return NEO_CBOR_OK;
}

static int enc_head(neo_cbor_enc_t *enc, uint8_t major, uint64_t val) {
    uint8_t hdr[9];
    size_t n = 0;
    uint8_t mt = (uint8_t)(major << 5);

    if (val <= 23U) {
        hdr[0] = (uint8_t)(mt | (uint8_t)val);
        n = 1U;
    } else if (val <= 0xFFU) {
        hdr[0] = (uint8_t)(mt | 24U);
        hdr[1] = (uint8_t)val;
        n = 2U;
    } else if (val <= 0xFFFFU) {
        hdr[0] = (uint8_t)(mt | 25U);
        hdr[1] = (uint8_t)(val >> 8);
        hdr[2] = (uint8_t)(val);
        n = 3U;
    } else if (val <= 0xFFFFFFFFULL) {
        hdr[0] = (uint8_t)(mt | 26U);
        hdr[1] = (uint8_t)(val >> 24);
        hdr[2] = (uint8_t)(val >> 16);
        hdr[3] = (uint8_t)(val >> 8);
        hdr[4] = (uint8_t)(val);
        n = 5U;
    } else {
        hdr[0] = (uint8_t)(mt | 27U);
        for (int i = 0; i < 8; i++) {
            hdr[1 + i] = (uint8_t)(val >> ((7 - i) * 8));
        }
        n = 9U;
    }
    return enc_put_bytes(enc, hdr, n);
}

void neo_cbor_enc_init(neo_cbor_enc_t *enc, uint8_t *buf, size_t cap) {
    enc->buf = buf;
    enc->cap = cap;
    enc->len = 0U;
    enc->err = (buf == NULL && cap > 0U) ? NEO_CBOR_ERR_FORMAT : NEO_CBOR_OK;
}

int neo_cbor_enc_uint(neo_cbor_enc_t *enc, uint64_t val) {
    return enc_head(enc, 0U, val);
}

int neo_cbor_enc_int(neo_cbor_enc_t *enc, int64_t val) {
    if (val >= 0) {
        return enc_head(enc, 0U, (uint64_t)val);
    }
    /* Compute (-1 - val) safely without signed overflow for INT64_MIN */
    uint64_t mag = (uint64_t)(-(val + 1));
    return enc_head(enc, 1U, mag);
}

int neo_cbor_enc_bstr(neo_cbor_enc_t *enc, const uint8_t *data, size_t len) {
    if (data == NULL && len > 0U) {
        enc->err = NEO_CBOR_ERR_FORMAT;
        return enc->err;
    }
    int rc = enc_head(enc, 2U, (uint64_t)len);
    if (rc != NEO_CBOR_OK) {
        return rc;
    }
    return enc_put_bytes(enc, data, len);
}

int neo_cbor_enc_tstr_n(neo_cbor_enc_t *enc, const char *str, size_t len) {
    if (str == NULL && len > 0U) {
        enc->err = NEO_CBOR_ERR_FORMAT;
        return enc->err;
    }
    int rc = enc_head(enc, 3U, (uint64_t)len);
    if (rc != NEO_CBOR_OK) {
        return rc;
    }
    return enc_put_bytes(enc, (const uint8_t *)str, len);
}

int neo_cbor_enc_tstr(neo_cbor_enc_t *enc, const char *str) {
    if (str == NULL) {
        return neo_cbor_enc_tstr_n(enc, "", 0U);
    }
    return neo_cbor_enc_tstr_n(enc, str, strlen(str));
}

int neo_cbor_enc_array(neo_cbor_enc_t *enc, size_t count) {
    return enc_head(enc, 4U, (uint64_t)count);
}

int neo_cbor_enc_map(neo_cbor_enc_t *enc, size_t count) {
    return enc_head(enc, 5U, (uint64_t)count);
}

int neo_cbor_enc_bool(neo_cbor_enc_t *enc, bool val) {
    return enc_put_byte(enc, val ? 0xF5U : 0xF4U);
}

int neo_cbor_enc_null(neo_cbor_enc_t *enc) {
    return enc_put_byte(enc, 0xF6U);
}

void neo_cbor_dec_init(neo_cbor_dec_t *dec, const uint8_t *buf, size_t len) {
    dec->buf = buf;
    dec->len = len;
    dec->pos = 0U;
}

static int dec_read_arg(neo_cbor_dec_t *dec, uint8_t *out_major, uint8_t *out_ai, uint64_t *out_arg) {
    if (dec->pos >= dec->len) {
        return NEO_CBOR_ERR_EOF;
    }
    uint8_t ib = dec->buf[dec->pos++];
    uint8_t major = (uint8_t)(ib >> 5);
    uint8_t ai = (uint8_t)(ib & 0x1FU);
    uint64_t arg = 0U;

    if (ai < 24U) {
        arg = (uint64_t)ai;
    } else if (ai == 24U) {
        if (dec->len - dec->pos < 1U) {
            return NEO_CBOR_ERR_EOF;
        }
        arg = (uint64_t)dec->buf[dec->pos++];
    } else if (ai == 25U) {
        if (dec->len - dec->pos < 2U) {
            return NEO_CBOR_ERR_EOF;
        }
        arg = ((uint64_t)dec->buf[dec->pos] << 8) |
              (uint64_t)dec->buf[dec->pos + 1U];
        dec->pos += 2U;
    } else if (ai == 26U) {
        if (dec->len - dec->pos < 4U) {
            return NEO_CBOR_ERR_EOF;
        }
        arg = ((uint64_t)dec->buf[dec->pos] << 24) |
              ((uint64_t)dec->buf[dec->pos + 1U] << 16) |
              ((uint64_t)dec->buf[dec->pos + 2U] << 8) |
              (uint64_t)dec->buf[dec->pos + 3U];
        dec->pos += 4U;
    } else if (ai == 27U) {
        if (dec->len - dec->pos < 8U) {
            return NEO_CBOR_ERR_EOF;
        }
        for (int i = 0; i < 8; i++) {
            arg = (arg << 8) | (uint64_t)dec->buf[dec->pos + (size_t)i];
        }
        dec->pos += 8U;
    } else {
        return NEO_CBOR_ERR_FORMAT;
    }

    *out_major = major;
    *out_ai = ai;
    *out_arg = arg;
    return NEO_CBOR_OK;
}

int neo_cbor_dec_peek_type(const neo_cbor_dec_t *dec, neo_cbor_type_t *out_type) {
    if (dec->pos >= dec->len) {
        return NEO_CBOR_ERR_EOF;
    }
    uint8_t ib = dec->buf[dec->pos];
    uint8_t major = (uint8_t)(ib >> 5);
    uint8_t ai = (uint8_t)(ib & 0x1FU);

    switch (major) {
    case 0: *out_type = NEO_CBOR_UINT; return NEO_CBOR_OK;
    case 1: *out_type = NEO_CBOR_NEGINT; return NEO_CBOR_OK;
    case 2: *out_type = NEO_CBOR_BSTR; return NEO_CBOR_OK;
    case 3: *out_type = NEO_CBOR_TSTR; return NEO_CBOR_OK;
    case 4: *out_type = NEO_CBOR_ARRAY; return NEO_CBOR_OK;
    case 5: *out_type = NEO_CBOR_MAP; return NEO_CBOR_OK;
    case 7:
        if (ai == 20U || ai == 21U) {
            *out_type = NEO_CBOR_BOOL;
            return NEO_CBOR_OK;
        }
        if (ai == 22U) {
            *out_type = NEO_CBOR_NULL;
            return NEO_CBOR_OK;
        }
        return NEO_CBOR_ERR_FORMAT;
    default:
        return NEO_CBOR_ERR_FORMAT;
    }
}

int neo_cbor_dec_uint(neo_cbor_dec_t *dec, uint64_t *out_val) {
    uint8_t major = 0, ai = 0;
    uint64_t arg = 0;
    size_t saved = dec->pos;
    int rc = dec_read_arg(dec, &major, &ai, &arg);
    if (rc != NEO_CBOR_OK) {
        return rc;
    }
    if (major != 0U) {
        dec->pos = saved;
        return NEO_CBOR_ERR_TYPE;
    }
    *out_val = arg;
    return NEO_CBOR_OK;
}

int neo_cbor_dec_int(neo_cbor_dec_t *dec, int64_t *out_val) {
    uint8_t major = 0, ai = 0;
    uint64_t arg = 0;
    size_t saved = dec->pos;
    int rc = dec_read_arg(dec, &major, &ai, &arg);
    if (rc != NEO_CBOR_OK) {
        return rc;
    }
    if (major == 0U) {
        if (arg > (uint64_t)INT64_MAX) {
            dec->pos = saved;
            return NEO_CBOR_ERR_RANGE;
        }
        *out_val = (int64_t)arg;
        return NEO_CBOR_OK;
    }
    if (major == 1U) {
        if (arg > (uint64_t)INT64_MAX) {
            dec->pos = saved;
            return NEO_CBOR_ERR_RANGE;
        }
        *out_val = -1 - (int64_t)arg;
        return NEO_CBOR_OK;
    }
    dec->pos = saved;
    return NEO_CBOR_ERR_TYPE;
}

int neo_cbor_dec_bstr(neo_cbor_dec_t *dec, const uint8_t **out_ptr, size_t *out_len) {
    uint8_t major = 0, ai = 0;
    uint64_t arg = 0;
    size_t saved = dec->pos;
    int rc = dec_read_arg(dec, &major, &ai, &arg);
    if (rc != NEO_CBOR_OK) {
        return rc;
    }
    if (major != 2U) {
        dec->pos = saved;
        return NEO_CBOR_ERR_TYPE;
    }
    if (arg > (uint64_t)(dec->len - dec->pos)) {
        dec->pos = saved;
        return NEO_CBOR_ERR_EOF;
    }
    *out_ptr = dec->buf + dec->pos;
    *out_len = (size_t)arg;
    dec->pos += (size_t)arg;
    return NEO_CBOR_OK;
}

int neo_cbor_dec_tstr(neo_cbor_dec_t *dec, const char **out_ptr, size_t *out_len) {
    uint8_t major = 0, ai = 0;
    uint64_t arg = 0;
    size_t saved = dec->pos;
    int rc = dec_read_arg(dec, &major, &ai, &arg);
    if (rc != NEO_CBOR_OK) {
        return rc;
    }
    if (major != 3U) {
        dec->pos = saved;
        return NEO_CBOR_ERR_TYPE;
    }
    if (arg > (uint64_t)(dec->len - dec->pos)) {
        dec->pos = saved;
        return NEO_CBOR_ERR_EOF;
    }
    *out_ptr = (const char *)(dec->buf + dec->pos);
    *out_len = (size_t)arg;
    dec->pos += (size_t)arg;
    return NEO_CBOR_OK;
}

int neo_cbor_dec_array(neo_cbor_dec_t *dec, size_t *out_count) {
    uint8_t major = 0, ai = 0;
    uint64_t arg = 0;
    size_t saved = dec->pos;
    int rc = dec_read_arg(dec, &major, &ai, &arg);
    if (rc != NEO_CBOR_OK) {
        return rc;
    }
    if (major != 4U) {
        dec->pos = saved;
        return NEO_CBOR_ERR_TYPE;
    }
    if (arg > (uint64_t)(dec->len - dec->pos)) {
        dec->pos = saved;
        return NEO_CBOR_ERR_EOF;
    }
    *out_count = (size_t)arg;
    return NEO_CBOR_OK;
}

int neo_cbor_dec_map(neo_cbor_dec_t *dec, size_t *out_count) {
    uint8_t major = 0, ai = 0;
    uint64_t arg = 0;
    size_t saved = dec->pos;
    int rc = dec_read_arg(dec, &major, &ai, &arg);
    if (rc != NEO_CBOR_OK) {
        return rc;
    }
    if (major != 5U) {
        dec->pos = saved;
        return NEO_CBOR_ERR_TYPE;
    }
    if (arg > (uint64_t)(dec->len - dec->pos) / 2U) {
        dec->pos = saved;
        return NEO_CBOR_ERR_EOF;
    }
    *out_count = (size_t)arg;
    return NEO_CBOR_OK;
}

int neo_cbor_dec_bool(neo_cbor_dec_t *dec, bool *out_val) {
    if (dec->pos >= dec->len) {
        return NEO_CBOR_ERR_EOF;
    }
    uint8_t b = dec->buf[dec->pos];
    if (b == 0xF4U) {
        *out_val = false;
        dec->pos++;
        return NEO_CBOR_OK;
    }
    if (b == 0xF5U) {
        *out_val = true;
        dec->pos++;
        return NEO_CBOR_OK;
    }
    return NEO_CBOR_ERR_TYPE;
}

int neo_cbor_dec_null(neo_cbor_dec_t *dec) {
    if (dec->pos >= dec->len) {
        return NEO_CBOR_ERR_EOF;
    }
    if (dec->buf[dec->pos] != 0xF6U) {
        return NEO_CBOR_ERR_TYPE;
    }
    dec->pos++;
    return NEO_CBOR_OK;
}

static int dec_skip_depth(neo_cbor_dec_t *dec, int depth) {
    if (depth > NEO_CBOR_MAX_DEPTH) {
        return NEO_CBOR_ERR_DEPTH;
    }
    uint8_t major = 0, ai = 0;
    uint64_t arg = 0;
    int rc = dec_read_arg(dec, &major, &ai, &arg);
    if (rc != NEO_CBOR_OK) {
        return rc;
    }

    switch (major) {
    case 0:
    case 1:
        return NEO_CBOR_OK;
    case 2:
    case 3:
        if (arg > (uint64_t)(dec->len - dec->pos)) {
            return NEO_CBOR_ERR_EOF;
        }
        dec->pos += (size_t)arg;
        return NEO_CBOR_OK;
    case 4:
        if (arg > (uint64_t)(dec->len - dec->pos)) {
            return NEO_CBOR_ERR_EOF;
        }
        for (uint64_t i = 0; i < arg; i++) {
            rc = dec_skip_depth(dec, depth + 1);
            if (rc != NEO_CBOR_OK) {
                return rc;
            }
        }
        return NEO_CBOR_OK;
    case 5:
        if (arg > (uint64_t)(dec->len - dec->pos) / 2U) {
            return NEO_CBOR_ERR_EOF;
        }
        for (uint64_t i = 0; i < arg; i++) {
            rc = dec_skip_depth(dec, depth + 1);
            if (rc != NEO_CBOR_OK) {
                return rc;
            }
            rc = dec_skip_depth(dec, depth + 1);
            if (rc != NEO_CBOR_OK) {
                return rc;
            }
        }
        return NEO_CBOR_OK;
    case 7:
        if (ai == 20U || ai == 21U || ai == 22U) {
            return NEO_CBOR_OK;
        }
        return NEO_CBOR_ERR_FORMAT;
    default:
        return NEO_CBOR_ERR_FORMAT;
    }
}

int neo_cbor_dec_skip(neo_cbor_dec_t *dec) {
    return dec_skip_depth(dec, 0);
}

int neo_cbor_tstr_eq(const char *s, size_t slen, const char *lit) {
    size_t llen = strlen(lit);
    if (slen != llen) {
        return 0;
    }
    return memcmp(s, lit, slen) == 0 ? 1 : 0;
}
