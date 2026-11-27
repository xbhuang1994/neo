package server

import (
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"time"

	"neo-relay/internal/auth"
	"neo-relay/internal/hub"
	"neo-relay/internal/ws"
)

type Config struct {
	KeyRing        auth.KeyRing
	PublicURL      string
	STUNServers    []string
	PunchTimeoutMs int
	MaxFrameBytes  int
}

type Server struct {
	cfg Config
	hub *hub.Hub
	mux *http.ServeMux
}

func New(cfg Config, h *hub.Hub) *Server {
	if cfg.PunchTimeoutMs <= 0 {
		cfg.PunchTimeoutMs = 2500
	}
	if cfg.MaxFrameBytes <= 0 {
		cfg.MaxFrameBytes = 1 << 20
	}
	s := &Server{
		cfg: cfg,
		hub: h,
		mux: http.NewServeMux(),
	}
	s.routes()
	return s
}

func (s *Server) Handler() http.Handler {
	return s.mux
}

func (s *Server) routes() {
	s.mux.HandleFunc("/healthz", s.handleHealthz)
	s.mux.HandleFunc("/v1/bootstrap", s.withAuth(s.handleBootstrap))
	s.mux.HandleFunc("/v1/whoami", s.withAuth(s.handleWhoAmI))
	s.mux.HandleFunc("/v1/peers", s.withAuth(s.handlePeers))
	s.mux.HandleFunc("/v1/stats", s.withAuth(s.handleStats))
	s.mux.HandleFunc("/v1/signal", s.withAuth(s.handleSignal))
	s.mux.HandleFunc("/v1/relay", s.withAuth(s.handleRelay))
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

func (s *Server) withAuth(next func(http.ResponseWriter, *http.Request, auth.Claims)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok, err := auth.ExtractRequestToken(r)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
			return
		}
		claims, err := auth.VerifyTokenWithKeyRing(s.cfg.KeyRing, tok, time.Now())
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
			return
		}
		next(w, r, claims)
	}
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
