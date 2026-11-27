#include "neo_mcu.h"

#include <string.h>

static int safe_copy_str(char *dst, size_t cap, const char *src) {
    if (dst == NULL || cap == 0U || src == NULL) {
        return NEO_MCU_ERR_INVALID;
    }
    size_t len = strlen(src);
    if (len >= cap) {
        return NEO_MCU_ERR_OVERFLOW;
    }
    memcpy(dst, src, len + 1U);
    return NEO_MCU_OK;
}

static int safe_copy_slice(char *dst, size_t cap, const char *src, size_t len) {
    if (dst == NULL || cap == 0U || (src == NULL && len > 0U)) {
        return NEO_MCU_ERR_INVALID;
    }
    if (len >= cap) {
        return NEO_MCU_ERR_OVERFLOW;
    }
    if (len > 0U) {
        memcpy(dst, src, len);
    }
    dst[len] = '\0';
    return NEO_MCU_OK;
}

static int append_str(char *dst, size_t cap, size_t *pos, const char *s) {
    size_t len = strlen(s);
    if (*pos + len >= cap) {
        return NEO_MCU_ERR_OVERFLOW;
    }
    memcpy(dst + *pos, s, len);
    *pos += len;
    dst[*pos] = '\0';
    return NEO_MCU_OK;
}

static int format_topic(const neo_mcu_ctx_t *ctx, const char *suffix, char *out, size_t cap) {
    if (ctx == NULL || out == NULL || cap == 0U) {
        return NEO_MCU_ERR_INVALID;
    }
    size_t pos = 0U;
    out[0] = '\0';
    if (append_str(out, cap, &pos, "neo/") != NEO_MCU_OK ||
        append_str(out, cap, &pos, ctx->cluster_id) != NEO_MCU_OK ||
        append_str(out, cap, &pos, "/mcu/") != NEO_MCU_OK ||
        append_str(out, cap, &pos, ctx->device_id) != NEO_MCU_OK ||
        append_str(out, cap, &pos, suffix) != NEO_MCU_OK) {
        return NEO_MCU_ERR_OVERFLOW;
    }
    return NEO_MCU_OK;
}

int neo_mcu_topic_down(const neo_mcu_ctx_t *ctx, char *out, size_t cap) {
    return format_topic(ctx, "/down", out, cap);
}

int neo_mcu_topic_up(const neo_mcu_ctx_t *ctx, char *out, size_t cap) {
    return format_topic(ctx, "/up", out, cap);
}

void neo_param_set_init(neo_param_set_t *set) {
    if (set != NULL) {
        memset(set, 0, sizeof(*set));
    }
}

int neo_param_set_add_int(neo_param_set_t *set, const char *name, int64_t val) {
    if (set == NULL || name == NULL) {
        return NEO_MCU_ERR_INVALID;
    }
    if (set->count >= NEO_MCU_MAX_PARAMS) {
        return NEO_MCU_ERR_OVERFLOW;
    }
    neo_kv_t *kv = &set->items[set->count];
    int rc = safe_copy_str(kv->name, sizeof(kv->name), name);
    if (rc != NEO_MCU_OK) {
        return rc;
    }
    kv->type = NEO_PARAM_INT;
    kv->val.i = val;
    set->count++;
    return NEO_MCU_OK;
}

int neo_param_set_add_bool(neo_param_set_t *set, const char *name, bool val) {
    if (set == NULL || name == NULL) {
        return NEO_MCU_ERR_INVALID;
    }
    if (set->count >= NEO_MCU_MAX_PARAMS) {
        return NEO_MCU_ERR_OVERFLOW;
    }
    neo_kv_t *kv = &set->items[set->count];
    int rc = safe_copy_str(kv->name, sizeof(kv->name), name);
    if (rc != NEO_MCU_OK) {
        return rc;
    }
    kv->type = NEO_PARAM_BOOL;
    kv->val.b = val;
    set->count++;
    return NEO_MCU_OK;
}

int neo_param_set_add_tstr(neo_param_set_t *set, const char *name, const char *val) {
    if (set == NULL || name == NULL || val == NULL) {
        return NEO_MCU_ERR_INVALID;
    }
    if (set->count >= NEO_MCU_MAX_PARAMS) {
        return NEO_MCU_ERR_OVERFLOW;
    }
    neo_kv_t *kv = &set->items[set->count];
    int rc = safe_copy_str(kv->name, sizeof(kv->name), name);
    if (rc != NEO_MCU_OK) {
        return rc;
    }
    rc = safe_copy_str(kv->val.s, sizeof(kv->val.s), val);
    if (rc != NEO_MCU_OK) {
        return rc;
    }
    kv->type = NEO_PARAM_TSTR;
    set->count++;
    return NEO_MCU_OK;
}

