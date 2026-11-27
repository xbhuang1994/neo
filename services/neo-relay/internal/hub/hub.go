package hub

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"neo-relay/internal/ws"
)

const (
	FrameMagic0    byte = 'N'
	FrameMagic1    byte = 'R'
	FrameVersion   byte = 0x01
	FlagData       byte = 0x01
	FlagPing       byte = 0x02
	FlagPong       byte = 0x03
	FlagErrOffline byte = 0x81
	FlagErrSpoofed byte = 0x82
	FlagErrRate    byte = 0x83
	FrameHeaderLen      = 10

	DefaultNodeRateBPS           int64         = 5 << 20   // 5 MiB/s
	DefaultNodeBurstBytes        int64         = 2 << 20   // 2 MiB
	DefaultClusterRateBPS        int64         = 20 << 20  // 20 MiB/s
	DefaultClusterBurstBytes     int64         = 4 << 20   // 4 MiB
	DefaultMaxPeersPerCluster    int           = 128
	DefaultPenaltyWindow         time.Duration = 60 * time.Second
	DefaultPenaltyThresholdBytes int64         = 200 << 20 // 200 MiB in 1 minute
	DefaultPenaltyRateBPS        int64         = 128 << 10 // 128 KiB/s
	DefaultPenaltyBurstBytes     int64         = 256 << 10 // 256 KiB
	DefaultPenaltyDuration       time.Duration = 1 * time.Hour
)

type Limits struct {
	NodeRateBPS           int64
	NodeBurstBytes        int64
	ClusterRateBPS        int64
	ClusterBurstBytes     int64
	MaxPeersPerCluster    int
	PenaltyWindow         time.Duration
	PenaltyThresholdBytes int64
	PenaltyRateBPS        int64
	PenaltyBurstBytes     int64
	PenaltyDuration       time.Duration
}

func (l Limits) withDefaults() Limits {
	if l.NodeRateBPS <= 0 {
		l.NodeRateBPS = DefaultNodeRateBPS
	}
	if l.NodeBurstBytes <= 0 {
		l.NodeBurstBytes = DefaultNodeBurstBytes
	}
	if l.ClusterRateBPS <= 0 {
		l.ClusterRateBPS = DefaultClusterRateBPS
	}
	if l.ClusterBurstBytes <= 0 {
		l.ClusterBurstBytes = DefaultClusterBurstBytes
	}
	if l.MaxPeersPerCluster <= 0 {
		l.MaxPeersPerCluster = DefaultMaxPeersPerCluster
	}
	if l.PenaltyWindow <= 0 {
		l.PenaltyWindow = DefaultPenaltyWindow
	}
	if l.PenaltyThresholdBytes <= 0 {
		l.PenaltyThresholdBytes = DefaultPenaltyThresholdBytes
	}
	if l.PenaltyRateBPS <= 0 {
		l.PenaltyRateBPS = DefaultPenaltyRateBPS
	}
	if l.PenaltyBurstBytes <= 0 {
		l.PenaltyBurstBytes = DefaultPenaltyBurstBytes
	}
	if l.PenaltyDuration <= 0 {
		l.PenaltyDuration = DefaultPenaltyDuration
	}
	return l
}

type PeerInfo struct {
	ClusterID        string   `json:"cluster_id"`
	NodeID           string   `json:"node_id"`
	Tier             string   `json:"tier"`
	ObservedIP       string   `json:"observed_ip,omitempty"`
	LANAddrs         []string `json:"lan_addrs,omitempty"`
	ReflexiveUDP     string   `json:"reflexive_udp,omitempty"`
	NATType          string   `json:"nat_type,omitempty"`
	PathMode         string   `json:"path_mode"`
	SignalOnline     bool     `json:"signal_online"`
	RelayOnline      bool     `json:"relay_online"`
	Throttled        bool     `json:"throttled"`
	ThrottleUntilMs  int64    `json:"throttle_until_ms,omitempty"`
	EffectiveRateBPS int64    `json:"effective_rate_bps"`
	ConnectedAt      int64    `json:"connected_at_ms"`
	LastSeen         int64    `json:"last_seen_ms"`
}

