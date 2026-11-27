#define _POSIX_C_SOURCE 200809L

#include "neo_mcu.h"

#include <errno.h>
#include <netdb.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

typedef struct {
    int fan_duty;
    int temp_c;
    int humidity;
} rack01_state_t;

static volatile sig_atomic_t g_running = 1;

static void handle_sig(int sig) {
    (void)sig;
    g_running = 0;
}

static int action_set_fan_pwm(void *user_data,
                              const neo_param_set_t *params,
                              neo_param_set_t *out_data,
                              char *err_buf,
                              size_t err_cap) {
    rack01_state_t *st = (rack01_state_t *)user_data;
    const neo_kv_t *duty_kv = neo_param_set_find(params, "duty");
    if (duty_kv == NULL || duty_kv->type != NEO_PARAM_INT) {
        snprintf(err_buf, err_cap, "missing duty parameter");
        return -1;
    }
    st->fan_duty = (int)duty_kv->val.i;
    neo_param_set_add_int(out_data, "duty", st->fan_duty);
    fprintf(stderr, "[mcu-sim] set_fan_pwm -> duty=%d%%\n", st->fan_duty);
    return 0;
}

static int action_read_dht22(void *user_data,
                             const neo_param_set_t *params,
                             neo_param_set_t *out_data,
                             char *err_buf,
                             size_t err_cap) {
    (void)params;
    (void)err_buf;
    (void)err_cap;
    rack01_state_t *st = (rack01_state_t *)user_data;
    neo_param_set_add_int(out_data, "temp_c", st->temp_c);
    neo_param_set_add_int(out_data, "humidity", st->humidity);
    fprintf(stderr, "[mcu-sim] read_dht22 -> temp_c=%d humidity=%d\n",
            st->temp_c, st->humidity);
    return 0;
}

static const neo_param_spec_t SET_FAN_PWM_PARAMS[] = {
    NEO_PARAM_INT("duty", 0, 100, true)
};

static const neo_action_def_t RACK01_ACTIONS[] = {
    NEO_ACTION_ENTRY("set_fan_pwm", NEO_RISK_CONFIRM_REQUIRED,
                     SET_FAN_PWM_PARAMS, NEO_ARRAY_LEN(SET_FAN_PWM_PARAMS),
                     action_set_fan_pwm),
    NEO_ACTION_ENTRY("read_dht22", NEO_RISK_SAFE_AUTO,
                     NULL, 0U,
                     action_read_dht22)
};

static int write_all(int fd, const uint8_t *buf, size_t len) {
    size_t sent = 0U;
    while (sent < len) {
        ssize_t n = write(fd, buf + sent, len - sent);
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            return -1;
        }
        sent += (size_t)n;
    }
    return 0;
}

static int read_exact(int fd, uint8_t *buf, size_t len) {
    size_t got = 0U;
    while (got < len) {
        ssize_t n = read(fd, buf + got, len - got);
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            return -1;
        }
        if (n == 0) {
            return -1;
        }
        got += (size_t)n;
    }
    return 0;
}

static int tcp_connect_host_port(const char *host, const char *port) {
    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;

    struct addrinfo *res = NULL;
    int gai = getaddrinfo(host, port, &hints, &res);
    if (gai != 0) {
        fprintf(stderr, "[mcu-sim] getaddrinfo(%s:%s): %s\n",
                host, port, gai_strerror(gai));
        return -1;
    }

    int fd = -1;
    for (struct addrinfo *p = res; p != NULL; p = p->ai_next) {
        fd = socket(p->ai_family, p->ai_socktype, p->ai_protocol);
        if (fd < 0) {
            continue;
        }
        if (connect(fd, p->ai_addr, p->ai_addrlen) == 0) {
            break;
        }
        close(fd);
        fd = -1;
    }
    freeaddrinfo(res);
    return fd;
}

static size_t mqtt_encode_rem_len(uint8_t out[4], size_t len) {
    size_t idx = 0U;
    do {
        uint8_t byte = (uint8_t)(len % 128U);
        len /= 128U;
        if (len > 0U) {
            byte |= 0x80U;
        }
        out[idx++] = byte;
    } while (len > 0U && idx < 4U);
    return idx;
}

static int mqtt_read_packet(int fd, uint8_t *out_hdr, uint8_t *buf, size_t cap, size_t *out_len) {
    uint8_t hdr = 0U;
    if (read_exact(fd, &hdr, 1U) != 0) {
        return -1;
    }
    size_t rem_len = 0U;
    size_t mult = 1U;
    for (int i = 0; i < 4; i++) {
        uint8_t b = 0U;
        if (read_exact(fd, &b, 1U) != 0) {
            return -1;
        }
        rem_len += (size_t)(b & 0x7FU) * mult;
        if ((b & 0x80U) == 0U) {
            break;
        }
        mult *= 128U;
        if (i == 3) {
            return -1;
        }
    }
    if (rem_len > cap) {
        return -1;
    }
    if (rem_len > 0U && read_exact(fd, buf, rem_len) != 0) {
        return -1;
    }
    *out_hdr = hdr;
    *out_len = rem_len;
    return 0;
}