const neo_kv_t *neo_param_set_find(const neo_param_set_t *set, const char *name) {
    if (set == NULL || name == NULL) {
        return NULL;
    }
    for (size_t i = 0U; i < set->count; i++) {
        if (strcmp(set->items[i].name, name) == 0) {
            return &set->items[i];
        }
    }
    return NULL;
}

int neo_mcu_init(neo_mcu_ctx_t *ctx,
                 const char *cluster_id,
                 const char *device_id,
                 const char *e2e_master_secret,
                 const char *chip,
                 const char *fw_version,
                 const neo_action_def_t *actions,
                 size_t action_count,
                 void *user_data) {
    if (ctx == NULL || cluster_id == NULL || device_id == NULL ||
        e2e_master_secret == NULL || chip == NULL || fw_version == NULL) {
        return NEO_MCU_ERR_INVALID;
    }
    if (cluster_id[0] == '\0' || device_id[0] == '\0') {
        return NEO_MCU_ERR_INVALID;
    }
    if (actions == NULL && action_count > 0U) {
        return NEO_MCU_ERR_INVALID;
    }

    memset(ctx, 0, sizeof(*ctx));
    if (safe_copy_str(ctx->cluster_id, sizeof(ctx->cluster_id), cluster_id) != NEO_MCU_OK ||
        safe_copy_str(ctx->device_id, sizeof(ctx->device_id), device_id) != NEO_MCU_OK ||
        safe_copy_str(ctx->chip, sizeof(ctx->chip), chip) != NEO_MCU_OK ||
        safe_copy_str(ctx->fw_version, sizeof(ctx->fw_version), fw_version) != NEO_MCU_OK) {
        return NEO_MCU_ERR_OVERFLOW;
    }

    neo_mcu_derive_key(ctx->cluster_id, e2e_master_secret, ctx->mcu_key);
    ctx->actions = actions;
    ctx->action_count = action_count;
    ctx->user_data = user_data;
    neo_mcu_ota_init(&ctx->ota, 0U, ctx->fw_version);
    return NEO_MCU_OK;
}

static int sign_and_frame_cbor(neo_mcu_ctx_t *ctx,
                               uint64_t seq_id,
                               const uint8_t *cbor_bytes,
                               size_t cbor_len,
                               uint8_t *out_wire,
                               size_t out_cap,
                               size_t *out_len) {
    if (out_wire == NULL || out_len == NULL) {
        return NEO_MCU_ERR_INVALID;
    }
    if (NEO_MCU_WIRE_HDR_SIZE + cbor_len > out_cap) {
        return NEO_MCU_ERR_OVERFLOW;
    }

    neo_write_be64(out_wire, seq_id);
    neo_mcu_compute_mac(ctx->mcu_key,
                        ctx->cluster_id,
                        ctx->device_id,
                        seq_id,
                        cbor_bytes,
                        cbor_len,
                        out_wire + 8U);
    if (cbor_len > 0U) {
        memcpy(out_wire + NEO_MCU_WIRE_HDR_SIZE, cbor_bytes, cbor_len);
    }
    *out_len = NEO_MCU_WIRE_HDR_SIZE + cbor_len;
    return NEO_MCU_OK;
}

int neo_mcu_build_hello(neo_mcu_ctx_t *ctx,
                        uint8_t *out_wire,
                        size_t out_cap,
                        size_t *out_len) {
    if (ctx == NULL || out_wire == NULL || out_len == NULL) {
        return NEO_MCU_ERR_INVALID;
    }

    neo_cbor_enc_t enc;
    neo_cbor_enc_init(&enc, ctx->tx_scratch, sizeof(ctx->tx_scratch));
    neo_cbor_enc_map(&enc, 4U);
    neo_cbor_enc_tstr(&enc, "t");
    neo_cbor_enc_tstr(&enc, "hello");
    neo_cbor_enc_tstr(&enc, "chip");
    neo_cbor_enc_tstr(&enc, ctx->chip);
    neo_cbor_enc_tstr(&enc, "fw");
    neo_cbor_enc_tstr(&enc, ctx->fw_version);
    neo_cbor_enc_tstr(&enc, "acts");
    neo_cbor_enc_array(&enc, ctx->action_count);
    for (size_t i = 0U; i < ctx->action_count; i++) {
        neo_cbor_enc_tstr(&enc, ctx->actions[i].name);
    }
    if (enc.err != NEO_CBOR_OK) {
        return NEO_MCU_ERR_OVERFLOW;
    }
    uint64_t seq_id = ++ctx->shadow.next_tx_seq_id;
    return sign_and_frame_cbor(ctx, seq_id, ctx->tx_scratch, enc.len, out_wire, out_cap, out_len);
}

