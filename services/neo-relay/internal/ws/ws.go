package ws

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	OpContinuation = 0x0
	OpText         = 0x1
	OpBinary       = 0x2
	OpClose        = 0x8
	OpPing         = 0x9
	OpPong         = 0xA

	wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
)

var (
	ErrClosed       = errors.New("websocket closed")
	ErrFrameTooBig  = errors.New("websocket frame exceeds max size")
	ErrProtocol     = errors.New("websocket protocol error")
)

type Conn struct {
	rwc      net.Conn
	br       *bufio.Reader
	isClient bool
	maxFrame int
	writeMu  sync.Mutex
	closeMu  sync.Mutex
	closed   bool
}

// Accept upgrades an incoming HTTP request to RFC 6455 WebSocket.
func Accept(w http.ResponseWriter, r *http.Request, maxFrame int) (*Conn, error) {
	if !headerContainsToken(r.Header.Get("Connection"), "upgrade") ||
		!strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), "websocket") {
		http.Error(w, "upgrade required", http.StatusUpgradeRequired)
		return nil, ErrProtocol
	}
	if strings.TrimSpace(r.Header.Get("Sec-WebSocket-Version")) != "13" {
		http.Error(w, "unsupported websocket version", http.StatusBadRequest)
		return nil, ErrProtocol
	}
	key := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	if key == "" {
		http.Error(w, "missing Sec-WebSocket-Key", http.StatusBadRequest)
		return nil, ErrProtocol
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijacking unsupported", http.StatusInternalServerError)
		return nil, ErrProtocol
	}
	netConn, bufRW, err := hj.Hijack()
	if err != nil {
		return nil, err
	}

	acceptKey := computeAcceptKey(key)
	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + acceptKey + "\r\n\r\n"
	if _, err := netConn.Write([]byte(resp)); err != nil {
		_ = netConn.Close()
		return nil, err
	}
	if maxFrame <= 0 {
		maxFrame = 1 << 20
	}
	return &Conn{
		rwc:      netConn,
		br:       bufRW.Reader,
		isClient: false,
		maxFrame: maxFrame,
	}, nil
}

// Dial connects a minimal RFC 6455 WebSocket client (used in tests & smoke tool).
func Dial(rawURL string, headers http.Header, tlsCfg *tls.Config, timeout time.Duration) (*Conn, *http.Response, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, nil, err
	}
	host := u.Host
	var dialAddr string
	var useTLS bool
	switch strings.ToLower(u.Scheme) {
	case "ws", "http":
		if !strings.Contains(host, ":") {
			host += ":80"
		}
		dialAddr = host
	case "wss", "https":
		useTLS = true
		if !strings.Contains(host, ":") {
			host += ":443"
		}
		dialAddr = host
	default:
		return nil, nil, fmt.Errorf("unsupported scheme %q", u.Scheme)
	}
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	dialer := &net.Dialer{Timeout: timeout}
	var conn net.Conn
	if useTLS {
		cfg := tlsCfg
		if cfg == nil {
			cfg = &tls.Config{}
		} else {
			cfg = cfg.Clone()
		}
		if cfg.ServerName == "" {
			hostname, _, _ := net.SplitHostPort(dialAddr)
			cfg.ServerName = hostname
		}
		conn, err = tls.DialWithDialer(dialer, "tcp", dialAddr, cfg)
	} else {
		conn, err = dialer.Dial("tcp", dialAddr)
	}
	if err != nil {
		return nil, nil, err
	}
	_ = conn.SetDeadline(time.Now().Add(timeout))

	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		_ = conn.Close()
		return nil, nil, err
	}
	wsKey := base64.StdEncoding.EncodeToString(nonce)
	path := u.RequestURI()
	if path == "" {
		path = "/"
	}

	var reqBuf strings.Builder
	reqBuf.WriteString("GET " + path + " HTTP/1.1\r\n")
	reqBuf.WriteString("Host: " + u.Host + "\r\n")
	reqBuf.WriteString("Upgrade: websocket\r\n")
	reqBuf.WriteString("Connection: Upgrade\r\n")
	reqBuf.WriteString("Sec-WebSocket-Key: " + wsKey + "\r\n")
	reqBuf.WriteString("Sec-WebSocket-Version: 13\r\n")
	for k, vals := range headers {
		for _, v := range vals {
			reqBuf.WriteString(k + ": " + v + "\r\n")
		}
	}
	reqBuf.WriteString("\r\n")
	if _, err := conn.Write([]byte(reqBuf.String())); err != nil {
		_ = conn.Close()
		return nil, nil, err
	}

	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodGet})
	if err != nil {
		_ = conn.Close()
		return nil, nil, err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		_ = conn.Close()
		return nil, resp, fmt.Errorf("unexpected HTTP status: %s", resp.Status)
	}
	if strings.TrimSpace(resp.Header.Get("Sec-WebSocket-Accept")) != computeAcceptKey(wsKey) {
		_ = conn.Close()
		return nil, resp, ErrProtocol
	}
	_ = conn.SetDeadline(time.Time{})
	return &Conn{
		rwc:      conn,
		br:       br,
		isClient: true,
		maxFrame: 2 << 20,
	}, resp, nil
}

