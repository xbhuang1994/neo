package server_test

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"neo-relay/internal/auth"
	"neo-relay/internal/enroll"
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

func TestEnrollTicketHTTPFlow(t *testing.T) {
	secret := []byte("unit-test-secret-32-bytes-minimum!!")
	var clockMu sync.Mutex
	fakeNow := time.Date(2026, 11, 27, 14, 0, 0, 0, time.UTC)
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

	store := enroll.NewStore()
	store.SetClock(getNow)

	h := hub.New(10<<20, 1<<20)
	srv := server.New(server.Config{
		KeyRing:       auth.KeyRing{RootSecret: secret},
		PublicURL:     "https://neo.1inch.cn:18443",
		MaxFrameBytes: 1 << 20,
		EnrollStore:   store,
	}, h)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	tokMasterA, _ := auth.MintToken(secret, "cluster-a", "master-a", "master", time.Hour, time.Now())
	tokMasterB, _ := auth.MintToken(secret, "cluster-b", "master-b", "master", time.Hour, time.Now())
	tokOSA, _ := auth.MintToken(secret, "cluster-a", "node-os-1", "os", time.Hour, time.Now())
	tokAdmin, _ := auth.MintToken(secret, "*", "admin-1", "admin", time.Hour, time.Now())

	doReq := func(method, path, token, xff string, body any) *http.Response {
		var rdr io.Reader
		if body != nil {
			b, err := json.Marshal(body)
			if err != nil {
				t.Fatalf("marshal req: %v", err)
			}
			rdr = bytes.NewReader(b)
		}
		req, err := http.NewRequest(method, ts.URL+path, rdr)
		if err != nil {
			t.Fatalf("new req: %v", err)
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if xff != "" {
			req.Header.Set("X-Forwarded-For", xff)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s err: %v", method, path, err)
		}
		return resp
	}

	// 1. Auth & tier enforcement: unauth -> 401, os -> 403, wildcard admin -> 403
	rUnauth := doReq(http.MethodPost, "/v1/enroll/tickets", "", "", map[string]any{"ticket_id": "unauth_001", "ciphertext_b64": "YWFh"})
	_ = rUnauth.Body.Close()
	if rUnauth.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauth create: got %d, want 401", rUnauth.StatusCode)
	}
	for name, tok := range map[string]string{"os": tokOSA, "admin-wildcard": tokAdmin} {
		r := doReq(http.MethodPost, "/v1/enroll/tickets", tok, "", map[string]any{"ticket_id": "forbid_001", "ciphertext_b64": "YWFh"})
		_ = r.Body.Close()
		if r.StatusCode != http.StatusForbidden {
			t.Fatalf("%s create: got %d, want 403", name, r.StatusCode)
		}
	}

	// 2. Oversized ciphertext -> 400, invalid ticket_id -> 400
	rBig := doReq(http.MethodPost, "/v1/enroll/tickets", tokMasterA, "", map[string]any{
		"ticket_id":      "oversize01",
		"ciphertext_b64": strings.Repeat("X", enroll.MaxCiphertextLen+1),
	})
	_ = rBig.Body.Close()
	if rBig.StatusCode != http.StatusBadRequest {
		t.Fatalf("oversized ciphertext: got %d, want 400", rBig.StatusCode)
	}
	rBadID := doReq(http.MethodPost, "/v1/enroll/tickets", tokMasterA, "", map[string]any{
		"ticket_id":      "bad!id",
		"ciphertext_b64": "YWFh",
	})
	_ = rBadID.Body.Close()
	if rBadID.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad ticket_id: got %d, want 400", rBadID.StatusCode)
	}

	// 3. Single-use create -> 201, cross-cluster status/delete -> 403, public claim -> 200 then 410
	rCreate := doReq(http.MethodPost, "/v1/enroll/tickets", tokMasterA, "", map[string]any{
		"ticket_id":      "ticket_one_01",
		"ciphertext_b64": "b3BhcXVlLWNpcGhlci0x",
		"ttl_sec":        300,
		"max_uses":       1,
	})
	if rCreate.StatusCode != http.StatusCreated {
		bodyBytes, _ := io.ReadAll(rCreate.Body)
		_ = rCreate.Body.Close()
		t.Fatalf("create single-use: got %d (%s), want 201", rCreate.StatusCode, string(bodyBytes))
	}
	var created enroll.CreateResponse
	_ = json.NewDecoder(rCreate.Body).Decode(&created)
	_ = rCreate.Body.Close()
	if created.TicketID != "ticket_one_01" || created.ClusterID != "cluster-a" || created.Status != "pending" || created.MaxUses != 1 || created.RemainingUses != 1 {
		t.Fatalf("unexpected create response: %+v", created)
	}

	// Cross-cluster 403 on status and delete
	rCrossStatus := doReq(http.MethodGet, "/v1/enroll/tickets/ticket_one_01/status", tokMasterB, "", nil)
	_ = rCrossStatus.Body.Close()
	if rCrossStatus.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-cluster status: got %d, want 403", rCrossStatus.StatusCode)
	}
	rCrossDel := doReq(http.MethodDelete, "/v1/enroll/tickets/ticket_one_01", tokMasterB, "", nil)
	_ = rCrossDel.Body.Close()
	if rCrossDel.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-cluster delete: got %d, want 403", rCrossDel.StatusCode)
	}

	// Public claim (NO Bearer token!) -> 200
	rClaim1 := doReq(http.MethodPost, "/v1/enroll/claim/ticket_one_01", "", "203.0.113.10", nil)
	if rClaim1.StatusCode != http.StatusOK {
		_ = rClaim1.Body.Close()
		t.Fatalf("first claim: got %d, want 200", rClaim1.StatusCode)
	}
	var claimed enroll.ClaimResponse
	_ = json.NewDecoder(rClaim1.Body).Decode(&claimed)
	_ = rClaim1.Body.Close()
	if claimed.TicketID != "ticket_one_01" || claimed.CiphertextB64 != "b3BhcXVlLWNpcGhlci0x" || claimed.ExpiresAtMs != created.ExpiresAtMs {
		t.Fatalf("unexpected claim response: %+v", claimed)
	}

	// Second claim on single-use ticket -> 410
	rClaim2 := doReq(http.MethodPost, "/v1/enroll/claim/ticket_one_01", "", "203.0.113.11", nil)
	_ = rClaim2.Body.Close()
	if rClaim2.StatusCode != http.StatusGone {
		t.Fatalf("second claim: got %d, want 410", rClaim2.StatusCode)
	}

	// Status reflects claimed state + IP + timestamp
	rStatus := doReq(http.MethodGet, "/v1/enroll/tickets/ticket_one_01/status", tokMasterA, "", nil)
	if rStatus.StatusCode != http.StatusOK {
		_ = rStatus.Body.Close()
		t.Fatalf("status after claim: got %d, want 200", rStatus.StatusCode)
	}
	var st enroll.TicketStatus
	_ = json.NewDecoder(rStatus.Body).Decode(&st)
	_ = rStatus.Body.Close()
	if st.Status != "claimed" || st.ClaimedCount != 1 || st.RemainingUses != 0 || st.LastClaimedIP != "203.0.113.10" || st.LastClaimedAtMs != fakeNow.UnixMilli() {
		t.Fatalf("unexpected status: %+v", st)
	}

	// 4. Multi-use countdown (max_uses=3 -> 3 claims succeed, 4th -> 410)
	rMulti := doReq(http.MethodPost, "/v1/enroll/tickets", tokMasterA, "", map[string]any{
		"ticket_id":      "ticket_multi_03",
		"ciphertext_b64": "bXVsdGktc2VjcmV0",
		"ttl_sec":        300,
		"max_uses":       3,
	})
	_ = rMulti.Body.Close()
	if rMulti.StatusCode != http.StatusCreated {
		t.Fatalf("create multi-use: got %d, want 201", rMulti.StatusCode)
	}
	for i := 1; i <= 3; i++ {
		rc := doReq(http.MethodPost, "/v1/enroll/claim/ticket_multi_03", "", fmt.Sprintf("198.51.100.%d", i), nil)
		_ = rc.Body.Close()
		if rc.StatusCode != http.StatusOK {
			t.Fatalf("multi-use claim %d: got %d, want 200", i, rc.StatusCode)
		}
	}
	rMultiGone := doReq(http.MethodPost, "/v1/enroll/claim/ticket_multi_03", "", "198.51.100.4", nil)
	_ = rMultiGone.Body.Close()
	if rMultiGone.StatusCode != http.StatusGone {
		t.Fatalf("4th multi-use claim: got %d, want 410", rMultiGone.StatusCode)
	}

	// 5. Revoke -> 200, subsequent claim -> 410
	rRevCreate := doReq(http.MethodPost, "/v1/enroll/tickets", tokMasterA, "", map[string]any{
		"ticket_id":      "ticket_revoke_1",
		"ciphertext_b64": "cmV2b2tlLWNpcGhlcg==",
		"ttl_sec":        300,
		"max_uses":       2,
	})
	_ = rRevCreate.Body.Close()
	rDel := doReq(http.MethodDelete, "/v1/enroll/tickets/ticket_revoke_1", tokMasterA, "", nil)
	if rDel.StatusCode != http.StatusOK {
		_ = rDel.Body.Close()
		t.Fatalf("delete revoke: got %d, want 200", rDel.StatusCode)
	}
	var delResp enroll.RevokeResponse
	_ = json.NewDecoder(rDel.Body).Decode(&delResp)
	_ = rDel.Body.Close()
	if delResp.TicketID != "ticket_revoke_1" || delResp.Status != "revoked" {
		t.Fatalf("unexpected revoke response: %+v", delResp)
	}
	rRevClaim := doReq(http.MethodPost, "/v1/enroll/claim/ticket_revoke_1", "", "198.51.100.5", nil)
	_ = rRevClaim.Body.Close()
	if rRevClaim.StatusCode != http.StatusGone {
		t.Fatalf("claim after revoke: got %d, want 410", rRevClaim.StatusCode)
	}

	// 6. TTL expiration -> status "expired" & claim -> 410
	rExpCreate := doReq(http.MethodPost, "/v1/enroll/tickets", tokMasterA, "", map[string]any{
		"ticket_id":      "ticket_expire_1",
		"ciphertext_b64": "ZXhwaXJlLWNpcGhlcg==",
		"ttl_sec":        60,
		"max_uses":       1,
	})
	_ = rExpCreate.Body.Close()
	advance(61 * time.Second)
	rExpClaim := doReq(http.MethodPost, "/v1/enroll/claim/ticket_expire_1", "", "198.51.100.6", nil)
	_ = rExpClaim.Body.Close()
	if rExpClaim.StatusCode != http.StatusGone {
		t.Fatalf("claim after TTL expiry: got %d, want 410", rExpClaim.StatusCode)
	}

	// 7. Missing ticket claim -> 404
	rMiss := doReq(http.MethodPost, "/v1/enroll/claim/does_not_exist1", "", "198.51.100.7", nil)
	_ = rMiss.Body.Close()
	if rMiss.StatusCode != http.StatusNotFound {
		t.Fatalf("missing ticket claim: got %d, want 404", rMiss.StatusCode)
	}

	// 8. Per-cluster active ticket cap (20 active -> 21st returns 429)
	for i := 0; i < enroll.MaxActiveTicketsPerCluster; i++ {
		rc := doReq(http.MethodPost, "/v1/enroll/tickets", tokMasterB, "", map[string]any{
			"ticket_id":      fmt.Sprintf("cap_b_ticket_%02d", i),
			"ciphertext_b64": "Y2FwLXRlc3Q=",
			"ttl_sec":        300,
		})
		_ = rc.Body.Close()
		if rc.StatusCode != http.StatusCreated {
			t.Fatalf("cap create %d: got %d, want 201", i, rc.StatusCode)
		}
	}
	rCapOver := doReq(http.MethodPost, "/v1/enroll/tickets", tokMasterB, "", map[string]any{
		"ticket_id":      "cap_b_ticket_21",
		"ciphertext_b64": "Y2FwLXRlc3Q=",
		"ttl_sec":        300,
	})
	_ = rCapOver.Body.Close()
	if rCapOver.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("21st active ticket: got %d, want 429", rCapOver.StatusCode)
	}

	// 9. Public claim IP rate limit -> 20 req/min/IP, 21st returns 429
	const floodIP = "203.0.113.200"
	for i := 0; i < enroll.DefaultClaimRatePerMin; i++ {
		rf := doReq(http.MethodPost, "/v1/enroll/claim/nonexistent_rl1", "", floodIP, nil)
		_ = rf.Body.Close()
		if rf.StatusCode == http.StatusTooManyRequests {
			t.Fatalf("rate limited too early on req %d", i+1)
		}
	}
	rRateLimited := doReq(http.MethodPost, "/v1/enroll/claim/nonexistent_rl1", "", floodIP, nil)
	_ = rRateLimited.Body.Close()
	if rRateLimited.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("21st claim from same IP: got %d, want 429", rRateLimited.StatusCode)
	}
}

