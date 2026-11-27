#ifndef NEO_MCU_H
#define NEO_MCU_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "neo_cbor.h"
#include "neo_crypto.h"

#ifdef __cplusplus
extern "C" {
#endif

#ifndef NEO_MCU_MAX_ID_LEN
#define NEO_MCU_MAX_ID_LEN     64U
#endif

#ifndef NEO_MCU_MAX_ACTION_LEN
#define NEO_MCU_MAX_ACTION_LEN 48U
#endif

#ifndef NEO_MCU_MAX_PARAMS
#define NEO_MCU_MAX_PARAMS     8U
#endif

#ifndef NEO_MCU_MAX_STR_VAL
#define NEO_MCU_MAX_STR_VAL    64U
#endif

#ifndef NEO_MCU_MAX_ERR_LEN
#define NEO_MCU_MAX_ERR_LEN    96U
#endif

#ifndef NEO_MCU_TX_BUF_SIZE
#define NEO_MCU_TX_BUF_SIZE    1024U
#endif

#define NEO_MCU_WIRE_HDR_SIZE  40U /* seq_id(8B BE) || e2e_mac(32B) */

#define NEO_MCU_OK                 0
#define NEO_MCU_ERR_INVALID       -1
#define NEO_MCU_ERR_MAC           -2
#define NEO_MCU_ERR_REPLAY        -3
#define NEO_MCU_ERR_CBOR          -4
#define NEO_MCU_ERR_UNKNOWN_ACTION -5
#define NEO_MCU_ERR_FORBIDDEN     -6
#define NEO_MCU_ERR_PARAM         -7
#define NEO_MCU_ERR_BOUNDS        -8
#define NEO_MCU_ERR_EXEC          -9
#define NEO_MCU_ERR_OVERFLOW      -10
#define NEO_MCU_ERR_CLUSTER       -11
#define NEO_MCU_ERR_DEVICE        -12
#define NEO_MCU_ERR_OTA_STATE     -13
#define NEO_MCU_ERR_OTA_HASH      -14

typedef enum {
    NEO_RISK_SAFE_AUTO = 0,
    NEO_RISK_CONFIRM_REQUIRED = 1,
    NEO_RISK_FORBIDDEN = 2
} neo_risk_level_t;

typedef enum {
    NEO_PARAM_INT = 0,
    NEO_PARAM_BOOL = 1,
    NEO_PARAM_TSTR = 2
} neo_param_type_t;

typedef struct {
    const char *name;
    neo_param_type_t type;
    int64_t min;
    int64_t max;
    bool required;
} neo_param_spec_t;

typedef struct {
    char name[NEO_MCU_MAX_ACTION_LEN];
    neo_param_type_t type;
    union {
        int64_t i;
        bool b;
        char s[NEO_MCU_MAX_STR_VAL];
    } val;
} neo_kv_t;

typedef struct {
    neo_kv_t items[NEO_MCU_MAX_PARAMS];
    size_t count;
} neo_param_set_t;

typedef int (*neo_action_fn_t)(void *user_data,
                               const neo_param_set_t *params,
                               neo_param_set_t *out_data,
                               char *err_buf,
                               size_t err_cap);

typedef struct {
    const char *name;
    neo_risk_level_t risk;
    const neo_param_spec_t *params;
    size_t param_count;
    neo_action_fn_t handler;
} neo_action_def_t;

#define NEO_PARAM_INT(pname, pmin, pmax, preq) \
    { (pname), NEO_PARAM_INT, (int64_t)(pmin), (int64_t)(pmax), (preq) }

#define NEO_PARAM_BOOL(pname, preq) \
    { (pname), NEO_PARAM_BOOL, 0, 1, (preq) }

#define NEO_PARAM_TSTR(pname, pmax_len, preq) \
    { (pname), NEO_PARAM_TSTR, 0, (int64_t)(pmax_len), (preq) }

#define NEO_ACTION_ENTRY(aname, arisk, aparams, aparam_count, ahandler) \
    { (aname), (arisk), (aparams), (aparam_count), (ahandler) }

#define NEO_ARRAY_LEN(arr) (sizeof(arr) / sizeof((arr)[0]))

/* Device Shadow (desired / reported + monotonic seq_id idempotency) */
typedef struct {
    bool valid;
    uint64_t seq_id;
    char action[NEO_MCU_MAX_ACTION_LEN];
    neo_param_set_t params;
} neo_shadow_entry_t;

typedef struct {
    neo_shadow_entry_t desired;
    neo_shadow_entry_t reported;
    uint64_t last_rx_seq_id;
    uint64_t next_tx_seq_id;
    uint32_t reconcile_count;
    uint32_t idempotent_skip_count;
} neo_mcu_shadow_t;

/* A/B OTA state machine */
typedef enum {
    NEO_OTA_IDLE = 0,
    NEO_OTA_STAGING = 1,
    NEO_OTA_STAGED = 2,
    NEO_OTA_PENDING_BOOT = 3,
    NEO_OTA_COMMITTED = 4,
    NEO_OTA_ROLLED_BACK = 5
} neo_ota_phase_t;

typedef struct {
    neo_ota_phase_t phase;
    uint8_t active_slot;   /* 0 = A, 1 = B */
    uint8_t staging_slot;  /* 1 - active_slot */
    uint8_t prev_slot;     /* slot before pending boot */
    bool rollback_pending; /* true after activate until boot_ok */
    uint32_t expected_size;
    uint32_t received_size;
    uint8_t expected_sha256[NEO_SHA256_DIGEST_SIZE];
    uint8_t actual_sha256[NEO_SHA256_DIGEST_SIZE];
    neo_sha256_ctx_t sha_ctx;
    char active_fw[32];
    char pending_fw[32];
    char prev_fw[32];
} neo_ota_state_t;

/* Static memory pool context for a Tier 2 MCU node (zero heap allocation) */
typedef struct {
    char cluster_id[NEO_MCU_MAX_ID_LEN];
    char device_id[NEO_MCU_MAX_ID_LEN];
    char chip[32];
    char fw_version[32];
    uint8_t mcu_key[NEO_SHA256_DIGEST_SIZE];
    const neo_action_def_t *actions;
    size_t action_count;
    void *user_data;
    neo_mcu_shadow_t shadow;
    neo_ota_state_t ota;
    uint8_t tx_scratch[NEO_MCU_TX_BUF_SIZE];
} neo_mcu_ctx_t;

/* Initialize static MCU context and derive mcu_key. */
int neo_mcu_init(neo_mcu_ctx_t *ctx,
                 const char *cluster_id,
                 const char *device_id,
                 const char *e2e_master_secret,
                 const char *chip,
                 const char *fw_version,
                 const neo_action_def_t *actions,
                 size_t action_count,
                 void *user_data);

/* Parameter helper functions */
void neo_param_set_init(neo_param_set_t *set);
int neo_param_set_add_int(neo_param_set_t *set, const char *name, int64_t val);
int neo_param_set_add_bool(neo_param_set_t *set, const char *name, bool val);
int neo_param_set_add_tstr(neo_param_set_t *set, const char *name, const char *val);
const neo_kv_t *neo_param_set_find(const neo_param_set_t *set, const char *name);

/* Format MQTT topics: neo/<cluster_id>/mcu/<mcu_id>/{down,up} */
int neo_mcu_topic_down(const neo_mcu_ctx_t *ctx, char *out, size_t cap);
int neo_mcu_topic_up(const neo_mcu_ctx_t *ctx, char *out, size_t cap);

/* Build signed uplink binary frame: seq_id(8B BE) || e2e_mac(32B) || cbor_bytes */
int neo_mcu_build_hello(neo_mcu_ctx_t *ctx,
                        uint8_t *out_wire,
                        size_t out_cap,
                        size_t *out_len);

int neo_mcu_build_res(neo_mcu_ctx_t *ctx,
                      bool ok,
                      const char *action,
                      const neo_param_set_t *data,
                      const char *err_msg,
                      uint8_t *out_wire,
                      size_t out_cap,
                      size_t *out_len);

int neo_mcu_build_res_seq(neo_mcu_ctx_t *ctx,
                          uint64_t seq_id,
                          bool ok,
                          const char *action,
                          const neo_param_set_t *data,
                          const char *err_msg,
                          uint8_t *out_wire,
                          size_t out_cap,
                          size_t *out_len);

/*
 * Verify cluster_id/device_id/e2e_mac/seq_id, decode CBOR cmd, check static
 * action table and [min, max] bounds, execute handler, update shadow, and
 * optionally build signed uplink `res` wire frame in out_res_wire.
 */
int neo_mcu_handle_downlink(neo_mcu_ctx_t *ctx,
                            const char *topic_cluster_id,
                            const char *topic_device_id,
                            const uint8_t *wire,
                            size_t wire_len,
                            uint8_t *out_res_wire,
                            size_t out_res_cap,
                            size_t *out_res_len);

/* UART/RS485 COBS-framed downlink handler */
int neo_mcu_handle_uart_downlink(neo_mcu_ctx_t *ctx,
                                 const uint8_t *cobs_frame,
                                 size_t frame_len,
                                 uint8_t *out_cobs_frame,
                                 size_t out_cap,
                                 size_t *out_len);

/* Deep Sleep wake-pull shadow reconciliation (monotonic seq_id idempotency) */
int neo_mcu_shadow_set_desired(neo_mcu_ctx_t *ctx,
                               uint64_t seq_id,
                               const char *action,
                               const neo_param_set_t *params);

int neo_mcu_shadow_reconcile(neo_mcu_ctx_t *ctx,
                             uint8_t *out_res_wire,
                             size_t out_res_cap,
                             size_t *out_res_len);

/* A/B OTA state machine */
int neo_mcu_ota_init(neo_ota_state_t *ota, uint8_t active_slot, const char *active_fw);
int neo_mcu_ota_begin(neo_ota_state_t *ota,
                      const char *new_fw,
                      uint32_t total_size,
                      const uint8_t expected_sha256[NEO_SHA256_DIGEST_SIZE]);
int neo_mcu_ota_write(neo_ota_state_t *ota,
                      uint32_t offset,
                      const uint8_t *chunk,
                      size_t len);
int neo_mcu_ota_finalize(neo_ota_state_t *ota);
int neo_mcu_ota_activate(neo_ota_state_t *ota);
int neo_mcu_ota_boot_ok(neo_ota_state_t *ota);
int neo_mcu_ota_rollback(neo_ota_state_t *ota);

#ifdef __cplusplus
}
#endif

#endif /* NEO_MCU_H */
