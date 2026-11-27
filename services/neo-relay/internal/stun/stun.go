package stun

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net"
	"sync"
	"time"

	"neo-relay/internal/auth"
)

const (
	stunMagicCookie uint32 = 0x2112A442
	stunBindReq     uint16 = 0x0001
	stunBindSuccess uint16 = 0x0101
	attrXorMapped   uint16 = 0x0020
	neoProbeMagic          = "NEO1"
)

type ipRateBucket struct {
	tokens   float64
	lastTick time.Time
}

type Server struct {
	conn    net.PacketConn
	secret  []byte
	onCount func(kind string)

	mu      sync.Mutex
	buckets map[string]*ipRateBucket
}

// ListenAndServe starts a combined RFC 5389 STUN + Neo authenticated UDP probe server.
func ListenAndServe(ctx context.Context, addr string, secret []byte, onCount func(kind string)) (*Server, error) {
	pc, err := net.ListenPacket("udp", addr)
	if err != nil {
		return nil, err
	}
	s := &Server{
		conn:    pc,
		secret:  secret,
		onCount: onCount,
		buckets: make(map[string]*ipRateBucket),
	}
	go s.serve(ctx)
	return s, nil
}

func (s *Server) Addr() net.Addr {
	return s.conn.LocalAddr()
}

func (s *Server) Close() error {
	return s.conn.Close()
}

func (s *Server) serve(ctx context.Context) {
	buf := make([]byte, 2048)
	for {
		select {
		case <-ctx.Done():
			_ = s.conn.Close()
			return
		default:
		}
		_ = s.conn.SetReadDeadline(time.Now().Add(1 * time.Second))
		n, peerAddr, err := s.conn.ReadFrom(buf)
		if err != nil {
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				continue
			}
			return
		}
		udpAddr, ok := peerAddr.(*net.UDPAddr)
		if !ok || !s.allowIP(udpAddr.IP.String()) {
			continue
		}
		pkt := buf[:n]
		if n >= 20 && binary.BigEndian.Uint16(pkt[0:2]) == stunBindReq &&
			binary.BigEndian.Uint32(pkt[4:8]) == stunMagicCookie {
			if s.onCount != nil {
				s.onCount("stun")
			}
			resp := BuildBindingResponse(pkt[8:20], udpAddr)
			if len(resp) > 0 {
				_, _ = s.conn.WriteTo(resp, udpAddr)
			}
			continue
		}
		if n > len(neoProbeMagic) && string(pkt[:len(neoProbeMagic)]) == neoProbeMagic {
			s.handleNeoProbe(pkt[len(neoProbeMagic):], udpAddr)
		}
	}
}

type probeReq struct {
	Token string `json:"token"`
	Nonce string `json:"nonce,omitempty"`
}

type probeResp struct {
	OK           bool   `json:"ok"`
	NodeID       string `json:"node_id,omitempty"`
	ObservedIP   string `json:"observed_ip"`
	ObservedPort int    `json:"observed_port"`
	ObservedAddr string `json:"observed_addr"`
	ServerTimeMs int64  `json:"server_time_ms"`
	Nonce        string `json:"nonce,omitempty"`
}

func (s *Server) handleNeoProbe(body []byte, peer *net.UDPAddr) {
	var req probeReq
	if err := json.Unmarshal(body, &req); err != nil {
		return
	}
	claims, err := auth.VerifyToken(s.secret, req.Token, time.Now())
	if err != nil {
		return
	}
	if s.onCount != nil {
		s.onCount("probe")
	}
	resp, err := json.Marshal(probeResp{
		OK:           true,
		NodeID:       claims.NodeID,
		ObservedIP:   peer.IP.String(),
		ObservedPort: peer.Port,
		ObservedAddr: net.JoinHostPort(peer.IP.String(), itoa(peer.Port)),
		ServerTimeMs: time.Now().UnixMilli(),
		Nonce:        req.Nonce,
	})
	if err != nil {
		return
	}
	out := append([]byte(neoProbeMagic), resp...)
	_, _ = s.conn.WriteTo(out, peer)
}

func (s *Server) allowIP(ip string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	if len(s.buckets) > 4096 {
		for k, v := range s.buckets {
			if now.Sub(v.lastTick) > 2*time.Minute {
				delete(s.buckets, k)
			}
		}
	}
	b, ok := s.buckets[ip]
	if !ok {
		s.buckets[ip] = &ipRateBucket{tokens: 19, lastTick: now}
		return true
	}
	elapsed := now.Sub(b.lastTick).Seconds()
	b.tokens += elapsed * 20.0
	if b.tokens > 20.0 {
		b.tokens = 20.0
	}
	b.lastTick = now
	if b.tokens < 1.0 {
		return false
	}
	b.tokens -= 1.0
	return true
}

// BuildBindingResponse creates an RFC 5389 Binding Success Response with XOR-MAPPED-ADDRESS.
func BuildBindingResponse(txID []byte, peer *net.UDPAddr) []byte {
	if len(txID) != 12 || peer == nil {
		return nil
	}
	var attr []byte
	if ip4 := peer.IP.To4(); ip4 != nil {
		attr = make([]byte, 12)
		binary.BigEndian.PutUint16(attr[0:2], attrXorMapped)
		binary.BigEndian.PutUint16(attr[2:4], 8)
		attr[4] = 0
		attr[5] = 0x01 // IPv4
		xPort := uint16(peer.Port) ^ uint16(stunMagicCookie>>16)
		binary.BigEndian.PutUint16(attr[6:8], xPort)
		var cookieBytes [4]byte
		binary.BigEndian.PutUint32(cookieBytes[:], stunMagicCookie)
		for i := 0; i < 4; i++ {
			attr[8+i] = ip4[i] ^ cookieBytes[i]
		}
	} else if ip6 := peer.IP.To16(); ip6 != nil {
		attr = make([]byte, 24)
		binary.BigEndian.PutUint16(attr[0:2], attrXorMapped)
		binary.BigEndian.PutUint16(attr[2:4], 20)
		attr[4] = 0
		attr[5] = 0x02 // IPv6
		xPort := uint16(peer.Port) ^ uint16(stunMagicCookie>>16)
		binary.BigEndian.PutUint16(attr[6:8], xPort)
		var xorMask [16]byte
		binary.BigEndian.PutUint32(xorMask[0:4], stunMagicCookie)
		copy(xorMask[4:16], txID)
		for i := 0; i < 16; i++ {
			attr[8+i] = ip6[i] ^ xorMask[i]
		}
	} else {
		return nil
	}

	resp := make([]byte, 20+len(attr))
	binary.BigEndian.PutUint16(resp[0:2], stunBindSuccess)
	binary.BigEndian.PutUint16(resp[2:4], uint16(len(attr)))
	binary.BigEndian.PutUint32(resp[4:8], stunMagicCookie)
	copy(resp[8:20], txID)
	copy(resp[20:], attr)
	return resp
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	var buf [12]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	return string(buf[i:])
}
