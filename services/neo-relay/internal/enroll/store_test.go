package enroll

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
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
)

func TestStoreValidationAndLimits(t *testing.T) {
	store := NewStore()

	// Invalid ticket IDs
	for _, badID := range []string{"", "short77", strings.Repeat("a", 33), "bad.dot123", "bad/slash1", "bad space1", "bad@char12"} {
		if _, err := store.Create("c1", badID, "Y2lwaGVy", 600, 1); err != ErrInvalidTicketID {
			t.Fatalf("ticket_id %q: got err=%v, want ErrInvalidTicketID", badID, err)
		}
	}

	// Boundary valid ticket IDs (8 and 32 chars)
	if _, err := store.Create("c1", "abcd1234", "Y2lwaGVy", 0, 0); err != nil {
		t.Fatalf("valid 8-char id failed: %v", err)
	}
	if _, err := store.Create("c1", strings.Repeat("Z", 32), "Y2lwaGVy", 60, 50); err != nil {
		t.Fatalf("valid 32-char id failed: %v", err)
	}

	// Duplicate ticket ID (even across clusters)
	if _, err := store.Create("c2", "abcd1234", "Y2lwaGVy", 600, 1); err != ErrTicketExists {
		t.Fatalf("duplicate id: got err=%v, want ErrTicketExists", err)
	}

	// Ciphertext validation
	if _, err := store.Create("c1", "emptyct01", "   ", 600, 1); err != ErrInvalidCiphertext {
		t.Fatalf("empty ciphertext: got err=%v, want ErrInvalidCiphertext", err)
	}
	if _, err := store.Create("c1", "exactmax1", strings.Repeat("A", MaxCiphertextLen), 600, 1); err != nil {
		t.Fatalf("exact max ciphertext failed: %v", err)
	}
	if _, err := store.Create("c1", "overmax01", strings.Repeat("A", MaxCiphertextLen+1), 600, 1); err != ErrInvalidCiphertext {
		t.Fatalf("oversized ciphertext: got err=%v, want ErrInvalidCiphertext", err)
	}

	// TTL validation
	for _, badTTL := range []int{-1, 1, 59, 86401} {
		if _, err := store.Create("c1", "badttl001", "Y2lwaGVy", badTTL, 1); err != ErrInvalidTTL {
			t.Fatalf("ttl=%d: got err=%v, want ErrInvalidTTL", badTTL, err)
		}
	}
	if _, err := store.Create("c1", "maxttl001", "Y2lwaGVy", MaxTTLSec, 1); err != nil {
		t.Fatalf("max ttl failed: %v", err)
	}

	// MaxUses validation
	for _, badUses := range []int{-1, 51, 999} {
		if _, err := store.Create("c1", "baduses01", "Y2lwaGVy", 600, badUses); err != ErrInvalidMaxUses {
			t.Fatalf("max_uses=%d: got err=%v, want ErrInvalidMaxUses", badUses, err)
		}
	}

	// Per-cluster active ticket limit (20 active max)
	store2 := NewStore()
	for i := 0; i < MaxActiveTicketsPerCluster; i++ {
		id := fmt.Sprintf("ticket_%02d_abc", i)
		if _, err := store2.Create("cluster-a", id, "Y2lwaGVy", 600, 1); err != nil {
			t.Fatalf("create %d failed: %v", i, err)
		}
	}
	if _, err := store2.Create("cluster-a", "ticket_21_abc", "Y2lwaGVy", 600, 1); err != ErrClusterTicketLimit {
		t.Fatalf("21st active ticket: got err=%v, want ErrClusterTicketLimit", err)
	}
	// Another cluster is unaffected
	if _, err := store2.Create("cluster-b", "ticket_b1_abc", "Y2lwaGVy", 600, 1); err != nil {
		t.Fatalf("cluster-b ticket failed: %v", err)
	}
	// Revoking one ticket in cluster-a frees a slot
	if _, err := store2.Revoke("cluster-a", "ticket_00_abc"); err != nil {
		t.Fatalf("revoke failed: %v", err)
	}
	if _, err := store2.Create("cluster-a", "ticket_21_abc", "Y2lwaGVy", 600, 1); err != nil {
		t.Fatalf("create after revoke failed: %v", err)
	}
}

