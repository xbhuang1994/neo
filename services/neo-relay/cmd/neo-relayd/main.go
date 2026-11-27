package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"neo-relay/internal/auth"
	"neo-relay/internal/enroll"
	"neo-relay/internal/hub"
	"neo-relay/internal/server"
	"neo-relay/internal/stun"
	"neo-relay/internal/ws"
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "token":
			if err := runTokenCmd(os.Args[2:]); err != nil {
				log.Fatalf("token error: %v", err)
			}
			return
		case "smoke":
			if err := runSmokeCmd(os.Args[2:]); err != nil {
				log.Fatalf("smoke error: %v", err)
			}
			return
		}
	}
	runDaemon()
}

func runDaemon() {
	listenAddr := envOr("NEO_RELAY_LISTEN", "0.0.0.0:18200")
	udpAddr := envOr("NEO_RELAY_UDP_LISTEN", "0.0.0.0:18444")
	publicURL := envOr("NEO_RELAY_PUBLIC_URL", "https://neo.1inch.cn:18443")
	stunRaw := envOr("NEO_RELAY_STUN_SERVERS", "neo.1inch.cn:18444")
	rateBPS := envInt64("NEO_RELAY_RATE_BPS", hub.DefaultNodeRateBPS)
	nodeBurst := envInt64("NEO_RELAY_NODE_BURST_BYTES", hub.DefaultNodeBurstBytes)
	clusterRateBPS := envInt64("NEO_RELAY_CLUSTER_RATE_BPS", hub.DefaultClusterRateBPS)
	clusterMaxPeers := int(envInt64("NEO_RELAY_CLUSTER_MAX_PEERS", int64(hub.DefaultMaxPeersPerCluster)))
	penaltyWinSec := envInt64("NEO_RELAY_PENALTY_WINDOW_SEC", 60)
	penaltyBytes := envInt64("NEO_RELAY_PENALTY_WINDOW_BYTES", hub.DefaultPenaltyThresholdBytes)
	penaltyRateBPS := envInt64("NEO_RELAY_PENALTY_RATE_BPS", hub.DefaultPenaltyRateBPS)
	penaltyDur := envDuration("NEO_RELAY_PENALTY_DURATION", hub.DefaultPenaltyDuration)
	maxFrame := int(envInt64("NEO_RELAY_MAX_FRAME_BYTES", 1<<20))
	punchTimeoutMs := int(envInt64("NEO_PUNCH_TIMEOUT_MS", 2500))
	dlCacheDir := envOr("NEO_RELAY_DL_CACHE_DIR", enroll.DefaultDLCacheDir)
	releaseBaseURL := envOr("NEO_RELAY_RELEASE_BASE_URL", enroll.DefaultReleaseBaseURL)
	githubAPIURL := envOr("NEO_RELAY_GITHUB_API_URL", enroll.DefaultGitHubAPIURL)
	agentVersion := strings.TrimSpace(os.Getenv("NEO_RELAY_AGENT_VERSION"))
	clusterSecretsFile := strings.TrimSpace(os.Getenv("NEO_RELAY_CLUSTER_SECRETS_FILE"))

	kr := loadKeyRing(clusterSecretsFile)
	var stunServers []string
	for _, s := range strings.Split(stunRaw, ",") {
		if t := strings.TrimSpace(s); t != "" {
			stunServers = append(stunServers, t)
		}
	}

	h := hub.NewWithConfig(hub.Limits{
		NodeRateBPS:           rateBPS,
		NodeBurstBytes:        nodeBurst,
		ClusterRateBPS:        clusterRateBPS,
		ClusterBurstBytes:     hub.DefaultClusterBurstBytes,
		MaxPeersPerCluster:    clusterMaxPeers,
		PenaltyWindow:         time.Duration(penaltyWinSec) * time.Second,
		PenaltyThresholdBytes: penaltyBytes,
		PenaltyRateBPS:        penaltyRateBPS,
		PenaltyBurstBytes:     hub.DefaultPenaltyBurstBytes,
		PenaltyDuration:       penaltyDur,
	})
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if udpAddr != "" && udpAddr != "off" {
		stunSrv, err := stun.ListenAndServe(ctx, udpAddr, kr.RootSecret, h.RecordUDP)
		if err != nil {
			log.Fatalf("failed to start UDP STUN/Probe on %s: %v", udpAddr, err)
		}
		log.Printf("neo-relayd UDP STUN/Probe listening on %s", stunSrv.Addr())
	}

	enrollStore := enroll.NewStore()
	enrollStore.StartGC(ctx, 5*time.Minute)

	mirror := enroll.NewMirror(enroll.MirrorConfig{
		CacheDir:       dlCacheDir,
		ReleaseBaseURL: releaseBaseURL,
		GitHubAPIURL:   githubAPIURL,
		AgentVersion:   agentVersion,
	})

	srv := server.New(server.Config{
		KeyRing:        kr,
		PublicURL:      publicURL,
		STUNServers:    stunServers,
		PunchTimeoutMs: punchTimeoutMs,
		MaxFrameBytes:  maxFrame,
		EnrollStore:    enrollStore,
		Mirror:         mirror,
	}, h)

	sighupCh := make(chan os.Signal, 1)
	signal.Notify(sighupCh, syscall.SIGHUP)
	defer signal.Stop(sighupCh)
	rootSecret := append([]byte(nil), kr.RootSecret...)
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-sighupCh:
				clusterSecrets, err := loadClusterSecretsMapStrict(clusterSecretsFile)
				if err != nil {
					log.Printf("WARNING: SIGHUP keyring reload failed (keeping existing keyring): %v", err)
					continue
				}
				srv.UpdateKeyRing(auth.KeyRing{
					RootSecret:     rootSecret,
					ClusterSecrets: clusterSecrets,
				})
				log.Printf("neo-relayd reloaded keyring via SIGHUP (clusters=%d)", len(clusterSecrets))
			}
		}
	}()

	httpSrv := &http.Server{
		Addr:              listenAddr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shCtx)
	}()

	log.Printf("neo-relayd HTTP/WS listening on %s (public_url=%s, dl_cache=%s, node_rate=%dB/s, penalty=%dB/%ds->%dB/s for %s)",
		listenAddr, publicURL, dlCacheDir, rateBPS, penaltyBytes, penaltyWinSec, penaltyRateBPS, penaltyDur)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("http server failed: %v", err)
	}
}