type SignalMsg struct {
	Type         string   `json:"type"`
	From         string   `json:"from,omitempty"`
	To           string   `json:"to,omitempty"`
	SessionID    string   `json:"session_id,omitempty"`
	Addr         string   `json:"addr,omitempty"`
	LANAddrs     []string `json:"lan_addrs,omitempty"`
	ReflexiveUDP string   `json:"reflexive_udp,omitempty"`
	NATType      string   `json:"nat_type,omitempty"`
	PunchAtMs    int64    `json:"punch_at_ms,omitempty"`
	PathMode     string   `json:"path_mode,omitempty"`
	Reason       string   `json:"reason,omitempty"`
	ServerTimeMs int64    `json:"server_time_ms,omitempty"`
	OK           bool     `json:"ok,omitempty"`
	Error        string   `json:"error,omitempty"`
}

type RelayFrame struct {
	Flags   byte
	SrcID   string
	DstID   string
	Payload []byte
}

type rateLimiter struct {
	mu       sync.Mutex
	tokens   float64
	lastTick time.Time
	rateBPS  float64
	burst    float64
}

func newRateLimiter(rateBPS, burst int64, now time.Time) *rateLimiter {
	if rateBPS <= 0 {
		rateBPS = DefaultNodeRateBPS
	}
	if burst <= 0 {
		burst = DefaultNodeBurstBytes
	}
	return &rateLimiter{
		tokens:   float64(burst),
		lastTick: now,
		rateBPS:  float64(rateBPS),
		burst:    float64(burst),
	}
}

func (rl *rateLimiter) allowAt(now time.Time, n int) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	if now.After(rl.lastTick) {
		elapsed := now.Sub(rl.lastTick).Seconds()
		rl.tokens += elapsed * rl.rateBPS
		if rl.tokens > rl.burst {
			rl.tokens = rl.burst
		}
		rl.lastTick = now
	}
	cost := float64(n)
	if cost > rl.burst {
		return false
	}
	if rl.tokens < cost {
		return false
	}
	rl.tokens -= cost
	return true
}

func (rl *rateLimiter) resetTokens(now time.Time, tokens float64) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	if tokens < 0 {
		tokens = 0
	}
	if tokens > rl.burst {
		tokens = rl.burst
	}
	rl.tokens = tokens
	rl.lastTick = now
}

type windowSlot struct {
	sec   int64
	bytes int64
}

// nodeTrafficGuard enforces 5 MiB/s base rate + rolling 1-min >200 MiB penalty
// throttle to 128 KiB/s for 1 hour. Lives on clusterBucket.traffic independently
// of peerEntry so disconnect/reconnect cannot reset an active penalty.
type nodeTrafficGuard struct {
	mu             sync.Mutex
	limits         Limits
	baseLimiter    *rateLimiter
	penaltyLimiter *rateLimiter
	slots          []windowSlot
	penaltyUntil   time.Time
}

func newNodeTrafficGuard(l Limits, now time.Time) *nodeTrafficGuard {
	winSecs := int(l.PenaltyWindow.Seconds())
	if winSecs <= 0 {
		winSecs = 60
	}
	return &nodeTrafficGuard{
		limits:         l,
		baseLimiter:    newRateLimiter(l.NodeRateBPS, l.NodeBurstBytes, now),
		penaltyLimiter: newRateLimiter(l.PenaltyRateBPS, l.PenaltyBurstBytes, now),
		slots:          make([]windowSlot, winSecs),
	}
}

func (g *nodeTrafficGuard) allowAndRecord(now time.Time, n int) (allowed bool, throttled bool, triggeredNow bool) {
	g.mu.Lock()
	defer g.mu.Unlock()

	if now.Before(g.penaltyUntil) {
		ok := g.penaltyLimiter.allowAt(now, n)
		return ok, true, false
	}

	if !g.baseLimiter.allowAt(now, n) {
		return false, false, false
	}

	rolling := g.recordAndSumLocked(now, int64(n))
	if rolling > g.limits.PenaltyThresholdBytes {
		g.penaltyUntil = now.Add(g.limits.PenaltyDuration)
		g.penaltyLimiter.resetTokens(now, 0)
		return true, true, true
	}
	return true, false, false
}