func TestMirrorAndBootstrapScriptsHTTP(t *testing.T) {
	var upstreamHits atomic.Int32
	fakeTar := []byte("neo-agent-os-release-tarball-bytes")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits.Add(1)
		switch r.URL.Path {
		case "/v0.9.1/neo-agent-os-0.9.1-linux-x64.tar.gz":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(fakeTar)
		case "/v0.9.1/SHA256SUMS.txt":
			_, _ = w.Write([]byte("abcd  neo-agent-os-0.9.1-linux-x64.tar.gz\n"))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer upstream.Close()

	ghAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"tag_name": "v0.9.1"})
	}))
	defer ghAPI.Close()

	mirror := enroll.NewMirror(enroll.MirrorConfig{
		CacheDir:       t.TempDir(),
		ReleaseBaseURL: upstream.URL,
		GitHubAPIURL:   ghAPI.URL,
	})

	h := hub.New(10<<20, 1<<20)
	srv := server.New(server.Config{
		KeyRing:   auth.KeyRing{RootSecret: []byte("unit-test-secret-32-bytes-minimum!!")},
		PublicURL: "https://neo.1inch.cn:18443",
		Mirror:    mirror,
	}, h)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// 1. /dl/latest.json
	rLatest, err := http.Get(ts.URL + "/dl/latest.json")
	if err != nil {
		t.Fatalf("get latest.json: %v", err)
	}
	var latest enroll.LatestResponse
	_ = json.NewDecoder(rLatest.Body).Decode(&latest)
	_ = rLatest.Body.Close()
	if rLatest.StatusCode != http.StatusOK || latest.Version != "0.9.1" || latest.Tag != "v0.9.1" {
		t.Fatalf("unexpected latest.json: code=%d body=%+v", rLatest.StatusCode, latest)
	}

	// 2. /dl/{tag}/{filename} caches from mock upstream (MISS then HIT)
	r1, err := http.Get(ts.URL + "/dl/v0.9.1/neo-agent-os-0.9.1-linux-x64.tar.gz")
	if err != nil {
		t.Fatalf("first dl err: %v", err)
	}
	b1, _ := io.ReadAll(r1.Body)
	_ = r1.Body.Close()
	if r1.StatusCode != http.StatusOK || !bytes.Equal(b1, fakeTar) || r1.Header.Get("X-Neo-Cache") != "MISS" {
		t.Fatalf("first dl unexpected: code=%d cache=%q len=%d", r1.StatusCode, r1.Header.Get("X-Neo-Cache"), len(b1))
	}

	r2, err := http.Get(ts.URL + "/dl/v0.9.1/neo-agent-os-0.9.1-linux-x64.tar.gz")
	if err != nil {
		t.Fatalf("second dl err: %v", err)
	}
	b2, _ := io.ReadAll(r2.Body)
	_ = r2.Body.Close()
	if r2.StatusCode != http.StatusOK || !bytes.Equal(b2, fakeTar) || r2.Header.Get("X-Neo-Cache") != "HIT" {
		t.Fatalf("second dl unexpected: code=%d cache=%q", r2.StatusCode, r2.Header.Get("X-Neo-Cache"))
	}
	if upstreamHits.Load() != 1 {
		t.Fatalf("expected 1 upstream fetch, got %d", upstreamHits.Load())
	}

	// 3. Allowlist / path traversal rejection directly against Handler() (ensuring NO 301 redirect!)
	for _, badPath := range []string{
		"/dl/v0.9.1/../../.env",
		"/dl/v0.9.1/..%2F.env",
		"/dl/v0.9.1/.env",
		"/dl/v0.9.1/arbitrary-binary.bin",
		"/dl/badtag/SHA256SUMS.txt",
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "http://neo.1inch.cn"+badPath, nil)
		srv.Handler().ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden && rec.Code != http.StatusBadRequest {
			t.Fatalf("bad path %q: got %d, want 400 or 403", badPath, rec.Code)
		}
	}

	// 4. GET /install.sh with configured PublicURL + sh -n syntax check
	rSh, err := http.Get(ts.URL + "/install.sh")
	if err != nil {
		t.Fatalf("get install.sh: %v", err)
	}
	shBody, _ := io.ReadAll(rSh.Body)
	_ = rSh.Body.Close()
	if rSh.StatusCode != http.StatusOK {
		t.Fatalf("install.sh status=%d", rSh.StatusCode)
	}
	if ct := rSh.Header.Get("Content-Type"); ct != "text/x-shellscript; charset=utf-8" {
		t.Fatalf("install.sh content-type=%q", ct)
	}
	if !strings.Contains(string(shBody), `RELAY_URL="https://neo.1inch.cn:18443"`) {
		t.Fatalf("install.sh missing PublicURL substitution")
	}
	shFile := filepath.Join(t.TempDir(), "install.sh")
	if err := os.WriteFile(shFile, shBody, 0o644); err != nil {
		t.Fatalf("write temp install.sh: %v", err)
	}
	if out, err := exec.Command("sh", "-n", shFile).CombinedOutput(); err != nil {
		t.Fatalf("rendered install.sh failed sh -n: %v\n%s", err, string(out))
	}

	// 5. GET /install.ps1 with configured PublicURL
	rPs1, err := http.Get(ts.URL + "/install.ps1")
	if err != nil {
		t.Fatalf("get install.ps1: %v", err)
	}
	ps1Body, _ := io.ReadAll(rPs1.Body)
	_ = rPs1.Body.Close()
	if rPs1.StatusCode != http.StatusOK {
		t.Fatalf("install.ps1 status=%d", rPs1.StatusCode)
	}
	if ct := rPs1.Header.Get("Content-Type"); ct != "text/plain; charset=utf-8" {
		t.Fatalf("install.ps1 content-type=%q", ct)
	}
	if !strings.Contains(string(ps1Body), "function Install-NeoAgent") ||
		!strings.Contains(string(ps1Body), `[string]$RelayUrl = "https://neo.1inch.cn:18443"`) {
		t.Fatalf("install.ps1 missing function or PublicURL substitution")
	}

	// 6. Dynamic PublicURL fallback from r.Host + X-Forwarded-Proto when cfg.PublicURL == ""
	srvDyn := server.New(server.Config{
		KeyRing: auth.KeyRing{RootSecret: []byte("unit-test-secret-32-bytes-minimum!!")},
	}, h)
	recDyn := httptest.NewRecorder()
	reqDyn := httptest.NewRequest(http.MethodGet, "http://relay.example.org:8443/install.sh", nil)
	reqDyn.Header.Set("X-Forwarded-Proto", "https")
	srvDyn.Handler().ServeHTTP(recDyn, reqDyn)
	if !strings.Contains(recDyn.Body.String(), `RELAY_URL="https://relay.example.org:8443"`) {
		t.Fatalf("dynamic PublicURL fallback failed: %s", recDyn.Body.String()[:200])
	}
}