static int encode_param_set(neo_cbor_enc_t *enc, const neo_param_set_t *set) {
    size_t count = (set != NULL) ? set->count : 0U;
    neo_cbor_enc_map(enc, count);
    for (size_t i = 0U; i < count; i++) {
        const neo_kv_t *kv = &set->items[i];
        neo_cbor_enc_tstr(enc, kv->name);
        switch (kv->type) {
        case NEO_PARAM_INT:
            neo_cbor_enc_int(enc, kv->val.i);
            break;
        case NEO_PARAM_BOOL:
            neo_cbor_enc_bool(enc, kv->val.b);
            break;
        case NEO_PARAM_TSTR:
            neo_cbor_enc_tstr(enc, kv->val.s);
            break;
        default:
            neo_cbor_enc_null(enc);
            break;
        }
    }
    return enc->err;
}

int neo_mcu_build_res_seq(neo_mcu_ctx_t *ctx,
                          uint64_t seq_id,
                          bool ok,
                          const char *action,
                          const neo_param_set_t *data,
                          const char *err_msg,
                          uint8_t *out_wire,
                          size_t out_cap,
                          size_t *out_len) {
    if (ctx == NULL || out_wire == NULL || out_len == NULL) {
        return NEO_MCU_ERR_INVALID;
    }

    neo_cbor_enc_t enc;
    neo_cbor_enc_init(&enc, ctx->tx_scratch, sizeof(ctx->tx_scratch));
    neo_cbor_enc_map(&enc, 5U);
    neo_cbor_enc_tstr(&enc, "t");
    neo_cbor_enc_tstr(&enc, "res");
    neo_cbor_enc_tstr(&enc, "ok");
    neo_cbor_enc_bool(&enc, ok);
    neo_cbor_enc_tstr(&enc, "a");
    neo_cbor_enc_tstr(&enc, action != NULL ? action : "");
    neo_cbor_enc_tstr(&enc, "d");
    encode_param_set(&enc, data);
    neo_cbor_enc_tstr(&enc, "e");
    neo_cbor_enc_tstr(&enc, err_msg != NULL ? err_msg : "");

    if (enc.err != NEO_CBOR_OK) {
        return NEO_MCU_ERR_OVERFLOW;
    }
    return sign_and_frame_cbor(ctx, seq_id, ctx->tx_scratch, enc.len, out_wire, out_cap, out_len);
}

int neo_mcu_build_res(neo_mcu_ctx_t *ctx,
                      bool ok,
                      const char *action,
                      const neo_param_set_t *data,
                      const char *err_msg,
                      uint8_t *out_wire,
                      size_t out_cap,
                      size_t *out_len) {
    if (ctx == NULL) {
        return NEO_MCU_ERR_INVALID;
    }
    uint64_t seq_id = ++ctx->shadow.next_tx_seq_id;
    return neo_mcu_build_res_seq(ctx, seq_id, ok, action, data, err_msg,
                                 out_wire, out_cap, out_len);
}

static void maybe_emit_err_res(neo_mcu_ctx_t *ctx,
                               uint64_t seq_id,
                               const char *action,
                               const char *err_msg,
                               uint8_t *out_res_wire,
                               size_t out_res_cap,
                               size_t *out_res_len) {
    if (out_res_wire != NULL && out_res_len != NULL) {
        size_t len = 0U;
        if (neo_mcu_build_res_seq(ctx, seq_id, false, action, NULL, err_msg,
                                  out_res_wire, out_res_cap, &len) == NEO_MCU_OK) {
            *out_res_len = len;
        } else {
            *out_res_len = 0U;
        }
    }
}