func (g *nodeTrafficGuard) recordAndSumLocked(now time.Time, n int64) int64 {
	sec := now.Unix()
	winSecs := int64(len(g.slots))
	idx := int(sec % winSecs)
	if idx < 0 {
		idx += len(g.slots)
	}
	if g.slots[idx].sec != sec {
		g.slots[idx] = windowSlot{sec: sec, bytes: n}
	} else {
		g.slots[idx].bytes += n
	}

	cutoff := sec - winSecs + 1
	var sum int64
	for i := range g.slots {
		if g.slots[i].sec >= cutoff {
			sum += g.slots[i].bytes
		}
	}
	return sum
}

func (g *nodeTrafficGuard) status(now time.Time) (throttled bool, untilMs int64, rateBPS int64) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if now.Before(g.penaltyUntil) {
		return true, g.penaltyUntil.UnixMilli(), g.limits.PenaltyRateBPS
	}
	return false, 0, g.limits.NodeRateBPS
}

func (g *nodeTrafficGuard) isIdleExpired(now time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if now.Before(g.penaltyUntil) {
		return false
	}
	cutoff := now.Unix() - int64(len(g.slots)) + 1
	for i := range g.slots {
		if g.slots[i].sec >= cutoff && g.slots[i].bytes > 0 {
			return false
		}
	}
	return true
}

type peerEntry struct {
	info       PeerInfo
	signalConn *ws.Conn
	relayConn  *ws.Conn
	guard      *nodeTrafficGuard
}

type clusterBucket struct {
	id             string
	peers          map[string]*peerEntry
	traffic        map[string]*nodeTrafficGuard
	clusterLimiter *rateLimiter

	p2pOffers        atomic.Uint64
	p2pAnswers       atomic.Uint64
	p2pPunchesIssued atomic.Uint64
	p2pActiveCount   atomic.Uint64
	relayFallbacks   atomic.Uint64
	relayedFrames    atomic.Uint64
	relayedBytes     atomic.Uint64
	rateLimitedDrops atomic.Uint64
	penaltyTriggers  atomic.Uint64
}

type StatsSnapshot struct {
	ClusterID            string `json:"cluster_id"`
	ClusterCount         int    `json:"cluster_count,omitempty"`
	StartedAtMs          int64  `json:"started_at_ms"`
	UptimeSeconds        int64  `json:"uptime_seconds"`
	OnlinePeers          int    `json:"online_peers"`
	SignalSessions       int    `json:"signal_sessions"`
	RelaySessions        int    `json:"relay_sessions"`
	ActiveThrottledPeers int    `json:"active_throttled_peers"`
	P2POffers            uint64 `json:"p2p_offers"`
	P2PAnswers           uint64 `json:"p2p_answers"`
	P2PPunchesIssued     uint64 `json:"p2p_punches_issued"`
	P2PActiveReported    uint64 `json:"p2p_active_reported"`
	RelayFallbacks       uint64 `json:"relay_fallbacks"`
	RelayedFrames        uint64 `json:"relayed_frames"`
	RelayedBytes         uint64 `json:"relayed_bytes"`
	RateLimitedDrops     uint64 `json:"rate_limited_drops"`
	PenaltyTriggers      uint64 `json:"penalty_triggers"`
	STUNRequests         uint64 `json:"stun_requests,omitempty"`
	UDPProbeRequests     uint64 `json:"udp_probe_requests,omitempty"`
}

type Hub struct {
	mu        sync.RWMutex
	clusters  map[string]*clusterBucket
	limits    Limits
	startedAt time.Time

	clockMu sync.RWMutex
	nowFn   func() time.Time

	stunRequests     atomic.Uint64
	udpProbeRequests atomic.Uint64
}

func New(relayRateBPS, relayBurst int64) *Hub {
	return NewWithConfig(Limits{
		NodeRateBPS:       relayRateBPS,
		NodeBurstBytes:    relayBurst,
		ClusterRateBPS:    DefaultClusterRateBPS,
		ClusterBurstBytes: DefaultClusterBurstBytes,
	})
}