func TestStoreLifecycleCiphertextWipeAndGC(t *testing.T) {
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	var mu sync.Mutex
	getNow := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return now
	}
	advance := func(d time.Duration) {
		mu.Lock()
		now = now.Add(d)
		mu.Unlock()
	}

	store := NewStore()
	store.SetClock(getNow)

	// 1. Single-use ticket
	created, err := store.Create("cluster-a", "single_use_01", "c2VjcmV0LWNpcGhlcnRleHQ=", 0, 0)
	if err != nil {
		t.Fatalf("create single-use: %v", err)
	}
	if created.Status != StatusPending || created.MaxUses != DefaultMaxUses || created.RemainingUses != DefaultMaxUses {
		t.Fatalf("unexpected create resp: %+v", created)
	}
	if created.ExpiresAtMs != now.Add(DefaultTTLSec*time.Second).UnixMilli() {
		t.Fatalf("unexpected expires_at_ms: %d", created.ExpiresAtMs)
	}

	// Cross-cluster status & revoke must be forbidden
	if _, err := store.Status("cluster-b", "single_use_01"); err != ErrForbiddenCluster {
		t.Fatalf("cross-cluster status: got %v, want ErrForbiddenCluster", err)
	}
	if _, err := store.Revoke("cluster-b", "single_use_01"); err != ErrForbiddenCluster {
		t.Fatalf("cross-cluster revoke: got %v, want ErrForbiddenCluster", err)
	}

	// Keep backing slice reference to verify explicit zeroing on wipe
	store.mu.Lock()
	backingRef := store.tickets["single_use_01"].ciphertext
	store.mu.Unlock()

	claimResp, err := store.Claim("single_use_01", "198.51.100.10")
	if err != nil {
		t.Fatalf("first claim failed: %v", err)
	}
	if claimResp.CiphertextB64 != "c2VjcmV0LWNpcGhlcnRleHQ=" {
		t.Fatalf("unexpected ciphertext: %q", claimResp.CiphertextB64)
	}
	for i, b := range backingRef {
		if b != 0 {
			t.Fatalf("ciphertext backing byte %d was not zeroed (got %d)", i, b)
		}
	}
	if _, err := store.Claim("single_use_01", "198.51.100.11"); err != ErrTicketClaimed {
		t.Fatalf("second claim: got %v, want ErrTicketClaimed", err)
	}
	st, err := store.Status("cluster-a", "single_use_01")
	if err != nil {
		t.Fatalf("status after claim: %v", err)
	}
	if st.Status != StatusClaimed || st.RemainingUses != 0 || st.ClaimedCount != 1 || st.LastClaimedIP != "198.51.100.10" || st.LastClaimedAtMs != now.UnixMilli() {
		t.Fatalf("unexpected status after claim: %+v", st)
	}

	// 2. Multi-use ticket countdown
	if _, err := store.Create("cluster-a", "multi_use_003", "bXVsdGktY2lwaGVy", 300, 3); err != nil {
		t.Fatalf("create multi-use: %v", err)
	}
	for i := 1; i <= 3; i++ {
		advance(time.Second)
		ip := fmt.Sprintf("203.0.113.%d", i)
		got, err := store.Claim("multi_use_003", ip)
		if err != nil {
			t.Fatalf("multi-use claim %d failed: %v", i, err)
		}
		if got.CiphertextB64 != "bXVsdGktY2lwaGVy" {
			t.Fatalf("unexpected multi-use ciphertext")
		}
		st, _ := store.Status("cluster-a", "multi_use_003")
		wantStatus := StatusPending
		if i == 3 {
			wantStatus = StatusClaimed
		}
		if st.Status != wantStatus || st.ClaimedCount != i || st.RemainingUses != 3-i || st.LastClaimedIP != ip {
			t.Fatalf("step %d unexpected status: %+v", i, st)
		}
	}
	if _, err := store.Claim("multi_use_003", "203.0.113.4"); err != ErrTicketClaimed {
		t.Fatalf("4th multi-use claim: got %v, want ErrTicketClaimed", err)
	}

	// 3. Revoke wipes ciphertext immediately
	if _, err := store.Create("cluster-a", "revokable_01", "cmV2b2tlLW1l", 300, 5); err != nil {
		t.Fatalf("create revokable: %v", err)
	}
	store.mu.Lock()
	revokeBacking := store.tickets["revokable_01"].ciphertext
	store.mu.Unlock()

	rev, err := store.Revoke("cluster-a", "revokable_01")
	if err != nil || rev.Status != StatusRevoked {
		t.Fatalf("revoke failed: resp=%+v err=%v", rev, err)
	}
	for i, b := range revokeBacking {
		if b != 0 {
			t.Fatalf("revoked ciphertext byte %d not zeroed", i)
		}
	}
	if _, err := store.Claim("revokable_01", "203.0.113.5"); err != ErrTicketRevoked {
		t.Fatalf("claim after revoke: got %v, want ErrTicketRevoked", err)
	}

	// 4. Expiration + 1h metadata retention GC
	if _, err := store.Create("cluster-a", "expiring_001", "ZXhwaXJlLW1l", 60, 2); err != nil {
		t.Fatalf("create expiring: %v", err)
	}
	store.mu.Lock()
	expBacking := store.tickets["expiring_001"].ciphertext
	store.mu.Unlock()

	advance(60 * time.Second)
	if _, err := store.Claim("expiring_001", "203.0.113.6"); err != ErrTicketExpired {
		t.Fatalf("claim after expiry: got %v, want ErrTicketExpired", err)
	}
	for i, b := range expBacking {
		if b != 0 {
			t.Fatalf("expired ciphertext byte %d not zeroed", i)
		}
	}
	stExp, err := store.Status("cluster-a", "expiring_001")
	if err != nil || stExp.Status != StatusExpired {
		t.Fatalf("status after expiry: resp=%+v err=%v", stExp, err)
	}

	// 59m past expiry: metadata still retained
	advance(59 * time.Minute)
	store.GC()
	if _, err := store.Status("cluster-a", "expiring_001"); err != nil {
		t.Fatalf("metadata pruned too early: %v", err)
	}

	// 60m past expiry: GC prunes metadata completely
	advance(1 * time.Minute)
	store.GC()
	if _, err := store.Status("cluster-a", "expiring_001"); err != ErrTicketNotFound {
		t.Fatalf("metadata not pruned after 1h: got %v, want ErrTicketNotFound", err)
	}

	// Background StartGC exits cleanly on cancel
	ctx, cancel := context.WithCancel(context.Background())
	store.StartGC(ctx, 5*time.Millisecond)
	time.Sleep(15 * time.Millisecond)
	cancel()
}

