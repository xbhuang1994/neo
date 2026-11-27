package server_test

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"neo-relay/internal/auth"
	"neo-relay/internal/hub"
	"neo-relay/internal/server"
	"neo-relay/internal/stun"
	"neo-relay/internal/ws"
)

func TestAuthBootstrapPeersAndStats(t *testing.T) {
	secret := []byte("unit-test-secret-32-bytes-minimum!!")
	h := hub.New(10<<20, 1<<20)
	srv := server.New(server.Config{
		KeyRing:        auth.KeyRing{RootSecret: secret},
		PublicURL:      "https://neo.1inch.cn:18443",
		STUNServers:    []string{"neo.1inch.cn:18444"},
		PunchTimeoutMs: 2500,
		MaxFrameBytes:  1 << 20,
	}, h)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatalf("healthz err: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on healthz, got %d", resp.StatusCode)
	}

	for _, path := range []string{"/v1/bootstrap", "/v1/whoami", "/v1/peers", "/v1/stats"} {
		r, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatalf("get %s err: %v", path, err)
		}
		_ = r.Body.Close()
		if r.StatusCode != http.StatusUnauthorized {
			t.Fatalf("expected 401 on unauth %s, got %d", path, r.StatusCode)
		}
	}

	tok, err := auth.MintToken(secret, "personal", "master-neo", "master", time.Hour, time.Now())
	if err != nil {
		t.Fatalf("mint err: %v", err)
	}
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/v1/bootstrap", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rBoot, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("bootstrap err: %v", err)
	}
	defer rBoot.Body.Close()
	if rBoot.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on bootstrap, got %d", rBoot.StatusCode)
	}
	var boot map[string]any
	if err := json.NewDecoder(rBoot.Body).Decode(&boot); err != nil {
		t.Fatalf("decode boot err: %v", err)
	}
	if boot["cluster_id"] != "personal" {
		t.Fatalf("unexpected cluster_id: %v", boot["cluster_id"])
	}
	if boot["signal_url"] != "wss://neo.1inch.cn:18443/v1/signal" {
		t.Fatalf("unexpected signal_url: %v", boot["signal_url"])
	}
	if boot["relay_url"] != "wss://neo.1inch.cn:18443/v1/relay" {
		t.Fatalf("unexpected relay_url: %v", boot["relay_url"])
	}
}