static int decode_param_map(neo_cbor_dec_t *dec, neo_param_set_t *out_params) {
    neo_cbor_type_t ptype;
    if (neo_cbor_dec_peek_type(dec, &ptype) != NEO_CBOR_OK) {
        return NEO_MCU_ERR_CBOR;
    }
    if (ptype == NEO_CBOR_NULL) {
        return neo_cbor_dec_null(dec) == NEO_CBOR_OK ? NEO_MCU_OK : NEO_MCU_ERR_CBOR;
    }
    if (ptype != NEO_CBOR_MAP) {
        return NEO_MCU_ERR_PARAM;
    }

    size_t count = 0U;
    if (neo_cbor_dec_map(dec, &count) != NEO_CBOR_OK) {
        return NEO_MCU_ERR_CBOR;
    }
    if (count > NEO_MCU_MAX_PARAMS) {
        return NEO_MCU_ERR_PARAM;
    }

    for (size_t i = 0U; i < count; i++) {
        const char *k = NULL;
        size_t klen = 0U;
        if (neo_cbor_dec_tstr(dec, &k, &klen) != NEO_CBOR_OK) {
            return NEO_MCU_ERR_CBOR;
        }

        neo_kv_t *kv = &out_params->items[out_params->count];
        if (safe_copy_slice(kv->name, sizeof(kv->name), k, klen) != NEO_MCU_OK) {
            return NEO_MCU_ERR_PARAM;
        }

        neo_cbor_type_t vtype;
        if (neo_cbor_dec_peek_type(dec, &vtype) != NEO_CBOR_OK) {
            return NEO_MCU_ERR_CBOR;
        }
        if (vtype == NEO_CBOR_UINT || vtype == NEO_CBOR_NEGINT) {
            int64_t iv = 0;
            if (neo_cbor_dec_int(dec, &iv) != NEO_CBOR_OK) {
                return NEO_MCU_ERR_PARAM;
            }
            kv->type = NEO_PARAM_INT;
            kv->val.i = iv;
        } else if (vtype == NEO_CBOR_BOOL) {
            bool bv = false;
            if (neo_cbor_dec_bool(dec, &bv) != NEO_CBOR_OK) {
                return NEO_MCU_ERR_PARAM;
            }
            kv->type = NEO_PARAM_BOOL;
            kv->val.b = bv;
        } else if (vtype == NEO_CBOR_TSTR) {
            const char *sv = NULL;
            size_t slen = 0U;
            if (neo_cbor_dec_tstr(dec, &sv, &slen) != NEO_CBOR_OK) {
                return NEO_MCU_ERR_CBOR;
            }
            if (safe_copy_slice(kv->val.s, sizeof(kv->val.s), sv, slen) != NEO_MCU_OK) {
                return NEO_MCU_ERR_PARAM;
            }
            kv->type = NEO_PARAM_TSTR;
        } else {
            return NEO_MCU_ERR_PARAM;
        }
        out_params->count++;
    }
    return NEO_MCU_OK;
}

static int decode_cmd_cbor(const uint8_t *cbor_bytes,
                           size_t cbor_len,
                           char *out_action,
                           size_t action_cap,
                           neo_param_set_t *out_params) {
    neo_cbor_dec_t dec;
    neo_cbor_dec_init(&dec, cbor_bytes, cbor_len);

    size_t map_len = 0U;
    if (neo_cbor_dec_map(&dec, &map_len) != NEO_CBOR_OK) {
        return NEO_MCU_ERR_CBOR;
    }

    bool got_t = false;
    bool got_a = false;
    neo_param_set_init(out_params);
    out_action[0] = '\0';

    for (size_t i = 0U; i < map_len; i++) {
        const char *key = NULL;
        size_t klen = 0U;
        if (neo_cbor_dec_tstr(&dec, &key, &klen) != NEO_CBOR_OK) {
            return NEO_MCU_ERR_CBOR;
        }

        if (neo_cbor_tstr_eq(key, klen, "t")) {
            const char *tv = NULL;
            size_t tlen = 0U;
            if (neo_cbor_dec_tstr(&dec, &tv, &tlen) != NEO_CBOR_OK) {
                return NEO_MCU_ERR_CBOR;
            }
            if (!neo_cbor_tstr_eq(tv, tlen, "cmd")) {
                return NEO_MCU_ERR_CBOR;
            }
            got_t = true;
        } else if (neo_cbor_tstr_eq(key, klen, "a")) {
            const char *av = NULL;
            size_t alen = 0U;
            if (neo_cbor_dec_tstr(&dec, &av, &alen) != NEO_CBOR_OK) {
                return NEO_MCU_ERR_CBOR;
            }
            if (alen == 0U || safe_copy_slice(out_action, action_cap, av, alen) != NEO_MCU_OK) {
                return NEO_MCU_ERR_CBOR;
            }
            got_a = true;
        } else if (neo_cbor_tstr_eq(key, klen, "p")) {
            int rc = decode_param_map(&dec, out_params);
            if (rc != NEO_MCU_OK) {
                return rc;
            }
        } else {
            if (neo_cbor_dec_skip(&dec) != NEO_CBOR_OK) {
                return NEO_MCU_ERR_CBOR;
            }
        }
    }

    if (!got_t || !got_a || dec.pos != dec.len) {
        return NEO_MCU_ERR_CBOR;
    }
    return NEO_MCU_OK;
}