static int mqtt_send_connect(int fd, const char *client_id, uint16_t keepalive) {
    size_t cid_len = strlen(client_id);
    if (cid_len > 128U) {
        return -1;
    }
    uint8_t pkt[256];
    size_t rem_len = 10U + 2U + cid_len;
    size_t pos = 0U;
    pkt[pos++] = 0x10U; /* CONNECT */
    pos += mqtt_encode_rem_len(pkt + pos, rem_len);
    /* Variable header: MQTT 3.1.1 */
    pkt[pos++] = 0x00U;
    pkt[pos++] = 0x04U;
    memcpy(pkt + pos, "MQTT", 4U);
    pos += 4U;
    pkt[pos++] = 0x04U; /* Protocol level 4 */
    pkt[pos++] = 0x02U; /* Clean session */
    pkt[pos++] = (uint8_t)(keepalive >> 8);
    pkt[pos++] = (uint8_t)(keepalive & 0xFFU);
    /* Client ID */
    pkt[pos++] = (uint8_t)(cid_len >> 8);
    pkt[pos++] = (uint8_t)(cid_len & 0xFFU);
    memcpy(pkt + pos, client_id, cid_len);
    pos += cid_len;
    return write_all(fd, pkt, pos);
}

static int mqtt_send_subscribe(int fd, uint16_t pid, const char *topic) {
    size_t tlen = strlen(topic);
    uint8_t pkt[512];
    if (2U + 2U + tlen + 1U + 5U > sizeof(pkt)) {
        return -1;
    }
    size_t rem_len = 2U + 2U + tlen + 1U;
    size_t pos = 0U;
    pkt[pos++] = 0x82U; /* SUBSCRIBE QoS 1 */
    pos += mqtt_encode_rem_len(pkt + pos, rem_len);
    pkt[pos++] = (uint8_t)(pid >> 8);
    pkt[pos++] = (uint8_t)(pid & 0xFFU);
    pkt[pos++] = (uint8_t)(tlen >> 8);
    pkt[pos++] = (uint8_t)(tlen & 0xFFU);
    memcpy(pkt + pos, topic, tlen);
    pos += tlen;
    pkt[pos++] = 0x00U; /* QoS 0 */
    return write_all(fd, pkt, pos);
}

static int mqtt_send_publish(int fd, const char *topic, const uint8_t *payload, size_t payload_len) {
    size_t tlen = strlen(topic);
    uint8_t pkt[2048];
    size_t rem_len = 2U + tlen + payload_len;
    if (1U + 4U + rem_len > sizeof(pkt)) {
        return -1;
    }
    size_t pos = 0U;
    pkt[pos++] = 0x30U; /* PUBLISH QoS 0 */
    pos += mqtt_encode_rem_len(pkt + pos, rem_len);
    pkt[pos++] = (uint8_t)(tlen >> 8);
    pkt[pos++] = (uint8_t)(tlen & 0xFFU);
    memcpy(pkt + pos, topic, tlen);
    pos += tlen;
    if (payload_len > 0U) {
        memcpy(pkt + pos, payload, payload_len);
        pos += payload_len;
    }
    return write_all(fd, pkt, pos);
}

static int mqtt_send_puback(int fd, uint16_t pid) {
    uint8_t pkt[4] = { 0x40U, 0x02U, (uint8_t)(pid >> 8), (uint8_t)(pid & 0xFFU) };
    return write_all(fd, pkt, sizeof(pkt));
}

static int mqtt_send_pingreq(int fd) {
    static const uint8_t pkt[2] = { 0xC0U, 0x00U };
    return write_all(fd, pkt, sizeof(pkt));
}

static int mqtt_send_pingresp(int fd) {
    static const uint8_t pkt[2] = { 0xD0U, 0x00U };
    return write_all(fd, pkt, sizeof(pkt));
}