func NewWithLimits(relayRateBPS, relayBurst, clusterRateBPS int64, maxPeersPerCluster int) *Hub {
	return NewWithConfig(Limits{
		NodeRateBPS:        relayRateBPS,
		NodeBurstBytes:     relayBurst,
		ClusterRateBPS:     clusterRateBPS,
		ClusterBurstBytes:  DefaultClusterBurstBytes,
		MaxPeersPerCluster: maxPeersPerCluster,
	})
}

func NewWithConfig(limits Limits) *Hub {
	l := limits.withDefaults()
	return &Hub{
		clusters:  make(map[string]*clusterBucket),
		limits:    l,
		startedAt: time.Now(),
		nowFn:     time.Now,
	}
}

func (h *Hub) SetClock(fn func() time.Time) {
	h.clockMu.Lock()
	defer h.clockMu.Unlock()
	if fn == nil {
		h.nowFn = time.Now
		return
	}
	h.nowFn = fn
}

func (h *Hub) now() time.Time {
	h.clockMu.RLock()
	fn := h.nowFn
	h.clockMu.RUnlock()
	return fn()
}

func (h *Hub) RecordUDP(kind string) {
	switch kind {
	case "stun":
		h.stunRequests.Add(1)
	case "probe":
		h.udpProbeRequests.Add(1)
	}
}

func (h *Hub) ListPeers(clusterID string) []PeerInfo {
	now := h.now()
	h.mu.RLock()
	defer h.mu.RUnlock()
	if clusterID == "*" {
		out := make([]PeerInfo, 0)
		for _, c := range h.clusters {
			for _, p := range c.peers {
				out = append(out, enrichPeerInfo(p, now))
			}
		}
		return out
	}
	c, ok := h.clusters[clusterID]
	if !ok {
		return []PeerInfo{}
	}
	out := make([]PeerInfo, 0, len(c.peers))
	for _, p := range c.peers {
		out = append(out, enrichPeerInfo(p, now))
	}
	return out
}

func enrichPeerInfo(p *peerEntry, now time.Time) PeerInfo {
	info := p.info
	if p.guard != nil {
		throttled, untilMs, effRate := p.guard.status(now)
		info.Throttled = throttled
		info.ThrottleUntilMs = untilMs
		info.EffectiveRateBPS = effRate
	}
	return info
}

func (h *Hub) Stats(clusterID string) StatsSnapshot {
	now := h.now()
	h.mu.RLock()
	defer h.mu.RUnlock()

	snap := StatsSnapshot{
		ClusterID:     clusterID,
		StartedAtMs:   h.startedAt.UnixMilli(),
		UptimeSeconds: int64(now.Sub(h.startedAt).Seconds()),
	}
	if snap.UptimeSeconds < 0 {
		snap.UptimeSeconds = 0
	}

	if clusterID == "*" {
		snap.ClusterCount = len(h.clusters)
		snap.STUNRequests = h.stunRequests.Load()
		snap.UDPProbeRequests = h.udpProbeRequests.Load()
		for _, c := range h.clusters {
			accumulateCluster(&snap, c, now)
		}
		return snap
	}

	if c, ok := h.clusters[clusterID]; ok {
		accumulateCluster(&snap, c, now)
	}
	return snap
}

func accumulateCluster(snap *StatsSnapshot, c *clusterBucket, now time.Time) {
	for _, p := range c.peers {
		if p.signalConn != nil || p.relayConn != nil {
			snap.OnlinePeers++
		}
		if p.signalConn != nil {
			snap.SignalSessions++
		}
		if p.relayConn != nil {
			snap.RelaySessions++
		}
		if p.guard != nil {
			if throttled, _, _ := p.guard.status(now); throttled {
				snap.ActiveThrottledPeers++
			}
		}
	}
	snap.P2POffers += c.p2pOffers.Load()
	snap.P2PAnswers += c.p2pAnswers.Load()
	snap.P2PPunchesIssued += c.p2pPunchesIssued.Load()
	snap.P2PActiveReported += c.p2pActiveCount.Load()
	snap.RelayFallbacks += c.relayFallbacks.Load()
	snap.RelayedFrames += c.relayedFrames.Load()
	snap.RelayedBytes += c.relayedBytes.Load()
	snap.RateLimitedDrops += c.rateLimitedDrops.Load()
	snap.PenaltyTriggers += c.penaltyTriggers.Load()
}

