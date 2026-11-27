package server

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"neo-relay/internal/auth"
	"neo-relay/internal/enroll"
	"neo-relay/internal/hub"
	"neo-relay/internal/ws"
)

const maxEnrollCreateBodyBytes = 128 << 10 // 128 KiB (well above 24 KiB ciphertext cap)

type Config struct {
	KeyRing        auth.KeyRing
	PublicURL      string
	STUNServers    []string
	PunchTimeoutMs int
	MaxFrameBytes  int
	EnrollStore    *enroll.Store
	Mirror         *enroll.Mirror
}

type Server struct {
	cfg         Config
	keyRing     atomic.Pointer[auth.KeyRing]
	hub         *hub.Hub
	enrollStore *enroll.Store
	mirror      *enroll.Mirror
	mux         *http.ServeMux
}

func New(cfg Config, h *hub.Hub) *Server {
	if cfg.PunchTimeoutMs <= 0 {
		cfg.PunchTimeoutMs = 2500
	}
	if cfg.MaxFrameBytes <= 0 {
		cfg.MaxFrameBytes = 1 << 20
	}
	enrollStore := cfg.EnrollStore
	if enrollStore == nil {
		enrollStore = enroll.NewStore()
	}
	mirror := cfg.Mirror
	if mirror == nil {
		mirror = enroll.NewMirror(enroll.MirrorConfig{})
	}
	s := &Server{
		cfg:         cfg,
		hub:         h,
		enrollStore: enrollStore,
		mirror:      mirror,
		mux:         http.NewServeMux(),
	}
	s.UpdateKeyRing(cfg.KeyRing)
	s.routes()
	return s
}

// UpdateKeyRing atomically swaps the active KeyRing without disrupting active WebSocket connections.
func (s *Server) UpdateKeyRing(kr auth.KeyRing) {
	cp := cloneKeyRing(kr)
	s.keyRing.Store(&cp)
}

func (s *Server) currentKeyRing() auth.KeyRing {
	if kr := s.keyRing.Load(); kr != nil {
		return *kr
	}
	return auth.KeyRing{}
}

func cloneKeyRing(kr auth.KeyRing) auth.KeyRing {
	out := auth.KeyRing{}
	if len(kr.RootSecret) > 0 {
		out.RootSecret = append([]byte(nil), kr.RootSecret...)
	}
	if len(kr.ClusterSecrets) > 0 {
		out.ClusterSecrets = make(map[string][]byte, len(kr.ClusterSecrets))
		for k, v := range kr.ClusterSecrets {
			out.ClusterSecrets[k] = append([]byte(nil), v...)
		}
	}
	return out
}

func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/dl/") || strings.HasPrefix(r.URL.EscapedPath(), "/dl/") {
			s.mirror.ServeHTTP(w, r)
			return
		}
		s.mux.ServeHTTP(w, r)
	})
}

func (s *Server) routes() {
	s.mux.HandleFunc("/healthz", s.handleHealthz)
	s.mux.HandleFunc("/install.sh", s.handleInstallSh)
	s.mux.HandleFunc("/install.ps1", s.handleInstallPs1)
	s.mux.HandleFunc("/v1/bootstrap", s.withAuth(s.handleBootstrap))
	s.mux.HandleFunc("/v1/whoami", s.withAuth(s.handleWhoAmI))
	s.mux.HandleFunc("/v1/peers", s.withAuth(s.handlePeers))
	s.mux.HandleFunc("/v1/stats", s.withAuth(s.handleStats))
	s.mux.HandleFunc("/v1/signal", s.withAuth(s.handleSignal))
	s.mux.HandleFunc("/v1/relay", s.withAuth(s.handleRelay))
	s.mux.HandleFunc("POST /v1/enroll/tickets", s.withAuth(s.handleEnrollCreate))
	s.mux.HandleFunc("GET /v1/enroll/tickets/{id}/status", s.withAuth(s.handleEnrollStatus))
	s.mux.HandleFunc("DELETE /v1/enroll/tickets/{id}", s.withAuth(s.handleEnrollDelete))
	s.mux.HandleFunc("POST /v1/enroll/claim/{id}", s.handleEnrollClaim)
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"service": "neo-relay",
	})
}

func (s *Server) handleInstallSh(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	script := enroll.RenderInstallSh(s.publicBaseURL(r))
	w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write([]byte(script))
	}
}

func (s *Server) handleInstallPs1(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	script := enroll.RenderInstallPs1(s.publicBaseURL(r))
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write([]byte(script))
	}
}

func (s *Server) withAuth(next func(http.ResponseWriter, *http.Request, auth.Claims)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok, err := auth.ExtractRequestToken(r)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
			return
		}
		claims, err := auth.VerifyTokenWithKeyRing(s.currentKeyRing(), tok, time.Now())
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
			return
		}
		next(w, r, claims)
	}
}