func TestStoreClaimRateLimitAndConcurrency(t *testing.T) {
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	var mu sync.Mutex
	getNow := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return now
	}
	advance := func(d time.Duration) {
		mu.Lock()
		now = now.Add(d)
		mu.Unlock()
	}

	store := NewStore()
	store.SetClock(getNow)

	// 20 claims (even misses) consume the full per-IP token bucket
	for i := 0; i < DefaultClaimRatePerMin; i++ {
		if _, err := store.Claim("missing_0001", "192.0.2.50"); err != ErrTicketNotFound {
			t.Fatalf("req %d: got %v, want ErrTicketNotFound", i, err)
		}
	}
	if _, err := store.Claim("missing_0001", "192.0.2.50"); err != ErrRateLimited {
		t.Fatalf("21st req: got %v, want ErrRateLimited", err)
	}
	// Different IP is unaffected
	if _, err := store.Claim("missing_0001", "192.0.2.51"); err != ErrTicketNotFound {
		t.Fatalf("other IP: got %v, want ErrTicketNotFound", err)
	}
	// 3 seconds refills 1 token (20 tokens / 60s)
	advance(3 * time.Second)
	if _, err := store.Claim("missing_0001", "192.0.2.50"); err != ErrTicketNotFound {
		t.Fatalf("after 3s refill: got %v, want ErrTicketNotFound", err)
	}
	if _, err := store.Claim("missing_0001", "192.0.2.50"); err != ErrRateLimited {
		t.Fatalf("immediately after 1 refilled token: got %v, want ErrRateLimited", err)
	}

	// Concurrent single-use claim atomicity
	if _, err := store.Create("c1", "atomic_race01", "b25lLXNob3Q=", 600, 1); err != nil {
		t.Fatalf("create atomic ticket: %v", err)
	}
	var wg sync.WaitGroup
	var okCount, goneCount atomic.Int32
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			ip := fmt.Sprintf("10.0.0.%d", idx+1)
			_, err := store.Claim("atomic_race01", ip)
			switch err {
			case nil:
				okCount.Add(1)
			case ErrTicketClaimed:
				goneCount.Add(1)
			default:
				t.Errorf("unexpected concurrent claim err: %v", err)
			}
		}(i)
	}
	wg.Wait()
	if okCount.Load() != 1 || goneCount.Load() != 19 {
		t.Fatalf("atomic claim invariant broken: ok=%d gone=%d", okCount.Load(), goneCount.Load())
	}
}