static const neo_action_def_t *find_action(const neo_mcu_ctx_t *ctx, const char *name) {
    for (size_t i = 0U; i < ctx->action_count; i++) {
        if (ctx->actions[i].name != NULL && strcmp(ctx->actions[i].name, name) == 0) {
            return &ctx->actions[i];
        }
    }
    return NULL;
}

static int validate_action_params(const neo_action_def_t *act,
                                  const neo_param_set_t *params,
                                  char *err_buf,
                                  size_t err_cap) {
    for (size_t i = 0U; i < act->param_count; i++) {
        const neo_param_spec_t *spec = &act->params[i];
        const neo_kv_t *kv = neo_param_set_find(params, spec->name);
        if (kv == NULL) {
            if (spec->required) {
                safe_copy_str(err_buf, err_cap, "missing required parameter");
                return NEO_MCU_ERR_PARAM;
            }
            continue;
        }
        if (kv->type != spec->type) {
            safe_copy_str(err_buf, err_cap, "parameter type mismatch");
            return NEO_MCU_ERR_PARAM;
        }
        if (spec->type == NEO_PARAM_INT) {
            if (kv->val.i < spec->min || kv->val.i > spec->max) {
                safe_copy_str(err_buf, err_cap, "parameter out of bounds");
                return NEO_MCU_ERR_BOUNDS;
            }
        } else if (spec->type == NEO_PARAM_TSTR) {
            int64_t slen = (int64_t)strlen(kv->val.s);
            if (slen < spec->min || slen > spec->max) {
                safe_copy_str(err_buf, err_cap, "string parameter out of bounds");
                return NEO_MCU_ERR_BOUNDS;
            }
        }
    }
    return NEO_MCU_OK;
}

static int execute_validated_action(neo_mcu_ctx_t *ctx,
                                    uint64_t seq_id,
                                    const char *action_name,
                                    const neo_param_set_t *params,
                                    uint8_t *out_res_wire,
                                    size_t out_res_cap,
                                    size_t *out_res_len) {
    char err_buf[NEO_MCU_MAX_ERR_LEN];
    err_buf[0] = '\0';

    const neo_action_def_t *act = find_action(ctx, action_name);
    if (act == NULL) {
        maybe_emit_err_res(ctx, seq_id, action_name, "unknown action",
                           out_res_wire, out_res_cap, out_res_len);
        return NEO_MCU_ERR_UNKNOWN_ACTION;
    }

    if (act->risk == NEO_RISK_FORBIDDEN) {
        maybe_emit_err_res(ctx, seq_id, action_name, "action forbidden",
                           out_res_wire, out_res_cap, out_res_len);
        return NEO_MCU_ERR_FORBIDDEN;
    }

    int vrc = validate_action_params(act, params, err_buf, sizeof(err_buf));
    if (vrc != NEO_MCU_OK) {
        maybe_emit_err_res(ctx, seq_id, action_name, err_buf,
                           out_res_wire, out_res_cap, out_res_len);
        return vrc;
    }

    /* Record desired state in Device Shadow */
    ctx->shadow.desired.valid = true;
    ctx->shadow.desired.seq_id = seq_id;
    safe_copy_str(ctx->shadow.desired.action, sizeof(ctx->shadow.desired.action), action_name);
    ctx->shadow.desired.params = *params;

    if (act->handler == NULL) {
        maybe_emit_err_res(ctx, seq_id, action_name, "no action handler",
                           out_res_wire, out_res_cap, out_res_len);
        return NEO_MCU_ERR_EXEC;
    }

    neo_param_set_t out_data;
    neo_param_set_init(&out_data);
    int hrc = act->handler(ctx->user_data, params, &out_data, err_buf, sizeof(err_buf));
    if (hrc != 0) {
        if (err_buf[0] == '\0') {
            safe_copy_str(err_buf, sizeof(err_buf), "action execution failed");
        }
        if (out_res_wire != NULL && out_res_len != NULL) {
            size_t rlen = 0U;
            if (neo_mcu_build_res_seq(ctx, seq_id, false, action_name, &out_data, err_buf,
                                      out_res_wire, out_res_cap, &rlen) == NEO_MCU_OK) {
                *out_res_len = rlen;
            } else {
                *out_res_len = 0U;
            }
        }
        return NEO_MCU_ERR_EXEC;
    }

    /* Update reported state on successful execution */
    ctx->shadow.reported = ctx->shadow.desired;

    if (out_res_wire != NULL && out_res_len != NULL) {
        int brc = neo_mcu_build_res_seq(ctx, seq_id, true, action_name, &out_data, "",
                                        out_res_wire, out_res_cap, out_res_len);
        if (brc != NEO_MCU_OK) {
            return brc;
        }
    }
    return NEO_MCU_OK;
}