func (h *Hub) ServeSignal(clusterID, nodeID, tier string, conn *ws.Conn) {
	h.ServeSignalWithIP(clusterID, nodeID, tier, "", conn)
}

func (h *Hub) ServeSignalWithIP(clusterID, nodeID, tier, observedIP string, conn *ws.Conn) {
	now := h.now()
	nowMs := now.UnixMilli()
	var oldConn *ws.Conn
	h.mu.Lock()
	cb := h.getOrCreateClusterLocked(clusterID, now)
	_, exists := cb.peers[nodeID]
	if !exists && len(cb.peers) >= h.limits.MaxPeersPerCluster {
		h.mu.Unlock()
		_ = h.sendSignalJSON(conn, SignalMsg{Type: "error", Error: "cluster peer quota exceeded"})
		_ = conn.Close()
		return
	}
	p := h.getOrCreatePeerLocked(cb, nodeID, tier, now)
	oldConn = p.signalConn
	p.signalConn = conn
	p.info.SignalOnline = true
	if observedIP != "" {
		p.info.ObservedIP = observedIP
	}
	p.info.LastSeen = nowMs
	h.mu.Unlock()

	if oldConn != nil && oldConn != conn {
		_ = oldConn.Close()
	}

	defer func() {
		h.cleanupPeer(clusterID, nodeID, conn, true)
		_ = conn.Close()
	}()

	_ = h.sendSignalJSON(conn, SignalMsg{
		Type:         "registered",
		To:           nodeID,
		OK:           true,
		ServerTimeMs: nowMs,
	})

	for {
		_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var msg SignalMsg
		if err := json.Unmarshal(raw, &msg); err != nil {
			_ = h.sendSignalJSON(conn, SignalMsg{Type: "error", Error: "invalid json"})
			continue
		}
		h.handleSignalMessage(clusterID, nodeID, tier, conn, msg)
	}
}