/* Parse topic of form neo/<cluster_id>/mcu/<device_id>/down */
static int parse_down_topic(const char *topic, size_t tlen,
                            char *cluster_out, size_t cluster_cap,
                            char *dev_out, size_t dev_cap) {
    if (tlen < 11U || memcmp(topic, "neo/", 4U) != 0) {
        return -1;
    }
    const char *p = topic + 4U;
    const char *end = topic + tlen;
    const char *slash1 = memchr(p, '/', (size_t)(end - p));
    if (slash1 == NULL || slash1 == p) {
        return -1;
    }
    size_t clen = (size_t)(slash1 - p);
    if (clen >= cluster_cap) {
        return -1;
    }
    memcpy(cluster_out, p, clen);
    cluster_out[clen] = '\0';

    if ((size_t)(end - slash1) < 6U || memcmp(slash1, "/mcu/", 5U) != 0) {
        return -1;
    }
    const char *dev_start = slash1 + 5U;
    const char *slash2 = memchr(dev_start, '/', (size_t)(end - dev_start));
    if (slash2 == NULL || slash2 == dev_start) {
        return -1;
    }
    size_t dlen = (size_t)(slash2 - dev_start);
    if (dlen >= dev_cap) {
        return -1;
    }
    memcpy(dev_out, dev_start, dlen);
    dev_out[dlen] = '\0';

    if ((size_t)(end - slash2) != 5U || memcmp(slash2, "/down", 5U) != 0) {
        return -1;
    }
    return 0;
}

static void print_usage(const char *prog) {
    fprintf(stderr,
            "Usage: %s --broker <host:port> --cluster <id> --device-id <id> --e2e-key <secret> "
            "[--chip esp32s3] [--fw 1.0.0] [--keepalive 30]\n",
            prog);
}