func (c *Conn) SetReadDeadline(t time.Time) error {
	return c.rwc.SetReadDeadline(t)
}

func (c *Conn) SetWriteDeadline(t time.Time) error {
	return c.rwc.SetWriteDeadline(t)
}

func (c *Conn) Close() error {
	c.closeMu.Lock()
	if c.closed {
		c.closeMu.Unlock()
		return nil
	}
	c.closed = true
	c.closeMu.Unlock()
	_ = c.WriteControl(OpClose, nil)
	return c.rwc.Close()
}

func (c *Conn) ReadMessage() (byte, []byte, error) {
	var msgOp byte
	var assembled []byte
	for {
		fin, op, payload, err := c.readFrame()
		if err != nil {
			return 0, nil, err
		}
		switch op {
		case OpPing:
			_ = c.WriteControl(OpPong, payload)
			continue
		case OpPong:
			continue
		case OpClose:
			return 0, nil, ErrClosed
		case OpText, OpBinary:
			if msgOp != 0 {
				return 0, nil, ErrProtocol
			}
			msgOp = op
			assembled = payload
		case OpContinuation:
			if msgOp == 0 {
				return 0, nil, ErrProtocol
			}
			if len(assembled)+len(payload) > c.maxFrame {
				return 0, nil, ErrFrameTooBig
			}
			assembled = append(assembled, payload...)
		default:
			return 0, nil, ErrProtocol
		}
		if fin {
			return msgOp, assembled, nil
		}
	}
}

func (c *Conn) WriteText(data []byte) error {
	return c.writeFrame(OpText, data)
}

func (c *Conn) WriteBinary(data []byte) error {
	return c.writeFrame(OpBinary, data)
}

func (c *Conn) WriteControl(op byte, payload []byte) error {
	if len(payload) > 125 {
		payload = payload[:125]
	}
	return c.writeFrame(op, payload)
}

func (c *Conn) readFrame() (bool, byte, []byte, error) {
	var hdr [2]byte
	if _, err := io.ReadFull(c.br, hdr[:]); err != nil {
		return false, 0, nil, err
	}
	fin := (hdr[0] & 0x80) != 0
	op := hdr[0] & 0x0F
	masked := (hdr[1] & 0x80) != 0
	length := uint64(hdr[1] & 0x7F)

	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		length = binary.BigEndian.Uint64(ext[:])
	}
	if length > uint64(c.maxFrame) {
		return false, 0, nil, ErrFrameTooBig
	}
	if !c.isClient && !masked {
		return false, 0, nil, ErrProtocol
	}
	var maskKey [4]byte
	if masked {
		if _, err := io.ReadFull(c.br, maskKey[:]); err != nil {
			return false, 0, nil, err
		}
	}
	payload := make([]byte, int(length))
	if length > 0 {
		if _, err := io.ReadFull(c.br, payload); err != nil {
			return false, 0, nil, err
		}
		if masked {
			for i := range payload {
				payload[i] ^= maskKey[i%4]
			}
		}
	}
	return fin, op, payload, nil
}

func (c *Conn) writeFrame(op byte, payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	header := make([]byte, 0, 14)
	header = append(header, 0x80|op)
	n := len(payload)
	maskBit := byte(0)
	if c.isClient {
		maskBit = 0x80
	}
	switch {
	case n < 126:
		header = append(header, maskBit|byte(n))
	case n <= 65535:
		header = append(header, maskBit|126, byte(n>>8), byte(n))
	default:
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(n))
		header = append(header, maskBit|127)
		header = append(header, ext[:]...)
	}

	var out []byte
	if c.isClient {
		var maskKey [4]byte
		_, _ = rand.Read(maskKey[:])
		header = append(header, maskKey[:]...)
		out = make([]byte, len(header)+n)
		copy(out, header)
		for i := 0; i < n; i++ {
			out[len(header)+i] = payload[i] ^ maskKey[i%4]
		}
	} else {
		out = make([]byte, len(header)+n)
		copy(out, header)
		copy(out[len(header):], payload)
	}
	_ = c.rwc.SetWriteDeadline(time.Now().Add(15 * time.Second))
	_, err := c.rwc.Write(out)
	return err
}

func computeAcceptKey(key string) string {
	h := sha1.New()
	_, _ = h.Write([]byte(key + wsGUID))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

func headerContainsToken(hdr, target string) bool {
	for _, part := range strings.Split(hdr, ",") {
		if strings.EqualFold(strings.TrimSpace(part), target) {
			return true
		}
	}
	return false
}