func (h *Hub) handleSignalMessage(clusterID, nodeID, tier string, conn *ws.Conn, msg SignalMsg) {
	now := h.now()
	nowMs := now.UnixMilli()
	switch msg.Type {
	case "register", "heartbeat":
		h.mu.Lock()
		cb := h.getOrCreateClusterLocked(clusterID, now)
		p := h.getOrCreatePeerLocked(cb, nodeID, tier, now)
		p.info.LastSeen = nowMs
		if len(msg.LANAddrs) > 0 {
			p.info.LANAddrs = msg.LANAddrs
		}
		if msg.ReflexiveUDP != "" {
			p.info.ReflexiveUDP = msg.ReflexiveUDP
		} else if msg.Addr != "" {
			p.info.ReflexiveUDP = msg.Addr
		}
		if msg.NATType != "" {
			p.info.NATType = msg.NATType
		}
		if msg.PathMode != "" {
			p.info.PathMode = msg.PathMode
		}
		h.mu.Unlock()
		_ = h.sendSignalJSON(conn, SignalMsg{
			Type:         "heartbeat_ack",
			To:           nodeID,
			OK:           true,
			ServerTimeMs: nowMs,
		})

	case "p2p_initiate":
		if msg.To == "" {
			_ = h.sendSignalJSON(conn, SignalMsg{Type: "error", Error: "missing target peer"})
			return
		}
		h.mu.Lock()
		cb := h.getOrCreateClusterLocked(clusterID, now)
		cb.p2pOffers.Add(1)
		src := h.getOrCreatePeerLocked(cb, nodeID, tier, now)
		if len(msg.LANAddrs) > 0 {
			src.info.LANAddrs = msg.LANAddrs
		}
		if msg.ReflexiveUDP != "" {
			src.info.ReflexiveUDP = msg.ReflexiveUDP
		}
		if msg.NATType != "" {
			src.info.NATType = msg.NATType
		}
		dst := cb.peers[msg.To]
		var dstConn *ws.Conn
		if dst != nil {
			dstConn = dst.signalConn
		}
		offer := SignalMsg{
			Type:         "p2p_offer",
			From:         nodeID,
			To:           msg.To,
			SessionID:    msg.SessionID,
			LANAddrs:     src.info.LANAddrs,
			ReflexiveUDP: src.info.ReflexiveUDP,
			NATType:      src.info.NATType,
			ServerTimeMs: nowMs,
		}
		h.mu.Unlock()

		if dstConn == nil {
			_ = h.sendSignalJSON(conn, SignalMsg{
				Type:      "p2p_unavailable",
				From:      msg.To,
				SessionID: msg.SessionID,
				Reason:    "peer_signal_offline",
			})
			return
		}
		_ = h.sendSignalJSON(dstConn, offer)

	case "p2p_answer":
		if msg.To == "" {
			return
		}
		punchAt := now.Add(250 * time.Millisecond).UnixMilli()
		h.mu.Lock()
		cb := h.getOrCreateClusterLocked(clusterID, now)
		cb.p2pAnswers.Add(1)
		ansPeer := h.getOrCreatePeerLocked(cb, nodeID, tier, now)
		if len(msg.LANAddrs) > 0 {
			ansPeer.info.LANAddrs = msg.LANAddrs
		}
		if msg.ReflexiveUDP != "" {
			ansPeer.info.ReflexiveUDP = msg.ReflexiveUDP
		}
		if msg.NATType != "" {
			ansPeer.info.NATType = msg.NATType
		}
		initPeer := cb.peers[msg.To]
		var initConn *ws.Conn
		var initLAN []string
		var initRefl, initNAT string
		if initPeer != nil {
			initConn = initPeer.signalConn
			initLAN = initPeer.info.LANAddrs
			initRefl = initPeer.info.ReflexiveUDP
			initNAT = initPeer.info.NATType
		}
		ansLAN := ansPeer.info.LANAddrs
		ansRefl := ansPeer.info.ReflexiveUDP
		ansNAT := ansPeer.info.NATType
		h.mu.Unlock()

		if initConn == nil {
			_ = h.sendSignalJSON(conn, SignalMsg{
				Type:      "p2p_unavailable",
				From:      msg.To,
				SessionID: msg.SessionID,
				Reason:    "initiator_offline",
			})
			return
		}

		_ = h.sendSignalJSON(initConn, SignalMsg{
			Type:         "p2p_answer",
			From:         nodeID,
			To:           msg.To,
			SessionID:    msg.SessionID,
			LANAddrs:     ansLAN,
			ReflexiveUDP: ansRefl,
			NATType:      ansNAT,
			ServerTimeMs: nowMs,
		})
		cb.p2pPunchesIssued.Add(1)
		_ = h.sendSignalJSON(initConn, SignalMsg{
			Type:         "p2p_punch",
			From:         nodeID,
			To:           msg.To,
			SessionID:    msg.SessionID,
			LANAddrs:     ansLAN,
			ReflexiveUDP: ansRefl,
			NATType:      ansNAT,
			PunchAtMs:    punchAt,
			ServerTimeMs: nowMs,
		})
		_ = h.sendSignalJSON(conn, SignalMsg{
			Type:         "p2p_punch",
			From:         msg.To,
			To:           nodeID,
			SessionID:    msg.SessionID,
			LANAddrs:     initLAN,
			ReflexiveUDP: initRefl,
			NATType:      initNAT,
			PunchAtMs:    punchAt,
			ServerTimeMs: nowMs,
		})

	case "path_state":
		h.mu.Lock()
		cb := h.getOrCreateClusterLocked(clusterID, now)
		p := h.getOrCreatePeerLocked(cb, nodeID, tier, now)
		if msg.PathMode != "" {
			p.info.PathMode = msg.PathMode
		}
		p.info.LastSeen = nowMs
		h.mu.Unlock()
		if msg.PathMode == "p2p" {
			cb.p2pActiveCount.Add(1)
		}

	case "relay_fallback":
		h.mu.Lock()
		cb := h.getOrCreateClusterLocked(clusterID, now)
		cb.relayFallbacks.Add(1)
		p := h.getOrCreatePeerLocked(cb, nodeID, tier, now)
		p.info.PathMode = "relay"
		p.info.LastSeen = nowMs
		h.mu.Unlock()
	}
}

func (h *Hub) ServeRelay(clusterID, nodeID, tier string, conn *ws.Conn) {
	h.ServeRelayWithIP(clusterID, nodeID, tier, "", conn)
}