func runTokenCmd(args []string) error {
	fs := flag.NewFlagSet("token", flag.ExitOnError)
	clusterID := fs.String("cluster", "default", "master cluster_id for multi-master isolation")
	nodeID := fs.String("node", "", "target Neo node_id")
	tier := fs.String("tier", "os", "node tier: master|os|relay|admin")
	ttlStr := fs.String("ttl", "8760h", "token validity duration")
	secretFile := fs.String("secret-file", "", "path to env/secret file containing NEO_RELAY_SECRET")
	clusterSecretsFile := fs.String("cluster-secrets-file", "", "optional JSON map of per-cluster secrets")
	_ = fs.Parse(args)

	ttl, err := time.ParseDuration(*ttlStr)
	if err != nil {
		return err
	}
	kr := loadKeyRingFrom(*secretFile, *clusterSecretsFile)
	if len(kr.RootSecret) == 0 && len(kr.ClusterSecrets[*clusterID]) == 0 {
		return errors.New("missing NEO_RELAY_SECRET or --secret-file")
	}
	tok, err := auth.MintTokenWithKeyRing(kr, *clusterID, *nodeID, *tier, ttl, time.Now())
	if err != nil {
		return err
	}
	fmt.Println(tok)
	return nil
}

func runSmokeCmd(args []string) error {
	fs := flag.NewFlagSet("smoke", flag.ExitOnError)
	baseURL := fs.String("url", "https://neo.1inch.cn:18443", "base URL of neo-relay")
	secretFile := fs.String("secret-file", "/nvme/neo-relay/config/relay.env", "env file with NEO_RELAY_SECRET")
	_ = fs.Parse(args)

	secret := readSecretFromFile(*secretFile)
	if secret == "" {
		return errors.New("NEO_RELAY_SECRET not found in secret-file")
	}

	now := time.Now()
	tokAMaster, err := auth.MintToken([]byte(secret), "smoke-cluster-a", "smoke-master", "master", 2*time.Minute, now)
	if err != nil {
		return err
	}
	tokASBC, err := auth.MintToken([]byte(secret), "smoke-cluster-a", "smoke-sbc", "os", 2*time.Minute, now)
	if err != nil {
		return err
	}
	// Cluster B reuses the same node_id "smoke-sbc" plus an exclusive node "only-in-b" to verify isolation.
	tokBSBC, err := auth.MintToken([]byte(secret), "smoke-cluster-b", "smoke-sbc", "os", 2*time.Minute, now)
	if err != nil {
		return err
	}
	tokBOnly, err := auth.MintToken([]byte(secret), "smoke-cluster-b", "only-in-b", "os", 2*time.Minute, now)
	if err != nil {
		return err
	}

	httpClient := &http.Client{Timeout: 10 * time.Second}
	base := strings.TrimRight(*baseURL, "/")

	resp, err := httpClient.Get(base + "/healthz")
	if err != nil {
		return fmt.Errorf("healthz failed: %w", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("healthz status=%d", resp.StatusCode)
	}

	respUnauth, err := httpClient.Get(base + "/v1/peers")
	if err != nil {
		return err
	}
	_ = respUnauth.Body.Close()
	if respUnauth.StatusCode != 401 {
		return fmt.Errorf("expected 401 on unauth /v1/peers, got %d", respUnauth.StatusCode)
	}

	req, _ := http.NewRequest(http.MethodGet, base+"/v1/bootstrap", nil)
	req.Header.Set("Authorization", "Bearer "+tokAMaster)
	respBoot, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	bootBody, _ := io.ReadAll(respBoot.Body)
	_ = respBoot.Body.Close()
	if respBoot.StatusCode != 200 {
		return fmt.Errorf("bootstrap status=%d body=%s", respBoot.StatusCode, string(bootBody))
	}
	var boot struct {
		ClusterID string `json:"cluster_id"`
		SignalURL string `json:"signal_url"`
		RelayURL  string `json:"relay_url"`
	}
	if err := json.Unmarshal(bootBody, &boot); err != nil {
		return err
	}
	if boot.ClusterID != "smoke-cluster-a" {
		return fmt.Errorf("unexpected cluster_id: %q", boot.ClusterID)
	}

	// Same-cluster signaling + punch
	hAM := http.Header{"Authorization": []string{"Bearer " + tokAMaster}}
	hAS := http.Header{"Authorization": []string{"Bearer " + tokASBC}}
	hBS := http.Header{"Authorization": []string{"Bearer " + tokBSBC}}
	hBO := http.Header{"Authorization": []string{"Bearer " + tokBOnly}}

	sigAM, _, err := ws.Dial(boot.SignalURL, hAM, nil, 10*time.Second)
	if err != nil {
		return fmt.Errorf("dial signal A master: %w", err)
	}
	defer sigAM.Close()
	sigAS, _, err := ws.Dial(boot.SignalURL, hAS, nil, 10*time.Second)
	if err != nil {
		return fmt.Errorf("dial signal A sbc: %w", err)
	}
	defer sigAS.Close()
	sigBS, _, err := ws.Dial(boot.SignalURL, hBS, nil, 10*time.Second)
	if err != nil {
		return fmt.Errorf("dial signal B sbc: %w", err)
	}
	defer sigBS.Close()
	sigBO, _, err := ws.Dial(boot.SignalURL, hBO, nil, 10*time.Second)
	if err != nil {
		return fmt.Errorf("dial signal B only: %w", err)
	}
	defer sigBO.Close()

	_, _, _ = sigAM.ReadMessage()
	_, _, _ = sigAS.ReadMessage()
	_, _, _ = sigBS.ReadMessage()
	_, _, _ = sigBO.ReadMessage()

	// Cross-cluster p2p_initiate must be blocked as peer_signal_offline
	crossInit, _ := json.Marshal(hub.SignalMsg{
		Type:      "p2p_initiate",
		To:        "only-in-b",
		SessionID: "cross1",
	})
	if err := sigAM.WriteText(crossInit); err != nil {
		return err
	}
	_, crossRespRaw, err := sigAM.ReadMessage()
	if err != nil {
		return err
	}
	var crossResp hub.SignalMsg
	if err := json.Unmarshal(crossRespRaw, &crossResp); err != nil || crossResp.Type != "p2p_unavailable" {
		return fmt.Errorf("expected cross-cluster p2p_unavailable, got %s", string(crossRespRaw))
	}

	// Same-cluster p2p_initiate -> p2p_punch
	initPayload, _ := json.Marshal(hub.SignalMsg{
		Type:         "p2p_initiate",
		To:           "smoke-sbc",
		SessionID:    "s1",
		ReflexiveUDP: "10.0.0.1:41000",
	})
	if err := sigAM.WriteText(initPayload); err != nil {
		return err
	}
	_, offerRaw, err := sigAS.ReadMessage()
	if err != nil {
		return err
	}
	var offer hub.SignalMsg
	if err := json.Unmarshal(offerRaw, &offer); err != nil || offer.Type != "p2p_offer" {
		return fmt.Errorf("expected p2p_offer, got %s", string(offerRaw))
	}
	ansPayload, _ := json.Marshal(hub.SignalMsg{
		Type:         "p2p_answer",
		To:           "smoke-master",
		SessionID:    "s1",
		ReflexiveUDP: "10.0.0.2:42000",
	})
	if err := sigAS.WriteText(ansPayload); err != nil {
		return err
	}
	var gotPunchA, gotPunchB bool
	for i := 0; i < 3 && !gotPunchA; i++ {
		_, m, err := sigAM.ReadMessage()
		if err != nil {
			return err
		}
		var sm hub.SignalMsg
		if json.Unmarshal(m, &sm) == nil && sm.Type == "p2p_punch" {
			gotPunchA = true
		}
	}
	_, mB, err := sigAS.ReadMessage()
	if err != nil {
		return err
	}
	var smB hub.SignalMsg
	if json.Unmarshal(mB, &smB) == nil && smB.Type == "p2p_punch" {
		gotPunchB = true
	}
	if !gotPunchA || !gotPunchB {
		return fmt.Errorf("missing p2p_punch (A=%v B=%v)", gotPunchA, gotPunchB)
	}

	// Binary Relay WSS + cross-cluster blocking
	relAM, _, err := ws.Dial(boot.RelayURL, hAM, nil, 10*time.Second)
	if err != nil {
		return fmt.Errorf("dial relay A master: %w", err)
	}
	defer relAM.Close()
	relAS, _, err := ws.Dial(boot.RelayURL, hAS, nil, 10*time.Second)
	if err != nil {
		return fmt.Errorf("dial relay A sbc: %w", err)
	}
	defer relAS.Close()
	relBO, _, err := ws.Dial(boot.RelayURL, hBO, nil, 10*time.Second)
	if err != nil {
		return fmt.Errorf("dial relay B only: %w", err)
	}
	defer relBO.Close()

	// Verify /v1/peers for cluster A never leaks only-in-b
	reqPeers, _ := http.NewRequest(http.MethodGet, base+"/v1/peers", nil)
	reqPeers.Header.Set("Authorization", "Bearer "+tokAMaster)
	rPeers, err := httpClient.Do(reqPeers)
	if err != nil {
		return err
	}
	peersBody, _ := io.ReadAll(rPeers.Body)
	_ = rPeers.Body.Close()
	if strings.Contains(string(peersBody), "only-in-b") || strings.Contains(string(peersBody), "smoke-cluster-b") {
		return fmt.Errorf("cluster A peers leaked cluster B: %s", string(peersBody))
	}

	// Cross-cluster relay must return FlagErrOffline
	if err := relAM.WriteBinary(hub.EncodeRelayFrame(hub.RelayFrame{
		Flags:   hub.FlagData,
		SrcID:   "smoke-master",
		DstID:   "only-in-b",
		Payload: []byte("cross-cluster-probe"),
	})); err != nil {
		return err
	}
	_, crossRelRaw, err := relAM.ReadMessage()
	if err != nil {
		return err
	}
	crossRelFrame, _ := hub.DecodeRelayFrame(crossRelRaw)
	if crossRelFrame.Flags != hub.FlagErrOffline {
		return fmt.Errorf("expected FlagErrOffline on cross-cluster relay, got %x", crossRelFrame.Flags)
	}

	// Same-cluster opaque relay
	opaque := []byte("neo-e2e-ciphertext-test-payload")
	if err := relAM.WriteBinary(hub.EncodeRelayFrame(hub.RelayFrame{
		Flags:   hub.FlagData,
		SrcID:   "smoke-master",
		DstID:   "smoke-sbc",
		Payload: opaque,
	})); err != nil {
		return err
	}
	_, rawBin, err := relAS.ReadMessage()
	if err != nil {
		return err
	}
	decoded, err := hub.DecodeRelayFrame(rawBin)
	if err != nil || !bytes.Equal(decoded.Payload, opaque) {
		return fmt.Errorf("relay payload mismatch")
	}

	fmt.Printf("SMOKE_OK url=%s signal=%s relay=%s p2p_punch=ok binary_relay=ok isolation=ok\n", base, boot.SignalURL, boot.RelayURL)
	return nil
}

func loadKeyRing(clusterSecretsFile string) auth.KeyRing {
	secret := strings.TrimSpace(os.Getenv("NEO_RELAY_SECRET"))
	if secret == "" {
		var rnd [32]byte
		_, _ = rand.Read(rnd[:])
		log.Printf("WARNING: NEO_RELAY_SECRET not set; generated ephemeral secret for this run")
		secret = hex.EncodeToString(rnd[:])
	}
	return auth.KeyRing{
		RootSecret:     []byte(secret),
		ClusterSecrets: loadClusterSecretsMap(clusterSecretsFile),
	}
}

func loadKeyRingFrom(secretFile, clusterSecretsFile string) auth.KeyRing {
	secret := strings.TrimSpace(os.Getenv("NEO_RELAY_SECRET"))
	if secret == "" && secretFile != "" {
		secret = readSecretFromFile(secretFile)
	}
	return auth.KeyRing{
		RootSecret:     []byte(secret),
		ClusterSecrets: loadClusterSecretsMap(clusterSecretsFile),
	}
}

func loadClusterSecretsMap(path string) map[string][]byte {
	out, err := loadClusterSecretsMapStrict(path)
	if err != nil {
		log.Printf("WARNING: failed to load cluster secrets file %q: %v", path, err)
		return nil
	}
	return out
}

func loadClusterSecretsMapStrict(path string) (map[string][]byte, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var raw map[string]string
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, err
	}
	out := make(map[string][]byte, len(raw))
	for k, v := range raw {
		if strings.TrimSpace(v) != "" {
			out[k] = []byte(v)
		}
	}
	return out, nil
}

func readSecretFromFile(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "NEO_RELAY_SECRET=") {
			return strings.TrimPrefix(line, "NEO_RELAY_SECRET=")
		}
	}
	return strings.TrimSpace(string(b))
}

func envOr(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func envInt64(k string, def int64) int64 {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}

func envDuration(k string, def time.Duration) time.Duration {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return def
}