func TestP2PSignalingAndBinaryRelay(t *testing.T) {
	secret := []byte("unit-test-secret-32-bytes-minimum!!")
	h := hub.New(10<<20, 1<<20)
	srv := server.New(server.Config{
		KeyRing:       auth.KeyRing{RootSecret: secret},
		MaxFrameBytes: 1 << 20,
	}, h)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	wsBase := "ws" + strings.TrimPrefix(ts.URL, "http")
	tokMaster, _ := auth.MintToken(secret, "home-lab", "master-neo", "master", time.Hour, time.Now())
	tokSBC, _ := auth.MintToken(secret, "home-lab", "sbc-raspi5", "relay", time.Hour, time.Now())

	hdrMaster := http.Header{"Authorization": []string{"Bearer " + tokMaster}}
	hdrSBC := http.Header{"Authorization": []string{"Bearer " + tokSBC}}

	sigM, _, err := ws.Dial(wsBase+"/v1/signal", hdrMaster, nil, 5*time.Second)
	if err != nil {
		t.Fatalf("dial signal master: %v", err)
	}
	defer sigM.Close()
	sigS, _, err := ws.Dial(wsBase+"/v1/signal", hdrSBC, nil, 5*time.Second)
	if err != nil {
		t.Fatalf("dial signal sbc: %v", err)
	}
	defer sigS.Close()

	_, _, _ = sigM.ReadMessage()
	_, _, _ = sigS.ReadMessage()

	initMsg, _ := json.Marshal(hub.SignalMsg{
		Type:         "p2p_initiate",
		To:           "sbc-raspi5",
		SessionID:    "sess-42",
		LANAddrs:     []string{"10.100.0.95:40001"},
		ReflexiveUDP: "117.173.64.49:40001",
		NATType:      "cone",
	})
	if err := sigM.WriteText(initMsg); err != nil {
		t.Fatalf("write init: %v", err)
	}

	_, offerBytes, err := sigS.ReadMessage()
	if err != nil {
		t.Fatalf("read offer: %v", err)
	}
	var offer hub.SignalMsg
	if err := json.Unmarshal(offerBytes, &offer); err != nil || offer.Type != "p2p_offer" || offer.From != "master-neo" {
		t.Fatalf("unexpected offer: %s", string(offerBytes))
	}

	ansMsg, _ := json.Marshal(hub.SignalMsg{
		Type:         "p2p_answer",
		To:           "master-neo",
		SessionID:    "sess-42",
		LANAddrs:     []string{"192.168.1.50:40002"},
		ReflexiveUDP: "203.0.113.10:40002",
	})
	if err := sigS.WriteText(ansMsg); err != nil {
		t.Fatalf("write answer: %v", err)
	}

	var punchM, punchS hub.SignalMsg
	for i := 0; i < 2; i++ {
		_, b, err := sigM.ReadMessage()
		if err != nil {
			t.Fatalf("master read %d err: %v", i, err)
		}
		var m hub.SignalMsg
		_ = json.Unmarshal(b, &m)
		if m.Type == "p2p_punch" {
			punchM = m
		}
	}
	_, bS, err := sigS.ReadMessage()
	if err != nil {
		t.Fatalf("sbc read punch err: %v", err)
	}
	_ = json.Unmarshal(bS, &punchS)

	if punchM.Type != "p2p_punch" || punchS.Type != "p2p_punch" || punchM.PunchAtMs != punchS.PunchAtMs {
		t.Fatalf("synchronized punch mismatch: M=%+v S=%+v", punchM, punchS)
	}

	relM, _, err := ws.Dial(wsBase+"/v1/relay", hdrMaster, nil, 5*time.Second)
	if err != nil {
		t.Fatalf("dial relay master: %v", err)
	}
	defer relM.Close()
	relS, _, err := ws.Dial(wsBase+"/v1/relay", hdrSBC, nil, 5*time.Second)
	if err != nil {
		t.Fatalf("dial relay sbc: %v", err)
	}
	defer relS.Close()

	// Spoofed src_id must be rejected
	if err := relM.WriteBinary(hub.EncodeRelayFrame(hub.RelayFrame{
		Flags:   hub.FlagData,
		SrcID:   "evil-impersonator",
		DstID:   "sbc-raspi5",
		Payload: []byte("spoof"),
	})); err != nil {
		t.Fatalf("write spoof err: %v", err)
	}
	_, spoofRespRaw, err := relM.ReadMessage()
	if err != nil {
		t.Fatalf("read spoof resp: %v", err)
	}
	spoofResp, _ := hub.DecodeRelayFrame(spoofRespRaw)
	if spoofResp.Flags != hub.FlagErrSpoofed {
		t.Fatalf("expected FlagErrSpoofed, got %x", spoofResp.Flags)
	}

	cipher := []byte("opaque-e2e-ciphertext-123456")
	if err := relM.WriteBinary(hub.EncodeRelayFrame(hub.RelayFrame{
		Flags:   hub.FlagData,
		SrcID:   "master-neo",
		DstID:   "sbc-raspi5",
		Payload: cipher,
	})); err != nil {
		t.Fatalf("write data err: %v", err)
	}
	_, gotRaw, err := relS.ReadMessage()
	if err != nil {
		t.Fatalf("read relayed frame err: %v", err)
	}
	gotFrame, err := hub.DecodeRelayFrame(gotRaw)
	if err != nil || !bytes.Equal(gotFrame.Payload, cipher) || gotFrame.SrcID != "master-neo" {
		t.Fatalf("unexpected relayed frame: %+v err=%v", gotFrame, err)
	}

	if err := relM.WriteBinary(hub.EncodeRelayFrame(hub.RelayFrame{
		Flags:   hub.FlagData,
		SrcID:   "master-neo",
		DstID:   "ghost-node",
		Payload: []byte("hi"),
	})); err != nil {
		t.Fatalf("write offline err: %v", err)
	}
	_, offRaw, err := relM.ReadMessage()
	if err != nil {
		t.Fatalf("read offline resp err: %v", err)
	}
	offFrame, _ := hub.DecodeRelayFrame(offRaw)
	if offFrame.Flags != hub.FlagErrOffline {
		t.Fatalf("expected FlagErrOffline, got %x", offFrame.Flags)
	}
}