func TestMirrorAllowlistCachingAndSingleflight(t *testing.T) {
	var upstreamHits atomic.Int32
	assetPayload := []byte("fake-tarball-content-for-neo-agent-os")
	sumsPayload := []byte("deadbeef  neo-agent-os-0.9.0-linux-x64.tar.gz\n")

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits.Add(1)
		switch r.URL.Path {
		case "/v0.9.0/neo-agent-os-0.9.0-linux-x64.tar.gz":
			time.Sleep(30 * time.Millisecond) // amplify concurrent singleflight window
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(assetPayload)
		case "/v0.9.0/SHA256SUMS.txt":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(sumsPayload)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer upstream.Close()

	cacheDir := t.TempDir()
	mirror := NewMirror(MirrorConfig{
		CacheDir:       cacheDir,
		ReleaseBaseURL: upstream.URL,
	})

	// Allowlist and path-traversal rejections
	badPaths := []struct {
		rawPath string
	}{
		{"/dl/v0.9.0/../../.env"},
		{"/dl/v0.9.0/..%2F..%2F.env"},
		{"/dl/v0.9.0/%2e%2e/SHA256SUMS.txt"},
		{"/dl/v0.9.0/.env"},
		{"/dl/v0.9.0/evil-binary.tar.gz"},
		{"/dl/v0.9.0/neo-agent-os-0.9.0-linux-x64.sh"},
		{"/dl/v0.9.0/neo-agent-os-..tar.gz"},
		{"/dl/latest/SHA256SUMS.txt"},
		{"/dl/v0.9.0/nested/SHA256SUMS.txt"},
		{"/dl/"},
	}
	for _, tc := range badPaths {
		req := httptest.NewRequest(http.MethodGet, "http://relay.local"+tc.rawPath, nil)
		rec := httptest.NewRecorder()
		mirror.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden && rec.Code != http.StatusBadRequest {
			t.Fatalf("path %q: got status %d, want 400 or 403 (body=%s)", tc.rawPath, rec.Code, rec.Body.String())
		}
	}
	if upstreamHits.Load() != 0 {
		t.Fatalf("disallowed paths hit upstream %d times", upstreamHits.Load())
	}

	// Singleflight concurrent fetch: 8 simultaneous requests hit upstream ONCE
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodGet, "http://relay.local/dl/v0.9.0/neo-agent-os-0.9.0-linux-x64.tar.gz", nil)
			rec := httptest.NewRecorder()
			mirror.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Errorf("concurrent fetch status=%d body=%s", rec.Code, rec.Body.String())
				return
			}
			if rec.Body.String() != string(assetPayload) {
				t.Errorf("concurrent fetch body mismatch")
			}
		}()
	}
	wg.Wait()
	if upstreamHits.Load() != 1 {
		t.Fatalf("expected singleflight to hit upstream once, got %d hits", upstreamHits.Load())
	}

	// Normalized tag without leading 'v' hits the same cache entry
	reqNorm := httptest.NewRequest(http.MethodGet, "http://relay.local/dl/0.9.0/neo-agent-os-0.9.0-linux-x64.tar.gz", nil)
	recNorm := httptest.NewRecorder()
	mirror.ServeHTTP(recNorm, reqNorm)
	if recNorm.Code != http.StatusOK || recNorm.Header().Get("X-Neo-Cache") != "HIT" {
		t.Fatalf("normalized tag cache hit failed: code=%d cache=%q", recNorm.Code, recNorm.Header().Get("X-Neo-Cache"))
	}
	if upstreamHits.Load() != 1 {
		t.Fatalf("normalized cache hit unexpectedly queried upstream (hits=%d)", upstreamHits.Load())
	}

	// Verify file exists in cacheDir/v0.9.0/
	if _, err := os.Stat(filepath.Join(cacheDir, "v0.9.0", "neo-agent-os-0.9.0-linux-x64.tar.gz")); err != nil {
		t.Fatalf("expected cached file on disk: %v", err)
	}

	// Upstream 404 propagates 404 without caching
	req404 := httptest.NewRequest(http.MethodGet, "http://relay.local/dl/v0.9.0/neo-agent-os-0.9.0-macos-arm64.tar.gz", nil)
	rec404 := httptest.NewRecorder()
	mirror.ServeHTTP(rec404, req404)
	if rec404.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for missing upstream asset, got %d", rec404.Code)
	}

	// Disabled mirror ("off") rejects traversal with 403 and disables valid assets with 404
	offMirror := NewMirror(MirrorConfig{CacheDir: "off", ReleaseBaseURL: upstream.URL})
	recOffBad := httptest.NewRecorder()
	offMirror.ServeHTTP(recOffBad, httptest.NewRequest(http.MethodGet, "http://relay.local/dl/v0.9.0/.env", nil))
	if recOffBad.Code != http.StatusForbidden {
		t.Fatalf("off mirror bad file: got %d, want 403", recOffBad.Code)
	}
	recOffGood := httptest.NewRecorder()
	offMirror.ServeHTTP(recOffGood, httptest.NewRequest(http.MethodGet, "http://relay.local/dl/v0.9.0/SHA256SUMS.txt", nil))
	if recOffGood.Code != http.StatusNotFound {
		t.Fatalf("off mirror valid file: got %d, want 404", recOffGood.Code)
	}
}