int neo_mcu_handle_downlink(neo_mcu_ctx_t *ctx,
                            const char *topic_cluster_id,
                            const char *topic_device_id,
                            const uint8_t *wire,
                            size_t wire_len,
                            uint8_t *out_res_wire,
                            size_t out_res_cap,
                            size_t *out_res_len) {
    if (out_res_len != NULL) {
        *out_res_len = 0U;
    }
    if (ctx == NULL || wire == NULL || wire_len < NEO_MCU_WIRE_HDR_SIZE) {
        return NEO_MCU_ERR_INVALID;
    }

    if (topic_cluster_id != NULL && strcmp(topic_cluster_id, ctx->cluster_id) != 0) {
        return NEO_MCU_ERR_CLUSTER;
    }
    if (topic_device_id != NULL && strcmp(topic_device_id, ctx->device_id) != 0) {
        return NEO_MCU_ERR_DEVICE;
    }

    uint64_t seq_id = neo_read_be64(wire);
    const uint8_t *mac = wire + 8U;
    const uint8_t *cbor_bytes = wire + NEO_MCU_WIRE_HDR_SIZE;
    size_t cbor_len = wire_len - NEO_MCU_WIRE_HDR_SIZE;

    /* Authenticate first: reject invalid/forged/cross-cluster MACs silently */
    if (!neo_mcu_verify_mac(ctx->mcu_key, ctx->cluster_id, ctx->device_id,
                            seq_id, cbor_bytes, cbor_len, mac)) {
        return NEO_MCU_ERR_MAC;
    }

    /* Enforce strictly monotonic seq_id against replay */
    if (seq_id <= ctx->shadow.last_rx_seq_id) {
        maybe_emit_err_res(ctx, seq_id, "", "replay rejected: non-monotonic seq_id",
                           out_res_wire, out_res_cap, out_res_len);
        return NEO_MCU_ERR_REPLAY;
    }
    ctx->shadow.last_rx_seq_id = seq_id;

    char action_name[NEO_MCU_MAX_ACTION_LEN];
    neo_param_set_t params;
    int drc = decode_cmd_cbor(cbor_bytes, cbor_len,
                              action_name, sizeof(action_name), &params);
    if (drc != NEO_MCU_OK) {
        maybe_emit_err_res(ctx, seq_id, action_name, "invalid command cbor",
                           out_res_wire, out_res_cap, out_res_len);
        return drc;
    }

    return execute_validated_action(ctx, seq_id, action_name, &params,
                                    out_res_wire, out_res_cap, out_res_len);
}

int neo_mcu_handle_uart_downlink(neo_mcu_ctx_t *ctx,
                                 const uint8_t *cobs_frame,
                                 size_t frame_len,
                                 uint8_t *out_cobs_frame,
                                 size_t out_cap,
                                 size_t *out_len) {
    if (out_len != NULL) {
        *out_len = 0U;
    }
    if (ctx == NULL || cobs_frame == NULL) {
        return NEO_MCU_ERR_INVALID;
    }

    char mcu_id[NEO_UART_MAX_ID_LEN + 1U];
    uint64_t seq_id = 0U;
    uint8_t mac[NEO_HMAC_SHA256_SIZE];
    uint8_t wire[NEO_MCU_WIRE_HDR_SIZE + NEO_MCU_TX_BUF_SIZE];
    size_t cbor_len = 0U;

    int rc = neo_uart_frame_decode(cobs_frame, frame_len,
                                   mcu_id, sizeof(mcu_id),
                                   &seq_id, mac,
                                   wire + NEO_MCU_WIRE_HDR_SIZE,
                                   NEO_MCU_TX_BUF_SIZE, &cbor_len);
    if (rc != NEO_CRYPTO_OK) {
        return rc == NEO_CRYPTO_ERR_CRC ? NEO_MCU_ERR_MAC : NEO_MCU_ERR_INVALID;
    }

    neo_write_be64(wire, seq_id);
    memcpy(wire + 8U, mac, NEO_HMAC_SHA256_SIZE);

    uint8_t res_wire[NEO_MCU_WIRE_HDR_SIZE + NEO_MCU_TX_BUF_SIZE];
    size_t res_len = 0U;
    int hrc = neo_mcu_handle_downlink(ctx, ctx->cluster_id, mcu_id,
                                      wire, NEO_MCU_WIRE_HDR_SIZE + cbor_len,
                                      res_wire, sizeof(res_wire), &res_len);

    if (out_cobs_frame != NULL && out_len != NULL && res_len >= NEO_MCU_WIRE_HDR_SIZE) {
        uint64_t res_seq = neo_read_be64(res_wire);
        const uint8_t *res_mac = res_wire + 8U;
        const uint8_t *res_cbor = res_wire + NEO_MCU_WIRE_HDR_SIZE;
        size_t res_cbor_len = res_len - NEO_MCU_WIRE_HDR_SIZE;
        int enc_rc = neo_uart_frame_encode(ctx->device_id, res_seq, res_mac,
                                           res_cbor, res_cbor_len,
                                           out_cobs_frame, out_cap, out_len);
        if (enc_rc != NEO_CRYPTO_OK) {
            return NEO_MCU_ERR_OVERFLOW;
        }
    }
    return hrc;
}