func TestKeyRingHotReloadPreservesWebSockets(t *testing.T) {
	rootSecret := []byte("root-secret-32-bytes-minimum-test!!")
	gammaSecret := []byte("gamma-cluster-independent-secret-32!")

	h := hub.New(10<<20, 1<<20)
	srv := server.New(server.Config{
		KeyRing:       auth.KeyRing{RootSecret: rootSecret},
		MaxFrameBytes: 1 << 20,
	}, h)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	wsBase := "ws" + strings.TrimPrefix(ts.URL, "http")

	tokAlpha1, _ := auth.MintToken(rootSecret, "cluster-alpha", "master-a", "master", time.Hour, time.Now())
	tokAlpha2, _ := auth.MintToken(rootSecret, "cluster-alpha", "agent-a", "os", time.Hour, time.Now())
	tokGamma, _ := auth.MintTokenWithKeyRing(auth.KeyRing{
		ClusterSecrets: map[string][]byte{"cluster-gamma": gammaSecret},
	}, "cluster-gamma", "master-g", "master", time.Hour, time.Now())

	// Open active relay WebSockets for cluster-alpha before reload
	relA1, _, err := ws.Dial(wsBase+"/v1/relay", http.Header{"Authorization": []string{"Bearer " + tokAlpha1}}, nil, 5*time.Second)
	if err != nil {
		t.Fatalf("dial relA1: %v", err)
	}
	defer relA1.Close()
	relA2, _, err := ws.Dial(wsBase+"/v1/relay", http.Header{"Authorization": []string{"Bearer " + tokAlpha2}}, nil, 5*time.Second)
	if err != nil {
		t.Fatalf("dial relA2: %v", err)
	}
	defer relA2.Close()

	// Before reload: cluster-gamma token signed with independent secret is rejected (401)
	reqBefore, _ := http.NewRequest(http.MethodGet, ts.URL+"/v1/whoami", nil)
	reqBefore.Header.Set("Authorization", "Bearer "+tokGamma)
	rBefore, err := http.DefaultClient.Do(reqBefore)
	if err != nil {
		t.Fatalf("whoami before reload: %v", err)
	}
	_ = rBefore.Body.Close()
	if rBefore.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 before keyring reload, got %d", rBefore.StatusCode)
	}

	// Hot-reload KeyRing to add cluster-gamma's independent secret
	srv.UpdateKeyRing(auth.KeyRing{
		RootSecret: rootSecret,
		ClusterSecrets: map[string][]byte{
			"cluster-gamma": gammaSecret,
		},
	})

	// After reload: cluster-gamma token succeeds immediately
	reqAfter, _ := http.NewRequest(http.MethodGet, ts.URL+"/v1/whoami", nil)
	reqAfter.Header.Set("Authorization", "Bearer "+tokGamma)
	rAfter, err := http.DefaultClient.Do(reqAfter)
	if err != nil {
		t.Fatalf("whoami after reload: %v", err)
	}
	_ = rAfter.Body.Close()
	if rAfter.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 after keyring reload, got %d", rAfter.StatusCode)
	}

	// Existing cluster-alpha WebSocket remains open and functional without interruption
	if err := relA1.WriteBinary(hub.EncodeRelayFrame(hub.RelayFrame{
		Flags:   hub.FlagData,
		SrcID:   "master-a",
		DstID:   "agent-a",
		Payload: []byte("still-alive-after-sighup"),
	})); err != nil {
		t.Fatalf("write after reload: %v", err)
	}
	_, rawGot, err := relA2.ReadMessage()
	if err != nil {
		t.Fatalf("read after reload: %v", err)
	}
	gotFrame, err := hub.DecodeRelayFrame(rawGot)
	if err != nil || string(gotFrame.Payload) != "still-alive-after-sighup" {
		t.Fatalf("unexpected payload after reload: %+v err=%v", gotFrame, err)
	}
}