func (s *Server) handleEnrollCreate(w http.ResponseWriter, r *http.Request, claims auth.Claims) {
	w.Header().Set("Cache-Control", "no-store")
	if claims.Tier != "master" || claims.ClusterID == "*" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "master tier with explicit cluster_id required"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxEnrollCreateBodyBytes)
	var req struct {
		TicketID      string `json:"ticket_id"`
		CiphertextB64 string `json:"ciphertext_b64"`
		TTLSec        int    `json:"ttl_sec"`
		MaxUses       int    `json:"max_uses"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	resp, err := s.enrollStore.Create(claims.ClusterID, req.TicketID, req.CiphertextB64, req.TTLSec, req.MaxUses)
	if err != nil {
		switch {
		case errors.Is(err, enroll.ErrInvalidTicketID),
			errors.Is(err, enroll.ErrInvalidCiphertext),
			errors.Is(err, enroll.ErrInvalidTTL),
			errors.Is(err, enroll.ErrInvalidMaxUses):
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		case errors.Is(err, enroll.ErrTicketExists):
			writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		case errors.Is(err, enroll.ErrClusterTicketLimit):
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": err.Error()})
		default:
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		}
		return
	}
	writeJSON(w, http.StatusCreated, resp)
}

func (s *Server) handleEnrollStatus(w http.ResponseWriter, r *http.Request, claims auth.Claims) {
	w.Header().Set("Cache-Control", "no-store")
	if claims.Tier != "master" || claims.ClusterID == "*" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "master tier with explicit cluster_id required"})
		return
	}
	id := r.PathValue("id")
	if !enroll.ValidTicketID(id) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": enroll.ErrInvalidTicketID.Error()})
		return
	}

	status, err := s.enrollStore.Status(claims.ClusterID, id)
	if err != nil {
		switch {
		case errors.Is(err, enroll.ErrTicketNotFound):
			writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		case errors.Is(err, enroll.ErrForbiddenCluster):
			writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
		default:
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		}
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (s *Server) handleEnrollDelete(w http.ResponseWriter, r *http.Request, claims auth.Claims) {
	w.Header().Set("Cache-Control", "no-store")
	if claims.Tier != "master" || claims.ClusterID == "*" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "master tier with explicit cluster_id required"})
		return
	}
	id := r.PathValue("id")
	if !enroll.ValidTicketID(id) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": enroll.ErrInvalidTicketID.Error()})
		return
	}

	resp, err := s.enrollStore.Revoke(claims.ClusterID, id)
	if err != nil {
		switch {
		case errors.Is(err, enroll.ErrTicketNotFound):
			writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		case errors.Is(err, enroll.ErrForbiddenCluster):
			writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
		default:
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		}
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleEnrollClaim(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	id := r.PathValue("id")
	resp, err := s.enrollStore.Claim(id, clientIP(r))
	if err != nil {
		switch {
		case errors.Is(err, enroll.ErrRateLimited):
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": err.Error()})
		case errors.Is(err, enroll.ErrTicketNotFound):
			writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		case errors.Is(err, enroll.ErrTicketExpired),
			errors.Is(err, enroll.ErrTicketRevoked),
			errors.Is(err, enroll.ErrTicketClaimed):
			writeJSON(w, http.StatusGone, map[string]string{"error": err.Error()})
		default:
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		}
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleBootstrap(w http.ResponseWriter, r *http.Request, claims auth.Claims) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	wsBase := s.wsBaseURL(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"cluster_id":       claims.ClusterID,
		"node_id":          claims.NodeID,
		"tier":             claims.Tier,
		"signal_url":       wsBase + "/v1/signal",
		"relay_url":        wsBase + "/v1/relay",
		"stun_servers":     s.cfg.STUNServers,
		"punch_timeout_ms": s.cfg.PunchTimeoutMs,
		"relay_fallback":   true,
		"server_time_ms":   time.Now().UnixMilli(),
	})
}

func (s *Server) handleWhoAmI(w http.ResponseWriter, r *http.Request, claims auth.Claims) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"cluster_id":     claims.ClusterID,
		"node_id":        claims.NodeID,
		"tier":           claims.Tier,
		"observed_ip":    clientIP(r),
		"server_time_ms": time.Now().UnixMilli(),
	})
}

func (s *Server) handlePeers(w http.ResponseWriter, r *http.Request, claims auth.Claims) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	peers := s.hub.ListPeers(claims.ClusterID)
	writeJSON(w, http.StatusOK, map[string]any{
		"cluster_id": claims.ClusterID,
		"count":      len(peers),
		"peers":      peers,
	})
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request, claims auth.Claims) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, s.hub.Stats(claims.ClusterID))
}

func (s *Server) handleSignal(w http.ResponseWriter, r *http.Request, claims auth.Claims) {
	if claims.ClusterID == "*" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "wildcard cluster cannot join signal"})
		return
	}
	conn, err := ws.Accept(w, r, s.cfg.MaxFrameBytes)
	if err != nil {
		return
	}
	s.hub.ServeSignal(claims.ClusterID, claims.NodeID, claims.Tier, conn)
}

func (s *Server) handleRelay(w http.ResponseWriter, r *http.Request, claims auth.Claims) {
	if claims.ClusterID == "*" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "wildcard cluster cannot join relay"})
		return
	}
	conn, err := ws.Accept(w, r, s.cfg.MaxFrameBytes)
	if err != nil {
		return
	}
	s.hub.ServeRelay(claims.ClusterID, claims.NodeID, claims.Tier, conn)
}

func (s *Server) publicBaseURL(r *http.Request) string {
	base := strings.TrimRight(strings.TrimSpace(s.cfg.PublicURL), "/")
	if base != "" {
		return base
	}
	scheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

func (s *Server) wsBaseURL(r *http.Request) string {
	base := strings.TrimRight(s.cfg.PublicURL, "/")
	if base == "" {
		scheme := "ws"
		if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
			scheme = "wss"
		}
		return scheme + "://" + r.Host
	}
	if strings.HasPrefix(base, "https://") {
		return "wss://" + strings.TrimPrefix(base, "https://")
	}
	if strings.HasPrefix(base, "http://") {
		return "ws://" + strings.TrimPrefix(base, "http://")
	}
	return base
}

func clientIP(r *http.Request) string {
	if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
		parts := strings.Split(xff, ",")
		if len(parts) > 0 && strings.TrimSpace(parts[0]) != "" {
			return strings.TrimSpace(parts[0])
		}
	}
	if xri := strings.TrimSpace(r.Header.Get("X-Real-IP")); xri != "" {
		return xri
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