func TestMirrorLatestJSON(t *testing.T) {
	// 1. Pinned version avoids GitHub API completely
	var apiHits atomic.Int32
	ghAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := apiHits.Add(1)
		if n == 1 {
			_ = json.NewEncoder(w).Encode(map[string]string{"tag_name": "v0.9.2"})
			return
		}
		if n == 2 {
			_ = json.NewEncoder(w).Encode(map[string]string{"tag_name": "v0.9.3"})
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer ghAPI.Close()

	pinned := NewMirror(MirrorConfig{GitHubAPIURL: ghAPI.URL, AgentVersion: "v0.9.5"})
	rec := httptest.NewRecorder()
	pinned.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://relay.local/dl/latest.json", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("pinned latest status=%d", rec.Code)
	}
	var lr LatestResponse
	_ = json.NewDecoder(rec.Body).Decode(&lr)
	if lr.Version != "0.9.5" || lr.Tag != "v0.9.5" || apiHits.Load() != 0 {
		t.Fatalf("unexpected pinned latest: %+v hits=%d", lr, apiHits.Load())
	}

	// 2. GitHub API with 5-min cache
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	m := NewMirror(MirrorConfig{GitHubAPIURL: ghAPI.URL})
	m.SetClock(func() time.Time { return now })

	fetchLatest := func() LatestResponse {
		r := httptest.NewRecorder()
		m.ServeHTTP(r, httptest.NewRequest(http.MethodGet, "http://relay.local/dl/latest.json", nil))
		if r.Code != http.StatusOK {
			t.Fatalf("latest status=%d", r.Code)
		}
		var out LatestResponse
		_ = json.NewDecoder(r.Body).Decode(&out)
		return out
	}

	if got := fetchLatest(); got.Version != "0.9.2" || got.Tag != "v0.9.2" {
		t.Fatalf("first latest: %+v", got)
	}
	now = now.Add(4 * time.Minute)
	if got := fetchLatest(); got.Version != "0.9.2" || apiHits.Load() != 1 {
		t.Fatalf("cached latest failed: %+v hits=%d", got, apiHits.Load())
	}
	now = now.Add(2 * time.Minute)
	if got := fetchLatest(); got.Version != "0.9.3" || apiHits.Load() != 2 {
		t.Fatalf("refreshed latest failed: %+v hits=%d", got, apiHits.Load())
	}

	// 3. Fallback to 0.9.0 when GitHub API fails on cold start
	failAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer failAPI.Close()
	mFail := NewMirror(MirrorConfig{GitHubAPIURL: failAPI.URL})
	recFail := httptest.NewRecorder()
	mFail.ServeHTTP(recFail, httptest.NewRequest(http.MethodGet, "http://relay.local/dl/latest.json", nil))
	var fb LatestResponse
	_ = json.NewDecoder(recFail.Body).Decode(&fb)
	if fb.Version != "0.9.0" || fb.Tag != "v0.9.0" {
		t.Fatalf("unexpected fallback latest: %+v", fb)
	}
}