int main(int argc, char **argv) {
    const char *broker = "127.0.0.1:1883";
    const char *cluster_id = NULL;
    const char *device_id = "mcu-esp32-rack01";
    const char *e2e_key = NULL;
    const char *chip = "esp32s3";
    const char *fw = "1.0.0";
    int keepalive = 30;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--broker") == 0 && i + 1 < argc) {
            broker = argv[++i];
        } else if (strcmp(argv[i], "--cluster") == 0 && i + 1 < argc) {
            cluster_id = argv[++i];
        } else if (strcmp(argv[i], "--device-id") == 0 && i + 1 < argc) {
            device_id = argv[++i];
        } else if (strcmp(argv[i], "--e2e-key") == 0 && i + 1 < argc) {
            e2e_key = argv[++i];
        } else if (strcmp(argv[i], "--chip") == 0 && i + 1 < argc) {
            chip = argv[++i];
        } else if (strcmp(argv[i], "--fw") == 0 && i + 1 < argc) {
            fw = argv[++i];
        } else if (strcmp(argv[i], "--keepalive") == 0 && i + 1 < argc) {
            keepalive = atoi(argv[++i]);
            if (keepalive < 5) {
                keepalive = 5;
            }
        } else if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            print_usage(argv[0]);
            return 0;
        } else {
            fprintf(stderr, "Unknown or incomplete argument: %s\n", argv[i]);
            print_usage(argv[0]);
            return 2;
        }
    }

    if (cluster_id == NULL || e2e_key == NULL) {
        fprintf(stderr, "Error: --cluster and --e2e-key are required.\n");
        print_usage(argv[0]);
        return 2;
    }

    char host[256];
    char port[16];
    const char *colon = strrchr(broker, ':');
    if (colon != NULL && colon != broker) {
        size_t hlen = (size_t)(colon - broker);
        if (hlen >= sizeof(host)) {
            fprintf(stderr, "Broker host too long\n");
            return 2;
        }
        memcpy(host, broker, hlen);
        host[hlen] = '\0';
        snprintf(port, sizeof(port), "%s", colon + 1);
    } else {
        snprintf(host, sizeof(host), "%s", broker);
        snprintf(port, sizeof(port), "1883");
    }

    signal(SIGPIPE, SIG_IGN);
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = handle_sig;
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);

    rack01_state_t hw_state = { .fan_duty = 0, .temp_c = 24, .humidity = 48 };
    neo_mcu_ctx_t ctx;
    if (neo_mcu_init(&ctx, cluster_id, device_id, e2e_key, chip, fw,
                     RACK01_ACTIONS, NEO_ARRAY_LEN(RACK01_ACTIONS), &hw_state) != NEO_MCU_OK) {
        fprintf(stderr, "neo_mcu_init failed\n");
        return 1;
    }

    char topic_down[256];
    char topic_up[256];
    neo_mcu_topic_down(&ctx, topic_down, sizeof(topic_down));
    neo_mcu_topic_up(&ctx, topic_up, sizeof(topic_up));

    while (g_running) {
        int fd = tcp_connect_host_port(host, port);
        if (fd < 0) {
            fprintf(stderr, "[mcu-sim] connect to %s:%s failed, retrying in 1s...\n", host, port);
            sleep(1);
            continue;
        }

        if (mqtt_send_connect(fd, device_id, (uint16_t)keepalive) != 0) {
            close(fd);
            sleep(1);
            continue;
        }

        uint8_t hdr = 0U;
        uint8_t pkt_buf[4096];
        size_t pkt_len = 0U;
        if (mqtt_read_packet(fd, &hdr, pkt_buf, sizeof(pkt_buf), &pkt_len) != 0 ||
            (hdr & 0xF0U) != 0x20U || pkt_len < 2U || pkt_buf[1] != 0x00U) {
            fprintf(stderr, "[mcu-sim] MQTT CONNACK failed\n");
            close(fd);
            sleep(1);
            continue;
        }

        if (mqtt_send_subscribe(fd, 1U, topic_down) != 0) {
            close(fd);
            sleep(1);
            continue;
        }
        if (mqtt_read_packet(fd, &hdr, pkt_buf, sizeof(pkt_buf), &pkt_len) != 0 ||
            (hdr & 0xF0U) != 0x90U) {
            fprintf(stderr, "[mcu-sim] MQTT SUBACK failed\n");
            close(fd);
            sleep(1);
            continue;
        }

        uint8_t hello_wire[1024];
        size_t hello_len = 0U;
        if (neo_mcu_build_hello(&ctx, hello_wire, sizeof(hello_wire), &hello_len) == NEO_MCU_OK) {
            if (mqtt_send_publish(fd, topic_up, hello_wire, hello_len) != 0) {
                close(fd);
                sleep(1);
                continue;
            }
        }

        printf("READY cluster=%s device=%s broker=%s:%s down=%s up=%s\n",
               cluster_id, device_id, host, port, topic_down, topic_up);
        fflush(stdout);

        time_t last_ping = time(NULL);
        while (g_running) {
            struct pollfd pfd = { .fd = fd, .events = POLLIN, .revents = 0 };
            int prc = poll(&pfd, 1, 1000);
            if (prc < 0) {
                if (errno == EINTR) {
                    continue;
                }
                break;
            }

            time_t now = time(NULL);
            if ((int)(now - last_ping) >= (keepalive / 2)) {
                if (mqtt_send_pingreq(fd) != 0) {
                    break;
                }
                last_ping = now;
            }

            if (prc == 0) {
                continue;
            }
            if (pfd.revents & (POLLERR | POLLHUP | POLLNVAL)) {
                break;
            }
            if (!(pfd.revents & POLLIN)) {
                continue;
            }

            if (mqtt_read_packet(fd, &hdr, pkt_buf, sizeof(pkt_buf), &pkt_len) != 0) {
                break;
            }
            uint8_t ptype = (uint8_t)(hdr & 0xF0U);
            if (ptype == 0xC0U) {
                mqtt_send_pingresp(fd);
                continue;
            }
            if (ptype == 0xD0U) {
                continue;
            }
            if (ptype == 0x30U) {
                if (pkt_len < 2U) {
                    continue;
                }
                size_t tlen = ((size_t)pkt_buf[0] << 8) | (size_t)pkt_buf[1];
                if (2U + tlen > pkt_len) {
                    continue;
                }
                const char *tptr = (const char *)(pkt_buf + 2U);
                size_t offset = 2U + tlen;
                uint8_t qos = (uint8_t)((hdr >> 1) & 0x03U);
                if (qos > 0U) {
                    if (offset + 2U > pkt_len) {
                        continue;
                    }
                    uint16_t pid = (uint16_t)(((uint16_t)pkt_buf[offset] << 8) | pkt_buf[offset + 1U]);
                    offset += 2U;
                    if (qos == 1U) {
                        mqtt_send_puback(fd, pid);
                    }
                }
                const uint8_t *payload = pkt_buf + offset;
                size_t payload_len = pkt_len - offset;

                char tcluster[NEO_MCU_MAX_ID_LEN];
                char tdev[NEO_MCU_MAX_ID_LEN];
                if (parse_down_topic(tptr, tlen, tcluster, sizeof(tcluster), tdev, sizeof(tdev)) != 0) {
                    continue;
                }

                uint8_t res_wire[1024];
                size_t res_len = 0U;
                int rc = neo_mcu_handle_downlink(&ctx, tcluster, tdev,
                                                 payload, payload_len,
                                                 res_wire, sizeof(res_wire), &res_len);
                if (rc != NEO_MCU_OK) {
                    fprintf(stderr, "[mcu-sim] downlink rejected (rc=%d)\n", rc);
                }
                if (res_len > 0U) {
                    if (mqtt_send_publish(fd, topic_up, res_wire, res_len) != 0) {
                        break;
                    }
                }
            }
        }
        close(fd);
        if (g_running) {
            sleep(1);
        }
    }

    fprintf(stderr, "[mcu-sim] shutdown\n");
    return 0;
}