func TestBootstrapAndPeersObservedIP(t *testing.T) {
	secret := []byte("unit-test-secret-32-bytes-minimum!!")
	h := hub.New(10<<20, 1<<20)
	srv := server.New(server.Config{
		KeyRing:       auth.KeyRing{RootSecret: secret},
		MaxFrameBytes: 1 << 20,
	}, h)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	wsBase := "ws" + strings.TrimPrefix(ts.URL, "http")

	tokMaster, _ := auth.MintToken(secret, "geo-cluster", "master-1", "master", time.Hour, time.Now())
	tokAgent, _ := auth.MintToken(secret, "geo-cluster", "os-shenzhen-1", "os", time.Hour, time.Now())

	// Bootstrap reflects X-Forwarded-For as observed_ip
	reqBoot, _ := http.NewRequest(http.MethodGet, ts.URL+"/v1/bootstrap", nil)
	reqBoot.Header.Set("Authorization", "Bearer "+tokAgent)
	reqBoot.Header.Set("X-Forwarded-For", "113.87.160.22, 10.0.0.1")
	rBoot, err := http.DefaultClient.Do(reqBoot)
	if err != nil {
		t.Fatalf("bootstrap err: %v", err)
	}
	defer rBoot.Body.Close()
	var boot map[string]any
	if err := json.NewDecoder(rBoot.Body).Decode(&boot); err != nil {
		t.Fatalf("decode boot err: %v", err)
	}
	if boot["observed_ip"] != "113.87.160.22" {
		t.Fatalf("expected bootstrap observed_ip 113.87.160.22, got %v", boot["observed_ip"])
	}

	// Agent connects to /v1/relay with X-Forwarded-For -> /v1/peers exposes observed_ip
	hdrAgent := http.Header{
		"Authorization":   []string{"Bearer " + tokAgent},
		"X-Forwarded-For": []string{"113.87.160.22"},
	}
	relAgent, _, err := ws.Dial(wsBase+"/v1/relay", hdrAgent, nil, 5*time.Second)
	if err != nil {
		t.Fatalf("dial relay agent: %v", err)
	}
	defer relAgent.Close()

	// Also verify signal addr field populates reflexive_udp when reflexive_udp is absent
	sigAgent, _, err := ws.Dial(wsBase+"/v1/signal", hdrAgent, nil, 5*time.Second)
	if err != nil {
		t.Fatalf("dial signal agent: %v", err)
	}
	defer sigAgent.Close()
	_, _, _ = sigAgent.ReadMessage()
	regMsg, _ := json.Marshal(hub.SignalMsg{
		Type: "register",
		Addr: "113.87.160.22:54321",
	})
	if err := sigAgent.WriteText(regMsg); err != nil {
		t.Fatalf("signal register err: %v", err)
	}
	_, _, _ = sigAgent.ReadMessage()

	reqPeers, _ := http.NewRequest(http.MethodGet, ts.URL+"/v1/peers", nil)
	reqPeers.Header.Set("Authorization", "Bearer "+tokMaster)
	rPeers, err := http.DefaultClient.Do(reqPeers)
	if err != nil {
		t.Fatalf("peers err: %v", err)
	}
	defer rPeers.Body.Close()
	var peersBody struct {
		Peers []hub.PeerInfo `json:"peers"`
	}
	if err := json.NewDecoder(rPeers.Body).Decode(&peersBody); err != nil {
		t.Fatalf("decode peers err: %v", err)
	}
	found := false
	for _, p := range peersBody.Peers {
		if p.NodeID == "os-shenzhen-1" {
			found = true
			if p.ObservedIP != "113.87.160.22" {
				t.Fatalf("expected peer observed_ip 113.87.160.22, got %q", p.ObservedIP)
			}
			if p.ReflexiveUDP != "113.87.160.22:54321" {
				t.Fatalf("expected peer reflexive_udp 113.87.160.22:54321, got %q", p.ReflexiveUDP)
			}
		}
	}
	if !found {
		t.Fatalf("os-shenzhen-1 not found in /v1/peers: %+v", peersBody.Peers)
	}
}