func TestBootstrapScriptsRenderingSyntaxAndRuntime(t *testing.T) {
	sh := RenderInstallSh("https://neo.1inch.cn:18443/")
	if strings.Contains(sh, "{{PUBLIC_URL}}") {
		t.Fatalf("install.sh still contains {{PUBLIC_URL}}")
	}
	if !strings.Contains(sh, `RELAY_URL="https://neo.1inch.cn:18443"`) {
		t.Fatalf("install.sh missing substituted RELAY_URL")
	}
	lines := strings.Count(sh, "\n")
	if lines >= 170 {
		t.Fatalf("install.sh has %d lines, must be < 170", lines)
	}
	if !strings.Contains(sh, `printf '%s\n' "$ENROLL_CODE" | "$BIN" enroll --relay-url "$RELAY_URL" --mode "$MODE" --ticket-stdin`) {
		t.Fatalf("install.sh missing stdin enroll invocation")
	}

	// Header injection attempt must be sanitized away
	if got := SanitizePublicURL(`https://evil.example"; pwned; #`); got != "" {
		t.Fatalf("SanitizePublicURL failed to reject shell injection: got %q", got)
	}
	injected := RenderInstallSh(`https://evil.example"; pwned; #`)
	if strings.Contains(injected, "evil.example") || strings.Contains(injected, "pwned") {
		t.Fatalf("RenderInstallSh failed to strip shell injection")
	}

	// Verify POSIX sh -n syntax check
	tmpDir := t.TempDir()
	shPath := filepath.Join(tmpDir, "install.sh")
	if err := os.WriteFile(shPath, []byte(sh), 0o755); err != nil {
		t.Fatalf("write install.sh: %v", err)
	}
	if out, err := exec.Command("sh", "-n", shPath).CombinedOutput(); err != nil {
		t.Fatalf("sh -n failed: %v\n%s", err, string(out))
	}
	if out, err := exec.Command("sh", shPath, "--help").CombinedOutput(); err != nil || !strings.Contains(string(out), "--enroll") {
		t.Fatalf("install.sh --help failed: %v\n%s", err, string(out))
	}

	// Verify PowerShell script rendering & contract
	ps1 := RenderInstallPs1("https://neo.1inch.cn:18443")
	if strings.Contains(ps1, "{{PUBLIC_URL}}") {
		t.Fatalf("install.ps1 still contains {{PUBLIC_URL}}")
	}
	for _, want := range []string{
		"function Install-NeoAgent",
		"[string]$Enroll",
		`[string]$RelayUrl = "https://neo.1inch.cn:18443"`,
		"[string]$Version",
		"[string]$Mode",
		"[switch]$Uninstall",
		"[string]$Cluster",
		"[switch]$PurgeWorkspace",
		"[switch]$GithubOnly",
		"neo-agent-os-$Version-windows-x64.zip",
		"Get-FileHash",
		"-Algorithm SHA256",
		"neo-agent-os.exe",
		"--ticket-stdin",
	} {
		if !strings.Contains(ps1, want) {
			t.Fatalf("install.ps1 missing %q", want)
		}
	}

	// Runtime smoke test of install.sh against a local mock mirror (non-root HOME install + SHA256 verify + stdin secret piping)
	if _, err := exec.LookPath("curl"); err == nil {
		if _, err := exec.LookPath("tar"); err == nil {
			runInstallShRuntimeTest(t, tmpDir)
		}
	}
}