int neo_mcu_shadow_set_desired(neo_mcu_ctx_t *ctx,
                               uint64_t seq_id,
                               const char *action,
                               const neo_param_set_t *params) {
    if (ctx == NULL || action == NULL || action[0] == '\0' || seq_id == 0U) {
        return NEO_MCU_ERR_INVALID;
    }
    if (ctx->shadow.desired.valid && seq_id <= ctx->shadow.desired.seq_id) {
        ctx->shadow.idempotent_skip_count++;
        return NEO_MCU_ERR_REPLAY;
    }
    if (safe_copy_str(ctx->shadow.desired.action,
                      sizeof(ctx->shadow.desired.action), action) != NEO_MCU_OK) {
        return NEO_MCU_ERR_OVERFLOW;
    }
    if (params != NULL) {
        ctx->shadow.desired.params = *params;
    } else {
        neo_param_set_init(&ctx->shadow.desired.params);
    }
    ctx->shadow.desired.seq_id = seq_id;
    ctx->shadow.desired.valid = true;
    return NEO_MCU_OK;
}

int neo_mcu_shadow_reconcile(neo_mcu_ctx_t *ctx,
                             uint8_t *out_res_wire,
                             size_t out_res_cap,
                             size_t *out_res_len) {
    if (out_res_len != NULL) {
        *out_res_len = 0U;
    }
    if (ctx == NULL) {
        return NEO_MCU_ERR_INVALID;
    }
    if (!ctx->shadow.desired.valid) {
        return NEO_MCU_OK;
    }
    if (ctx->shadow.reported.valid &&
        ctx->shadow.desired.seq_id <= ctx->shadow.reported.seq_id) {
        ctx->shadow.idempotent_skip_count++;
        return NEO_MCU_OK;
    }

    neo_shadow_entry_t desired_copy = ctx->shadow.desired;
    int rc = execute_validated_action(ctx,
                                      desired_copy.seq_id,
                                      desired_copy.action,
                                      &desired_copy.params,
                                      out_res_wire,
                                      out_res_cap,
                                      out_res_len);
    if (rc == NEO_MCU_OK) {
        if (desired_copy.seq_id > ctx->shadow.last_rx_seq_id) {
            ctx->shadow.last_rx_seq_id = desired_copy.seq_id;
        }
        ctx->shadow.reconcile_count++;
    }
    return rc;
}

int neo_mcu_ota_init(neo_ota_state_t *ota, uint8_t active_slot, const char *active_fw) {
    if (ota == NULL || active_slot > 1U || active_fw == NULL) {
        return NEO_MCU_ERR_INVALID;
    }
    memset(ota, 0, sizeof(*ota));
    ota->phase = NEO_OTA_IDLE;
    ota->active_slot = active_slot;
    ota->staging_slot = (uint8_t)(1U - active_slot);
    ota->prev_slot = active_slot;
    return safe_copy_str(ota->active_fw, sizeof(ota->active_fw), active_fw);
}

