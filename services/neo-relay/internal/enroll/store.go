package enroll

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	DefaultTTLSec                = 600
	MinTTLSec                    = 60
	MaxTTLSec                    = 86400
	DefaultMaxUses               = 1
	MinMaxUses                   = 1
	MaxMaxUses                   = 50
	MaxActiveTicketsPerCluster   = 20
	MaxCiphertextLen             = 24576
	MetadataRetentionAfterExpiry = 1 * time.Hour
	DefaultClaimRatePerMin       = 20
	maxTrackedIPBuckets          = 100000

	StatusPending = "pending"
	StatusClaimed = "claimed"
	StatusExpired = "expired"
	StatusRevoked = "revoked"
)

var (
	ErrInvalidTicketID    = errors.New("invalid ticket_id")
	ErrInvalidCiphertext  = errors.New("invalid ciphertext_b64")
	ErrInvalidTTL         = errors.New("ttl_sec must be in [60, 86400]")
	ErrInvalidMaxUses     = errors.New("max_uses must be in [1, 50]")
	ErrTicketExists       = errors.New("ticket_id already exists")
	ErrClusterTicketLimit = errors.New("cluster active ticket limit exceeded")
	ErrTicketNotFound     = errors.New("ticket not found")
	ErrForbiddenCluster   = errors.New("ticket belongs to another cluster")
	ErrTicketExpired      = errors.New("ticket expired")
	ErrTicketRevoked      = errors.New("ticket revoked")
	ErrTicketClaimed      = errors.New("ticket already claimed")
	ErrRateLimited        = errors.New("rate limit exceeded")
)

var ticketIDRegex = regexp.MustCompile(`^[A-Za-z0-9_-]{8,32}$`)

// ValidTicketID reports whether id matches ^[A-Za-z0-9_-]{8,32}$.
func ValidTicketID(id string) bool {
	return ticketIDRegex.MatchString(id)
}

type CreateResponse struct {
	TicketID      string `json:"ticket_id"`
	ClusterID     string `json:"cluster_id"`
	Status        string `json:"status"`
	ExpiresAtMs   int64  `json:"expires_at_ms"`
	MaxUses       int    `json:"max_uses"`
	RemainingUses int    `json:"remaining_uses"`
}

type TicketStatus struct {
	TicketID        string `json:"ticket_id"`
	ClusterID       string `json:"cluster_id"`
	Status          string `json:"status"`
	MaxUses         int    `json:"max_uses"`
	RemainingUses   int    `json:"remaining_uses"`
	ClaimedCount    int    `json:"claimed_count"`
	LastClaimedIP   string `json:"last_claimed_ip"`
	LastClaimedAtMs int64  `json:"last_claimed_at_ms"`
	ExpiresAtMs     int64  `json:"expires_at_ms"`
}

type RevokeResponse struct {
	TicketID string `json:"ticket_id"`
	Status   string `json:"status"`
}

type ClaimResponse struct {
	TicketID      string `json:"ticket_id"`
	CiphertextB64 string `json:"ciphertext_b64"`
	ExpiresAtMs   int64  `json:"expires_at_ms"`
}

type ticket struct {
	id              string
	clusterID       string
	ciphertext      []byte
	status          string
	maxUses         int
	remainingUses   int
	claimedCount    int
	lastClaimedIP   string
	lastClaimedAtMs int64
	expiresAt       time.Time
}

func (t *ticket) wipeCiphertext() {
	if len(t.ciphertext) > 0 {
		clear(t.ciphertext)
		t.ciphertext = nil
	}
}

type ipBucket struct {
	tokens   float64
	lastSeen time.Time
}

// Store holds zero-trust opaque enrollment tickets strictly in memory.
// Ciphertext bytes are zeroed immediately upon final claim, revocation, or expiry.
type Store struct {
	mu           sync.Mutex
	tickets      map[string]*ticket
	ipBuckets    map[string]*ipBucket
	claimRate    float64 // tokens per minute (also burst capacity)
	lastBucketGC time.Time
	nowFn        func() time.Time
}