func runInstallShRuntimeTest(t *testing.T, tmpDir string) {
	t.Helper()
	if os.Geteuid() == 0 {
		t.Skip("skipping install.sh runtime test as root to avoid touching /usr/local/bin")
	}
	// Build a tiny stub neo-agent-os shell script that records argv and stdin to a file
	recordFile := filepath.Join(tmpDir, "enroll_record.txt")
	stubBin := filepath.Join(tmpDir, "neo-agent-os")
	stubScript := fmt.Sprintf("#!/bin/sh\nIFS= read -r SECRET\nprintf 'ARGV=%%s\\nSTDIN=%%s\\n' \"$*\" \"$SECRET\" > %q\n", recordFile)
	if err := os.WriteFile(stubBin, []byte(stubScript), 0o755); err != nil {
		t.Fatalf("write stub binary: %v", err)
	}

	// Detect current arch tag matching install.sh
	archRaw, err := exec.Command("uname", "-m").Output()
	if err != nil {
		t.Skip("uname unavailable")
	}
	archTag := "x64"
	switch strings.TrimSpace(string(archRaw)) {
	case "aarch64", "arm64":
		archTag = "arm64"
	case "x86_64", "amd64":
		archTag = "x64"
	default:
		t.Skip("unsupported arch for runtime test")
	}
	assetName := fmt.Sprintf("neo-agent-os-0.9.9-linux-%s.tar.gz", archTag)
	tarPath := filepath.Join(tmpDir, assetName)
	if out, err := exec.Command("tar", "-czf", tarPath, "-C", tmpDir, "neo-agent-os").CombinedOutput(); err != nil {
		t.Fatalf("tar failed: %v\n%s", err, string(out))
	}
	tarBytes, err := os.ReadFile(tarPath)
	if err != nil {
		t.Fatalf("read tar: %v", err)
	}
	sum := sha256.Sum256(tarBytes)
	sumsContent := fmt.Sprintf("%s  %s\n", hex.EncodeToString(sum[:]), assetName)

	mockRelay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/dl/latest.json":
			_, _ = w.Write([]byte(`{"version":"0.9.9","tag":"v0.9.9"}`))
		case "/dl/v0.9.9/" + assetName:
			_, _ = w.Write(tarBytes)
		case "/dl/v0.9.9/SHA256SUMS.txt":
			_, _ = w.Write([]byte(sumsContent))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer mockRelay.Close()

	rendered := RenderInstallSh(mockRelay.URL)
	scriptFile := filepath.Join(tmpDir, "run_install.sh")
	if err := os.WriteFile(scriptFile, []byte(rendered), 0o755); err != nil {
		t.Fatalf("write run_install.sh: %v", err)
	}

	fakeHome := filepath.Join(tmpDir, "home")
	cmd := exec.Command("sh", scriptFile, "--enroll", "NEO-SECRET-TICKET-999", "--mode", "user")
	cmd.Env = append(os.Environ(), "HOME="+fakeHome)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("install.sh runtime failed: %v\n%s", err, string(out))
	}

	recBytes, err := os.ReadFile(recordFile)
	if err != nil {
		t.Fatalf("read enroll_record: %v", err)
	}
	rec := string(recBytes)
	if !strings.Contains(rec, "ARGV=enroll --relay-url "+mockRelay.URL+" --mode user --ticket-stdin\n") {
		t.Fatalf("unexpected child argv: %s", rec)
	}
	if strings.Contains(strings.Split(rec, "\n")[0], "NEO-SECRET-TICKET-999") {
		t.Fatalf("secret leaked into child argv: %s", rec)
	}
	if !strings.Contains(rec, "STDIN=NEO-SECRET-TICKET-999\n") {
		t.Fatalf("secret not piped via stdin: %s", rec)
	}

	// Verify --uninstall invokes installed binary with --cluster and --purge-workspace
	uninstallRecord := filepath.Join(tmpDir, "uninstall_record.txt")
	installedBin := filepath.Join(fakeHome, ".local", "bin", "neo-agent-os")
	if err := os.WriteFile(installedBin, []byte(fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n' \"$*\" > %q\n", uninstallRecord)), 0o755); err != nil {
		t.Fatalf("overwrite installed stub: %v", err)
	}
	uCmd := exec.Command("sh", scriptFile, "--uninstall", "--cluster", "c-prod", "--purge-workspace")
	uCmd.Env = append(os.Environ(), "HOME="+fakeHome)
	if out, err := uCmd.CombinedOutput(); err != nil {
		t.Fatalf("install.sh --uninstall failed: %v\n%s", err, string(out))
	}
	uGot, err := os.ReadFile(uninstallRecord)
	if err != nil {
		t.Fatalf("read uninstall record: %v", err)
	}
	if strings.TrimSpace(string(uGot)) != "uninstall --cluster c-prod --purge-workspace" {
		t.Fatalf("unexpected uninstall args: %q", string(uGot))
	}

	// Verify SHA-256 mismatch aborts installation
	badRelay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/dl/v0.9.9/" + assetName:
			_, _ = w.Write(tarBytes)
		case "/dl/v0.9.9/SHA256SUMS.txt":
			_, _ = w.Write([]byte("0000000000000000000000000000000000000000000000000000000000000000  " + assetName + "\n"))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer badRelay.Close()
	badCmd := exec.Command("sh", scriptFile, "--relay-url", badRelay.URL, "--version", "0.9.9", "--enroll", "NEO-BAD")
	badCmd.Env = append(os.Environ(), "HOME="+filepath.Join(tmpDir, "home2"))
	if out, err := badCmd.CombinedOutput(); err == nil || !strings.Contains(string(out), "SHA-256 mismatch") {
		t.Fatalf("expected SHA-256 mismatch failure, err=%v out=%s", err, string(out))
	}
}