int neo_mcu_ota_begin(neo_ota_state_t *ota,
                      const char *new_fw,
                      uint32_t total_size,
                      const uint8_t expected_sha256[NEO_SHA256_DIGEST_SIZE]) {
    if (ota == NULL || new_fw == NULL || total_size == 0U || expected_sha256 == NULL) {
        return NEO_MCU_ERR_INVALID;
    }
    if (ota->phase == NEO_OTA_PENDING_BOOT || ota->rollback_pending) {
        return NEO_MCU_ERR_OTA_STATE;
    }
    if (safe_copy_str(ota->pending_fw, sizeof(ota->pending_fw), new_fw) != NEO_MCU_OK) {
        return NEO_MCU_ERR_OVERFLOW;
    }
    ota->staging_slot = (uint8_t)(1U - ota->active_slot);
    ota->expected_size = total_size;
    ota->received_size = 0U;
    memcpy(ota->expected_sha256, expected_sha256, NEO_SHA256_DIGEST_SIZE);
    memset(ota->actual_sha256, 0, NEO_SHA256_DIGEST_SIZE);
    neo_sha256_init(&ota->sha_ctx);
    ota->phase = NEO_OTA_STAGING;
    return NEO_MCU_OK;
}

int neo_mcu_ota_write(neo_ota_state_t *ota,
                      uint32_t offset,
                      const uint8_t *chunk,
                      size_t len) {
    if (ota == NULL || (chunk == NULL && len > 0U)) {
        return NEO_MCU_ERR_INVALID;
    }
    if (ota->phase != NEO_OTA_STAGING) {
        return NEO_MCU_ERR_OTA_STATE;
    }
    if (offset != ota->received_size) {
        return NEO_MCU_ERR_OTA_STATE;
    }
    if (len > (size_t)(ota->expected_size - ota->received_size)) {
        return NEO_MCU_ERR_OVERFLOW;
    }
    if (len > 0U) {
        neo_sha256_update(&ota->sha_ctx, chunk, len);
        ota->received_size += (uint32_t)len;
    }
    return NEO_MCU_OK;
}

int neo_mcu_ota_finalize(neo_ota_state_t *ota) {
    if (ota == NULL) {
        return NEO_MCU_ERR_INVALID;
    }
    if (ota->phase != NEO_OTA_STAGING || ota->received_size != ota->expected_size) {
        return NEO_MCU_ERR_OTA_STATE;
    }
    neo_sha256_final(&ota->sha_ctx, ota->actual_sha256);
    if (!neo_ct_equal(ota->actual_sha256, ota->expected_sha256, NEO_SHA256_DIGEST_SIZE)) {
        ota->phase = NEO_OTA_IDLE;
        return NEO_MCU_ERR_OTA_HASH;
    }
    ota->phase = NEO_OTA_STAGED;
    return NEO_MCU_OK;
}

int neo_mcu_ota_activate(neo_ota_state_t *ota) {
    if (ota == NULL) {
        return NEO_MCU_ERR_INVALID;
    }
    if (ota->phase != NEO_OTA_STAGED) {
        return NEO_MCU_ERR_OTA_STATE;
    }
    ota->prev_slot = ota->active_slot;
    safe_copy_str(ota->prev_fw, sizeof(ota->prev_fw), ota->active_fw);

    ota->active_slot = ota->staging_slot;
    ota->staging_slot = (uint8_t)(1U - ota->active_slot);
    safe_copy_str(ota->active_fw, sizeof(ota->active_fw), ota->pending_fw);
    ota->rollback_pending = true;
    ota->phase = NEO_OTA_PENDING_BOOT;
    return NEO_MCU_OK;
}

int neo_mcu_ota_boot_ok(neo_ota_state_t *ota) {
    if (ota == NULL) {
        return NEO_MCU_ERR_INVALID;
    }
    if (ota->phase != NEO_OTA_PENDING_BOOT && !ota->rollback_pending) {
        return NEO_MCU_ERR_OTA_STATE;
    }
    ota->rollback_pending = false;
    ota->phase = NEO_OTA_COMMITTED;
    return NEO_MCU_OK;
}

int neo_mcu_ota_rollback(neo_ota_state_t *ota) {
    if (ota == NULL) {
        return NEO_MCU_ERR_INVALID;
    }
    if (!ota->rollback_pending) {
        /* Boot already confirmed with boot_ok: rollback is a no-op */
        return NEO_MCU_OK;
    }
    ota->active_slot = ota->prev_slot;
    ota->staging_slot = (uint8_t)(1U - ota->active_slot);
    safe_copy_str(ota->active_fw, sizeof(ota->active_fw), ota->prev_fw);
    ota->rollback_pending = false;
    ota->phase = NEO_OTA_ROLLED_BACK;
    return NEO_MCU_OK;
}