// NewStore creates an in-memory enrollment ticket store with the default per-IP claim rate limit.
func NewStore() *Store {
	return NewStoreWithRate(DefaultClaimRatePerMin)
}

// NewStoreWithRate creates a store with a custom per-IP claim rate limit (requests per minute).
func NewStoreWithRate(claimRatePerMin int) *Store {
	if claimRatePerMin <= 0 {
		claimRatePerMin = DefaultClaimRatePerMin
	}
	return &Store{
		tickets:   make(map[string]*ticket),
		ipBuckets: make(map[string]*ipBucket),
		claimRate: float64(claimRatePerMin),
		nowFn:     time.Now,
	}
}

// SetClock overrides the clock source (intended for deterministic tests).
func (s *Store) SetClock(fn func() time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if fn == nil {
		s.nowFn = time.Now
		return
	}
	s.nowFn = fn
}

// StartGC launches a periodic background garbage-collection goroutine that
// wipes expired ciphertexts and prunes metadata 1 hour past expiry.
func (s *Store) StartGC(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.GC()
			}
		}
	}()
}

// GC immediately runs garbage collection against the current clock.
func (s *Store) GC() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gcLocked(s.nowFn())
}

// Create stores a new opaque ciphertext ticket scoped to clusterID.
func (s *Store) Create(clusterID, ticketID, ciphertextB64 string, ttlSec, maxUses int) (CreateResponse, error) {
	if !ValidTicketID(ticketID) {
		return CreateResponse{}, ErrInvalidTicketID
	}
	if strings.TrimSpace(ciphertextB64) == "" || len(ciphertextB64) > MaxCiphertextLen {
		return CreateResponse{}, ErrInvalidCiphertext
	}
	if ttlSec == 0 {
		ttlSec = DefaultTTLSec
	}
	if ttlSec < MinTTLSec || ttlSec > MaxTTLSec {
		return CreateResponse{}, ErrInvalidTTL
	}
	if maxUses == 0 {
		maxUses = DefaultMaxUses
	}
	if maxUses < MinMaxUses || maxUses > MaxMaxUses {
		return CreateResponse{}, ErrInvalidMaxUses
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.nowFn()
	s.gcLocked(now)

	if _, exists := s.tickets[ticketID]; exists {
		return CreateResponse{}, ErrTicketExists
	}

	activeCount := 0
	for _, t := range s.tickets {
		if t.clusterID == clusterID && t.status == StatusPending && t.remainingUses > 0 && now.Before(t.expiresAt) {
			activeCount++
		}
	}
	if activeCount >= MaxActiveTicketsPerCluster {
		return CreateResponse{}, ErrClusterTicketLimit
	}

	ct := make([]byte, len(ciphertextB64))
	copy(ct, ciphertextB64)
	expiresAt := now.Add(time.Duration(ttlSec) * time.Second)

	s.tickets[ticketID] = &ticket{
		id:            ticketID,
		clusterID:     clusterID,
		ciphertext:    ct,
		status:        StatusPending,
		maxUses:       maxUses,
		remainingUses: maxUses,
		expiresAt:     expiresAt,
	}

	return CreateResponse{
		TicketID:      ticketID,
		ClusterID:     clusterID,
		Status:        StatusPending,
		ExpiresAtMs:   expiresAt.UnixMilli(),
		MaxUses:       maxUses,
		RemainingUses: maxUses,
	}, nil
}

// Status returns metadata for ticketID if it belongs to clusterID.
func (s *Store) Status(clusterID, ticketID string) (TicketStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.nowFn()
	s.gcLocked(now)

	t, ok := s.tickets[ticketID]
	if !ok {
		return TicketStatus{}, ErrTicketNotFound
	}
	if t.clusterID != clusterID {
		return TicketStatus{}, ErrForbiddenCluster
	}
	return TicketStatus{
		TicketID:        t.id,
		ClusterID:       t.clusterID,
		Status:          t.status,
		MaxUses:         t.maxUses,
		RemainingUses:   t.remainingUses,
		ClaimedCount:    t.claimedCount,
		LastClaimedIP:   t.lastClaimedIP,
		LastClaimedAtMs: t.lastClaimedAtMs,
		ExpiresAtMs:     t.expiresAt.UnixMilli(),
	}, nil
}

// Revoke immediately wipes ciphertext and marks the ticket revoked if owned by clusterID.
func (s *Store) Revoke(clusterID, ticketID string) (RevokeResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.nowFn()
	s.gcLocked(now)

	t, ok := s.tickets[ticketID]
	if !ok {
		return RevokeResponse{}, ErrTicketNotFound
	}
	if t.clusterID != clusterID {
		return RevokeResponse{}, ErrForbiddenCluster
	}

	t.wipeCiphertext()
	t.status = StatusRevoked

	return RevokeResponse{
		TicketID: t.id,
		Status:   StatusRevoked,
	}, nil
}

// Claim atomically consumes one use of ticketID (subject to per-IP rate limiting)
// and returns the opaque ciphertext. When remaining_uses hits 0, ciphertext is wiped.
func (s *Store) Claim(ticketID, clientIP string) (ClaimResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.nowFn()
	if !s.allowIPLocked(clientIP, now) {
		return ClaimResponse{}, ErrRateLimited
	}
	s.gcLocked(now)

	t, ok := s.tickets[ticketID]
	if !ok {
		return ClaimResponse{}, ErrTicketNotFound
	}
	switch {
	case t.status == StatusRevoked:
		return ClaimResponse{}, ErrTicketRevoked
	case t.status == StatusClaimed || t.remainingUses <= 0:
		return ClaimResponse{}, ErrTicketClaimed
	case t.status == StatusExpired || !now.Before(t.expiresAt):
		t.wipeCiphertext()
		t.status = StatusExpired
		return ClaimResponse{}, ErrTicketExpired
	}

	ciphertext := string(t.ciphertext)
	t.remainingUses--
	t.claimedCount++
	t.lastClaimedIP = clientIP
	t.lastClaimedAtMs = now.UnixMilli()
	if t.remainingUses == 0 {
		t.wipeCiphertext()
		t.status = StatusClaimed
	}

	return ClaimResponse{
		TicketID:      t.id,
		CiphertextB64: ciphertext,
		ExpiresAtMs:   t.expiresAt.UnixMilli(),
	}, nil
}

func (s *Store) allowIPLocked(ip string, now time.Time) bool {
	if ip == "" {
		ip = "unknown"
	}
	if len(s.ipBuckets) >= maxTrackedIPBuckets {
		s.pruneBucketsLocked(now)
	}
	b, ok := s.ipBuckets[ip]
	if !ok {
		s.ipBuckets[ip] = &ipBucket{
			tokens:   s.claimRate - 1.0,
			lastSeen: now,
		}
		return true
	}
	elapsed := now.Sub(b.lastSeen).Seconds()
	if elapsed > 0 {
		refill := elapsed * (s.claimRate / 60.0)
		b.tokens += refill
		if b.tokens > s.claimRate {
			b.tokens = s.claimRate
		}
		b.lastSeen = now
	}
	if b.tokens < 1.0 {
		return false
	}
	b.tokens -= 1.0
	return true
}

func (s *Store) gcLocked(now time.Time) {
	for id, t := range s.tickets {
		if !now.Before(t.expiresAt) {
			t.wipeCiphertext()
			if t.status == StatusPending {
				t.status = StatusExpired
			}
			if !now.Before(t.expiresAt.Add(MetadataRetentionAfterExpiry)) {
				delete(s.tickets, id)
			}
		}
	}
	if len(s.ipBuckets) > 0 && (s.lastBucketGC.IsZero() || now.Sub(s.lastBucketGC) >= time.Minute) {
		s.pruneBucketsLocked(now)
	}
}

func (s *Store) pruneBucketsLocked(now time.Time) {
	s.lastBucketGC = now
	for ip, b := range s.ipBuckets {
		if now.Sub(b.lastSeen) > 10*time.Minute {
			delete(s.ipBuckets, ip)
		}
	}
}