func (h *Hub) ServeRelayWithIP(clusterID, nodeID, tier, observedIP string, conn *ws.Conn) {
	now := h.now()
	nowMs := now.UnixMilli()
	var oldConn *ws.Conn
	h.mu.Lock()
	cb := h.getOrCreateClusterLocked(clusterID, now)
	_, exists := cb.peers[nodeID]
	if !exists && len(cb.peers) >= h.limits.MaxPeersPerCluster {
		h.mu.Unlock()
		_ = conn.WriteBinary(EncodeRelayFrame(RelayFrame{
			Flags:   FlagErrRate,
			SrcID:   "neo-relay",
			DstID:   nodeID,
			Payload: []byte("cluster peer quota exceeded"),
		}))
		_ = conn.Close()
		return
	}
	p := h.getOrCreatePeerLocked(cb, nodeID, tier, now)
	oldConn = p.relayConn
	p.relayConn = conn
	p.info.RelayOnline = true
	if observedIP != "" {
		p.info.ObservedIP = observedIP
	}
	if p.info.PathMode == "" || p.info.PathMode == "init" {
		p.info.PathMode = "relay"
	}
	p.info.LastSeen = nowMs
	guard := p.guard
	clusterLimiter := cb.clusterLimiter
	h.mu.Unlock()

	if oldConn != nil && oldConn != conn {
		_ = oldConn.Close()
	}

	defer func() {
		h.cleanupPeer(clusterID, nodeID, conn, false)
		_ = conn.Close()
	}()

	for {
		_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		op, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if op != ws.OpBinary {
			continue
		}
		frame, err := DecodeRelayFrame(raw)
		if err != nil {
			continue
		}
		if frame.Flags == FlagPing {
			_ = conn.WriteBinary(EncodeRelayFrame(RelayFrame{
				Flags: FlagPong,
				SrcID: "neo-relay",
				DstID: nodeID,
			}))
			continue
		}
		if frame.SrcID != nodeID {
			_ = conn.WriteBinary(EncodeRelayFrame(RelayFrame{
				Flags:   FlagErrSpoofed,
				SrcID:   "neo-relay",
				DstID:   nodeID,
				Payload: []byte("src_id mismatch"),
			}))
			continue
		}

		curNow := h.now()
		allowed, _, triggeredNow := guard.allowAndRecord(curNow, len(raw))
		if triggeredNow {
			cb.penaltyTriggers.Add(1)
		}
		if !allowed || !clusterLimiter.allowAt(curNow, len(raw)) {
			cb.rateLimitedDrops.Add(1)
			_ = conn.WriteBinary(EncodeRelayFrame(RelayFrame{
				Flags:   FlagErrRate,
				SrcID:   "neo-relay",
				DstID:   nodeID,
				Payload: []byte("rate limit exceeded"),
			}))
			continue
		}

		h.mu.RLock()
		var dstConn *ws.Conn
		if curCluster, ok := h.clusters[clusterID]; ok {
			if dst := curCluster.peers[frame.DstID]; dst != nil {
				dstConn = dst.relayConn
			}
		}
		h.mu.RUnlock()

		if dstConn == nil {
			_ = conn.WriteBinary(EncodeRelayFrame(RelayFrame{
				Flags:   FlagErrOffline,
				SrcID:   "neo-relay",
				DstID:   nodeID,
				Payload: []byte(frame.DstID),
			}))
			continue
		}

		if err := dstConn.WriteBinary(raw); err != nil {
			_ = conn.WriteBinary(EncodeRelayFrame(RelayFrame{
				Flags:   FlagErrOffline,
				SrcID:   "neo-relay",
				DstID:   nodeID,
				Payload: []byte(frame.DstID),
			}))
			continue
		}
		cb.relayedFrames.Add(1)
		cb.relayedBytes.Add(uint64(len(frame.Payload)))
	}
}