func TestMultiMasterClusterIsolation(t *testing.T) {
	kr := auth.KeyRing{
		RootSecret: []byte("root-secret-for-default-clusters!!"),
		ClusterSecrets: map[string][]byte{
			"cluster-beta": []byte("independent-beta-secret-32-bytes!!"),
		},
	}
	h := hub.NewWithLimits(10<<20, 1<<20, 10<<20, 64)
	srv := server.New(server.Config{
		KeyRing:       kr,
		MaxFrameBytes: 1 << 20,
	}, h)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	wsBase := "ws" + strings.TrimPrefix(ts.URL, "http")

	tokA1, _ := auth.MintTokenWithKeyRing(kr, "cluster-alpha", "master-neo", "master", time.Hour, time.Now())
	tokA2, _ := auth.MintTokenWithKeyRing(kr, "cluster-alpha", "sbc-raspi5", "os", time.Hour, time.Now())
	// Cluster B has BOTH an identically named "sbc-raspi5" AND an exclusive "corp-erp-win"
	tokB1, _ := auth.MintTokenWithKeyRing(kr, "cluster-beta", "sbc-raspi5", "os", time.Hour, time.Now())
	tokB2, _ := auth.MintTokenWithKeyRing(kr, "cluster-beta", "corp-erp-win", "os", time.Hour, time.Now())
	tokAdmin, _ := auth.MintTokenWithKeyRing(kr, "*", "ops-audit", "admin", time.Hour, time.Now())

	// Wrong secret (root secret cannot forge cluster-beta token)
	badBetaTok, _ := auth.MintToken(kr.RootSecret, "cluster-beta", "attacker", "master", time.Hour, time.Now())
	reqBad, _ := http.NewRequest(http.MethodGet, ts.URL+"/v1/peers", nil)
	reqBad.Header.Set("Authorization", "Bearer "+badBetaTok)
	rBad, err := http.DefaultClient.Do(reqBad)
	if err != nil {
		t.Fatalf("bad token req err: %v", err)
	}
	_ = rBad.Body.Close()
	if rBad.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 for wrong cluster key, got %d", rBad.StatusCode)
	}

	hA1 := http.Header{"Authorization": []string{"Bearer " + tokA1}}
	hA2 := http.Header{"Authorization": []string{"Bearer " + tokA2}}
	hB1 := http.Header{"Authorization": []string{"Bearer " + tokB1}}
	hB2 := http.Header{"Authorization": []string{"Bearer " + tokB2}}

	// Connect signaling & relay for both clusters with colliding node_id "sbc-raspi5"
	sigA1, _, err := ws.Dial(wsBase+"/v1/signal", hA1, nil, 5*time.Second)
	if err != nil {
		t.Fatalf("sigA1: %v", err)
	}
	defer sigA1.Close()
	sigA2, _, err := ws.Dial(wsBase+"/v1/signal", hA2, nil, 5*time.Second)
	if err != nil {
		t.Fatalf("sigA2: %v", err)
	}
	defer sigA2.Close()
	sigB1, _, err := ws.Dial(wsBase+"/v1/signal", hB1, nil, 5*time.Second)
	if err != nil {
		t.Fatalf("sigB1: %v", err)
	}
	defer sigB1.Close()
	sigB2, _, err := ws.Dial(wsBase+"/v1/signal", hB2, nil, 5*time.Second)
	if err != nil {
		t.Fatalf("sigB2: %v", err)
	}
	defer sigB2.Close()
	_, _, _ = sigA1.ReadMessage()
	_, _, _ = sigA2.ReadMessage()
	_, _, _ = sigB1.ReadMessage()
	_, _, _ = sigB2.ReadMessage()

	relA1, _, _ := ws.Dial(wsBase+"/v1/relay", hA1, nil, 5*time.Second)
	defer relA1.Close()
	relA2, _, _ := ws.Dial(wsBase+"/v1/relay", hA2, nil, 5*time.Second)
	defer relA2.Close()
	relB1, _, _ := ws.Dial(wsBase+"/v1/relay", hB1, nil, 5*time.Second)
	defer relB1.Close()
	relB2, _, _ := ws.Dial(wsBase+"/v1/relay", hB2, nil, 5*time.Second)
	defer relB2.Close()

	// 1. /v1/peers isolation: cluster-alpha sees 2 peers, never corp-erp-win; admin sees 4
	checkPeers := func(tok string, wantCount int, forbidSubstr string) {
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/v1/peers", nil)
		req.Header.Set("Authorization", "Bearer "+tok)
		r, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("peers err: %v", err)
		}
		defer r.Body.Close()
		var body struct {
			Count int            `json:"count"`
			Peers []hub.PeerInfo `json:"peers"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode peers: %v", err)
		}
		if body.Count != wantCount {
			t.Fatalf("expected %d peers, got %d (%+v)", wantCount, body.Count, body.Peers)
		}
		if forbidSubstr != "" {
			for _, p := range body.Peers {
				if p.NodeID == forbidSubstr {
					t.Fatalf("peer list leaked cross-cluster node %s", forbidSubstr)
				}
			}
		}
	}
	checkPeers(tokA1, 2, "corp-erp-win")
	checkPeers(tokB1, 2, "master-neo")
	checkPeers(tokAdmin, 4, "")

	// 2. Cross-cluster p2p_initiate is blocked
	crossSig, _ := json.Marshal(hub.SignalMsg{Type: "p2p_initiate", To: "corp-erp-win", SessionID: "x1"})
	_ = sigA1.WriteText(crossSig)
	_, rawSigResp, err := sigA1.ReadMessage()
	if err != nil {
		t.Fatalf("read cross sig resp: %v", err)
	}
	var sm hub.SignalMsg
	_ = json.Unmarshal(rawSigResp, &sm)
	if sm.Type != "p2p_unavailable" {
		t.Fatalf("expected p2p_unavailable across clusters, got %s", string(rawSigResp))
	}

	// 3. Cross-cluster relay to "corp-erp-win" is blocked with FlagErrOffline
	_ = relA1.WriteBinary(hub.EncodeRelayFrame(hub.RelayFrame{
		Flags:   hub.FlagData,
		SrcID:   "master-neo",
		DstID:   "corp-erp-win",
		Payload: []byte("secret-steal"),
	}))
	_, rawCrossRel, err := relA1.ReadMessage()
	if err != nil {
		t.Fatalf("read cross rel resp: %v", err)
	}
	crossRel, _ := hub.DecodeRelayFrame(rawCrossRel)
	if crossRel.Flags != hub.FlagErrOffline {
		t.Fatalf("expected FlagErrOffline on cross-cluster relay, got %x", crossRel.Flags)
	}

	// 4. Same-name node "sbc-raspi5" in cluster-alpha receives cluster-alpha's frame, NOT cluster-beta's
	_ = relA1.WriteBinary(hub.EncodeRelayFrame(hub.RelayFrame{
		Flags:   hub.FlagData,
		SrcID:   "master-neo",
		DstID:   "sbc-raspi5",
		Payload: []byte("alpha-only"),
	}))
	_, rawAlphaGot, err := relA2.ReadMessage()
	if err != nil {
		t.Fatalf("relA2 read err: %v", err)
	}
	alphaGot, _ := hub.DecodeRelayFrame(rawAlphaGot)
	if string(alphaGot.Payload) != "alpha-only" {
		t.Fatalf("unexpected alpha payload: %q", string(alphaGot.Payload))
	}

	// Confirm cluster-beta's sbc-raspi5 did not receive alpha-only
	_ = relB1.SetReadDeadline(time.Now().Add(80 * time.Millisecond))
	if _, leaked, err := relB1.ReadMessage(); err == nil {
		t.Fatalf("cluster-beta sbc-raspi5 received leaked frame: %x", leaked)
	}
}

func TestSTUNBindingReflector(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var stunCount atomic.Int32
	srv, err := stun.ListenAndServe(ctx, "127.0.0.1:0", []byte("secret"), func(kind string) {
		if kind == "stun" {
			stunCount.Add(1)
		}
	})
	if err != nil {
		t.Fatalf("listen stun: %v", err)
	}
	defer srv.Close()

	conn, err := net.DialUDP("udp", nil, srv.Addr().(*net.UDPAddr))
	if err != nil {
		t.Fatalf("dial udp: %v", err)
	}
	defer conn.Close()

	req := make([]byte, 20)
	binary.BigEndian.PutUint16(req[0:2], 0x0001)
	binary.BigEndian.PutUint16(req[2:4], 0)
	binary.BigEndian.PutUint32(req[4:8], 0x2112A442)
	copy(req[8:20], []byte("123456789012"))

	if _, err := conn.Write(req); err != nil {
		t.Fatalf("write stun: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 128)
	n, err := conn.Read(buf)
	if err != nil {
		t.Fatalf("read stun resp: %v", err)
	}
	if n < 32 || binary.BigEndian.Uint16(buf[0:2]) != 0x0101 {
		t.Fatalf("invalid stun response len=%d type=%x", n, binary.BigEndian.Uint16(buf[0:2]))
	}
	xPort := binary.BigEndian.Uint16(buf[26:28])
	gotPort := int(xPort ^ 0x2112)
	localPort := conn.LocalAddr().(*net.UDPAddr).Port
	if gotPort != localPort {
		t.Fatalf("expected reflected port %d, got %d", localPort, gotPort)
	}
	if stunCount.Load() != 1 {
		t.Fatalf("expected stunCount=1, got %d", stunCount.Load())
	}
}

func TestPenaltyThrottleAndReconnectPersistence(t *testing.T) {
	secret := []byte("unit-test-secret-32-bytes-minimum!!")
	var clockMu sync.Mutex
	fakeNow := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	getNow := func() time.Time {
		clockMu.Lock()
		defer clockMu.Unlock()
		return fakeNow
	}
	advance := func(d time.Duration) {
		clockMu.Lock()
		fakeNow = fakeNow.Add(d)
		clockMu.Unlock()
	}

	h := hub.NewWithConfig(hub.Limits{
		NodeRateBPS:           5 << 20,   // 5 MiB/s
		NodeBurstBytes:        2 << 20,   // 2 MiB
		ClusterRateBPS:        20 << 20,  // 20 MiB/s
		ClusterBurstBytes:     4 << 20,   // 4 MiB
		MaxPeersPerCluster:    64,
		PenaltyWindow:         60 * time.Second,
		PenaltyThresholdBytes: 1000,      // small threshold for fast deterministic test
		PenaltyRateBPS:        128 << 10, // 128 KiB/s
		PenaltyBurstBytes:     512,
		PenaltyDuration:       1 * time.Hour,
	})
	h.SetClock(getNow)

	srv := server.New(server.Config{
		KeyRing:       auth.KeyRing{RootSecret: secret},
		MaxFrameBytes: 1 << 20,
	}, h)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	wsBase := "ws" + strings.TrimPrefix(ts.URL, "http")

	tokMaster, _ := auth.MintToken(secret, "c1", "master-neo", "master", 24*time.Hour, time.Now())
	tokHeavy, _ := auth.MintToken(secret, "c1", "heavy-node", "os", 24*time.Hour, time.Now())
	tokClean, _ := auth.MintToken(secret, "c1", "clean-node", "os", 24*time.Hour, time.Now())

	hM := http.Header{"Authorization": []string{"Bearer " + tokMaster}}
	hH := http.Header{"Authorization": []string{"Bearer " + tokHeavy}}
	hC := http.Header{"Authorization": []string{"Bearer " + tokClean}}

	relM, _, err := ws.Dial(wsBase+"/v1/relay", hM, nil, 5*time.Second)
	if err != nil {
		t.Fatalf("dial master: %v", err)
	}
	defer relM.Close()
	relH, _, err := ws.Dial(wsBase+"/v1/relay", hH, nil, 5*time.Second)
	if err != nil {
		t.Fatalf("dial heavy: %v", err)
	}
	relC, _, err := ws.Dial(wsBase+"/v1/relay", hC, nil, 5*time.Second)
	if err != nil {
		t.Fatalf("dial clean: %v", err)
	}
	defer relC.Close()

	// 1. Send 2 frames totaling > 1000 bytes within 1 min -> triggers 1h 128 KiB/s penalty
	bigPayload := bytes.Repeat([]byte("A"), 600)
	for i := 0; i < 2; i++ {
		if err := relH.WriteBinary(hub.EncodeRelayFrame(hub.RelayFrame{
			Flags:   hub.FlagData,
			SrcID:   "heavy-node",
			DstID:   "master-neo",
			Payload: bigPayload,
		})); err != nil {
			t.Fatalf("write heavy %d: %v", i, err)
		}
		if _, _, err := relM.ReadMessage(); err != nil {
			t.Fatalf("master read %d: %v", i, err)
		}
	}

	// 2. Immediately send another 600B (> PenaltyBurstBytes=512, token bucket reset to 0) -> FlagErrRate!
	if err := relH.WriteBinary(hub.EncodeRelayFrame(hub.RelayFrame{
		Flags:   hub.FlagData,
		SrcID:   "heavy-node",
		DstID:   "master-neo",
		Payload: bigPayload,
	})); err != nil {
		t.Fatalf("write throttled: %v", err)
	}
	_, rateRaw, err := relH.ReadMessage()
	if err != nil {
		t.Fatalf("read rate err: %v", err)
	}
	rateFrame, _ := hub.DecodeRelayFrame(rateRaw)
	if rateFrame.Flags != hub.FlagErrRate {
		t.Fatalf("expected FlagErrRate after penalty trigger, got %x", rateFrame.Flags)
	}

	// 3. Verify /v1/peers and /v1/stats show penalty active on heavy-node only
	checkPeer := func(nodeID string, wantThrottled bool, wantRate int64) {
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/v1/peers", nil)
		req.Header.Set("Authorization", "Bearer "+tokMaster)
		r, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("peers req: %v", err)
		}
		defer r.Body.Close()
		var body struct {
			Peers []hub.PeerInfo `json:"peers"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		for _, p := range body.Peers {
			if p.NodeID == nodeID {
				if p.Throttled != wantThrottled || p.EffectiveRateBPS != wantRate {
					t.Fatalf("node %s: got throttled=%v rate=%d, want throttled=%v rate=%d",
						nodeID, p.Throttled, p.EffectiveRateBPS, wantThrottled, wantRate)
				}
				return
			}
		}
		t.Fatalf("node %s not found in peers", nodeID)
	}
	checkPeer("heavy-node", true, 128<<10)
	checkPeer("clean-node", false, 5<<20)

	// 4. Disconnect and reconnect heavy-node: penalty MUST survive reconnect!
	_ = relH.Close()
	time.Sleep(30 * time.Millisecond)
	relH2, _, err := ws.Dial(wsBase+"/v1/relay", hH, nil, 5*time.Second)
	if err != nil {
		t.Fatalf("redial heavy: %v", err)
	}
	defer relH2.Close()
	checkPeer("heavy-node", true, 128<<10)

	// Clean node still transmits normally at 5 MiB/s
	if err := relC.WriteBinary(hub.EncodeRelayFrame(hub.RelayFrame{
		Flags:   hub.FlagData,
		SrcID:   "clean-node",
		DstID:   "master-neo",
		Payload: []byte("clean-ok"),
	})); err != nil {
		t.Fatalf("clean send: %v", err)
	}
	if _, gotC, err := relM.ReadMessage(); err != nil {
		t.Fatalf("master read clean: %v", err)
	} else {
		f, _ := hub.DecodeRelayFrame(gotC)
		if string(f.Payload) != "clean-ok" {
			t.Fatalf("unexpected clean payload: %q", string(f.Payload))
		}
	}

	// 5. Advance clock by 1h + 1s -> penalty expires automatically
	advance(1*time.Hour + time.Second)
	checkPeer("heavy-node", false, 5<<20)
}