func (h *Hub) cleanupPeer(clusterID, nodeID string, conn *ws.Conn, isSignal bool) {
	now := h.now()
	h.mu.Lock()
	defer h.mu.Unlock()
	curCluster, ok := h.clusters[clusterID]
	if !ok {
		return
	}
	if cur, ok := curCluster.peers[nodeID]; ok {
		if isSignal && cur.signalConn == conn {
			cur.signalConn = nil
			cur.info.SignalOnline = false
		}
		if !isSignal && cur.relayConn == conn {
			cur.relayConn = nil
			cur.info.RelayOnline = false
		}
		if cur.signalConn == nil && cur.relayConn == nil {
			delete(curCluster.peers, nodeID)
		}
	}
	// Prune only idle+expired traffic guards; active penalties survive disconnects!
	for id, g := range curCluster.traffic {
		if _, online := curCluster.peers[id]; !online && g.isIdleExpired(now) {
			delete(curCluster.traffic, id)
		}
	}
	if len(curCluster.peers) == 0 && len(curCluster.traffic) == 0 {
		delete(h.clusters, clusterID)
	}
}

func (h *Hub) getOrCreateClusterLocked(clusterID string, now time.Time) *clusterBucket {
	if cb, ok := h.clusters[clusterID]; ok {
		return cb
	}
	cb := &clusterBucket{
		id:             clusterID,
		peers:          make(map[string]*peerEntry),
		traffic:        make(map[string]*nodeTrafficGuard),
		clusterLimiter: newRateLimiter(h.limits.ClusterRateBPS, h.limits.ClusterBurstBytes, now),
	}
	h.clusters[clusterID] = cb
	return cb
}

func (h *Hub) getOrCreatePeerLocked(cb *clusterBucket, nodeID, tier string, now time.Time) *peerEntry {
	nowMs := now.UnixMilli()
	if p, ok := cb.peers[nodeID]; ok {
		if tier != "" {
			p.info.Tier = tier
		}
		return p
	}
	guard, ok := cb.traffic[nodeID]
	if !ok {
		guard = newNodeTrafficGuard(h.limits, now)
		cb.traffic[nodeID] = guard
	}
	p := &peerEntry{
		info: PeerInfo{
			ClusterID:   cb.id,
			NodeID:      nodeID,
			Tier:        tier,
			PathMode:    "init",
			ConnectedAt: nowMs,
			LastSeen:    nowMs,
		},
		guard: guard,
	}
	cb.peers[nodeID] = p
	return p
}

func (h *Hub) sendSignalJSON(conn *ws.Conn, msg SignalMsg) error {
	b, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return conn.WriteText(b)
}

func EncodeRelayFrame(f RelayFrame) []byte {
	srcB := []byte(f.SrcID)
	dstB := []byte(f.DstID)
	out := make([]byte, FrameHeaderLen+len(srcB)+len(dstB)+len(f.Payload))
	out[0] = FrameMagic0
	out[1] = FrameMagic1
	out[2] = FrameVersion
	out[3] = f.Flags
	out[4] = byte(len(srcB))
	out[5] = byte(len(dstB))
	binary.BigEndian.PutUint32(out[6:10], uint32(len(f.Payload)))
	off := FrameHeaderLen
	copy(out[off:], srcB)
	off += len(srcB)
	copy(out[off:], dstB)
	off += len(dstB)
	copy(out[off:], f.Payload)
	return out
}

func DecodeRelayFrame(raw []byte) (RelayFrame, error) {
	if len(raw) < FrameHeaderLen {
		return RelayFrame{}, errors.New("frame too short")
	}
	if raw[0] != FrameMagic0 || raw[1] != FrameMagic1 || raw[2] != FrameVersion {
		return RelayFrame{}, errors.New("invalid magic or version")
	}
	srcLen := int(raw[4])
	dstLen := int(raw[5])
	payloadLen := int(binary.BigEndian.Uint32(raw[6:10]))
	if FrameHeaderLen+srcLen+dstLen+payloadLen != len(raw) {
		return RelayFrame{}, errors.New("length mismatch")
	}
	off := FrameHeaderLen
	src := string(raw[off : off+srcLen])
	off += srcLen
	dst := string(raw[off : off+dstLen])
	off += dstLen
	payload := raw[off:]
	return RelayFrame{
		Flags:   raw[3],
		SrcID:   src,
		DstID:   dst,
		Payload: payload,
	}, nil
}
