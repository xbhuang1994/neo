package enroll

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	DefaultDLCacheDir       = "/nvme/neo-relay/cache/dl"
	DefaultReleaseBaseURL   = "https://github.com/xbhuang1994/neo/releases/download"
	DefaultGitHubAPIURL     = "https://api.github.com/repos/xbhuang1994/neo/releases/latest"
	DefaultFallbackVersion  = "0.9.0"
	DefaultLatestCacheTTL   = 5 * time.Minute
	DefaultLatestFailTTL    = 1 * time.Minute
	DefaultUpstreamTimeout  = 60 * time.Second
	DefaultGitHubAPITimeout = 10 * time.Second
	MaxReleaseAssetBytes    = 256 << 20 // 256 MiB safety cap
)

var (
	releaseTagRegex      = regexp.MustCompile(`^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`)
	releaseFilenameRegex = regexp.MustCompile(`^(neo-agent-os-[0-9A-Za-z._-]+\.(tar\.gz|zip)|SHA256SUMS\.txt)$`)
)

// ValidReleaseTag validates tag against ^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ and rejects "..".
func ValidReleaseTag(tag string) bool {
	if tag == "" || strings.Contains(tag, "..") || strings.ContainsAny(tag, `/\%`) {
		return false
	}
	return releaseTagRegex.MatchString(tag)
}

// ValidReleaseFilename validates filename against the strict release asset allowlist and rejects "..".
func ValidReleaseFilename(filename string) bool {
	if filename == "" || strings.Contains(filename, "..") || strings.ContainsAny(filename, `/\%`) {
		return false
	}
	return releaseFilenameRegex.MatchString(filename)
}

// NormalizeReleaseTag ensures a valid tag begins with "v".
func NormalizeReleaseTag(tag string) string {
	if strings.HasPrefix(tag, "v") {
		return tag
	}
	return "v" + tag
}

type MirrorConfig struct {
	CacheDir       string
	ReleaseBaseURL string
	GitHubAPIURL   string
	AgentVersion   string
	HTTPClient     *http.Client
	LatestCacheTTL time.Duration
}

type LatestResponse struct {
	Version string `json:"version"`
	Tag     string `json:"tag"`
}

type keyLockEntry struct {
	mu   sync.Mutex
	refs int
}

// Mirror serves /dl/latest.json and caches/proxies allowlisted release assets at /dl/{tag}/{filename}.
type Mirror struct {
	cacheDir       string
	disabled       bool
	releaseBaseURL string
	githubAPIURL   string
	pinnedVersion  string
	httpClient     *http.Client
	latestTTL      time.Duration

	latestMu        sync.Mutex
	cachedLatest    LatestResponse
	cachedLatestExp time.Time
	hasCachedLatest bool

	keyLocksMu sync.Mutex
	keyLocks   map[string]*keyLockEntry

	nowFn func() time.Time
}

func NewMirror(cfg MirrorConfig) *Mirror {
	cacheDir := strings.TrimSpace(cfg.CacheDir)
	disabled := cacheDir == "" || strings.EqualFold(cacheDir, "off")
	if !disabled {
		cacheDir = filepath.Clean(cacheDir)
	}

	releaseBase := strings.TrimRight(strings.TrimSpace(cfg.ReleaseBaseURL), "/")
	if releaseBase == "" {
		releaseBase = DefaultReleaseBaseURL
	}
	githubAPI := strings.TrimSpace(cfg.GitHubAPIURL)
	if githubAPI == "" {
		githubAPI = DefaultGitHubAPIURL
	}
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: DefaultUpstreamTimeout}
	}
	latestTTL := cfg.LatestCacheTTL
	if latestTTL <= 0 {
		latestTTL = DefaultLatestCacheTTL
	}

	pinned := ""
	if v := strings.TrimSpace(cfg.AgentVersion); v != "" && ValidReleaseTag(v) {
		pinned = strings.TrimPrefix(v, "v")
	}

	return &Mirror{
		cacheDir:       cacheDir,
		disabled:       disabled,
		releaseBaseURL: releaseBase,
		githubAPIURL:   githubAPI,
		pinnedVersion:  pinned,
		httpClient:     client,
		latestTTL:      latestTTL,
		keyLocks:       make(map[string]*keyLockEntry),
		nowFn:          time.Now,
	}
}

// SetClock overrides the clock source (intended for deterministic tests).
func (m *Mirror) SetClock(fn func() time.Time) {
	m.latestMu.Lock()
	defer m.latestMu.Unlock()
	if fn == nil {
		m.nowFn = time.Now
		return
	}
	m.nowFn = fn
}

// ServeHTTP dispatches /dl/latest.json and /dl/{tag}/{filename}.
// It inspects the raw escaped path directly so path-traversal segments like ".."
// or "%2F" are rejected with 403/400 before any URL cleaning or filesystem access.
func (m *Mirror) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeMirrorJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	escapedPath := r.URL.EscapedPath()
	if escapedPath == "/dl/latest.json" && r.URL.Path == "/dl/latest.json" {
		m.handleLatest(w, r)
		return
	}

	if !strings.HasPrefix(escapedPath, "/dl/") {
		writeMirrorJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}

	rest := strings.TrimPrefix(escapedPath, "/dl/")
	if strings.Contains(rest, "..") || strings.Contains(rest, "%") || strings.Contains(rest, "\\") {
		writeMirrorJSON(w, http.StatusForbidden, map[string]string{"error": "disallowed download path"})
		return
	}

	parts := strings.Split(rest, "/")
	if len(parts) != 2 {
		writeMirrorJSON(w, http.StatusBadRequest, map[string]string{"error": "expected /dl/{tag}/{filename}"})
		return
	}

	tag, filename := parts[0], parts[1]
	if !ValidReleaseTag(tag) {
		writeMirrorJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid release tag"})
		return
	}
	if !ValidReleaseFilename(filename) {
		writeMirrorJSON(w, http.StatusForbidden, map[string]string{"error": "disallowed release filename"})
		return
	}

	if m.disabled {
		writeMirrorJSON(w, http.StatusNotFound, map[string]string{"error": "release mirror disabled"})
		return
	}

	normTag := NormalizeReleaseTag(tag)
	m.handleAsset(w, r, normTag, filename)
}

func (m *Mirror) handleLatest(w http.ResponseWriter, r *http.Request) {
	latest := m.resolveLatest(r.Context())
	w.Header().Set("Cache-Control", "public, max-age=60")
	writeMirrorJSON(w, http.StatusOK, latest)
}

func (m *Mirror) resolveLatest(ctx context.Context) LatestResponse {
	if m.pinnedVersion != "" {
		return LatestResponse{
			Version: m.pinnedVersion,
			Tag:     "v" + m.pinnedVersion,
		}
	}

	m.latestMu.Lock()
	defer m.latestMu.Unlock()

	now := m.nowFn()
	if m.hasCachedLatest && now.Before(m.cachedLatestExp) {
		return m.cachedLatest
	}

	ver, err := m.fetchGitHubLatestVersion(ctx)
	if err == nil && ver != "" {
		res := LatestResponse{Version: ver, Tag: "v" + ver}
		m.cachedLatest = res
		m.cachedLatestExp = now.Add(m.latestTTL)
		m.hasCachedLatest = true
		return res
	}

	if m.hasCachedLatest {
		// Retain last known good version briefly on transient GitHub API error.
		m.cachedLatestExp = now.Add(DefaultLatestFailTTL)
		return m.cachedLatest
	}

	fallback := LatestResponse{
		Version: DefaultFallbackVersion,
		Tag:     "v" + DefaultFallbackVersion,
	}
	m.cachedLatest = fallback
	m.cachedLatestExp = now.Add(DefaultLatestFailTTL)
	m.hasCachedLatest = true
	return fallback
}

func (m *Mirror) fetchGitHubLatestVersion(ctx context.Context) (string, error) {
	reqCtx, cancel := context.WithTimeout(ctx, DefaultGitHubAPITimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, m.githubAPIURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "neo-relayd")
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := m.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("github api status %d", resp.StatusCode)
	}

	var payload struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&payload); err != nil {
		return "", err
	}
	tag := strings.TrimSpace(payload.TagName)
	if !ValidReleaseTag(tag) {
		return "", errors.New("invalid tag_name in github release response")
	}
	return strings.TrimPrefix(tag, "v"), nil
}

func (m *Mirror) handleAsset(w http.ResponseWriter, r *http.Request, normTag, filename string) {
	cachePath, ok := m.safeCachePath(normTag, filename)
	if !ok {
		writeMirrorJSON(w, http.StatusForbidden, map[string]string{"error": "disallowed cache path"})
		return
	}

	// Fast path: already cached on disk.
	if served := m.tryServeCached(w, r, cachePath, filename, "HIT"); served {
		return
	}

	// Singleflight per-key lock prevents thundering herd against upstream.
	key := normTag + "/" + filename
	unlock := m.lockKey(key)

	// Re-check cache after acquiring per-key lock.
	if fi, err := os.Stat(cachePath); err == nil && fi.Mode().IsRegular() {
		unlock()
		if m.tryServeCached(w, r, cachePath, filename, "HIT") {
			return
		}
		// File disappeared concurrently; fall through to re-fetch.
		unlock = m.lockKey(key)
	}

	statusCode, fetchErr := m.fetchAndCacheLocked(r.Context(), normTag, filename, cachePath)
	unlock()

	if fetchErr != nil {
		if statusCode == http.StatusNotFound {
			writeMirrorJSON(w, http.StatusNotFound, map[string]string{"error": "release asset not found"})
			return
		}
		log.Printf("neo-relayd mirror fetch failed for %s/%s: %v", normTag, filename, fetchErr)
		writeMirrorJSON(w, http.StatusBadGateway, map[string]string{"error": "upstream release fetch failed"})
		return
	}

	if !m.tryServeCached(w, r, cachePath, filename, "MISS") {
		writeMirrorJSON(w, http.StatusInternalServerError, map[string]string{"error": "cached asset unavailable"})
	}
}

func (m *Mirror) fetchAndCacheLocked(ctx context.Context, normTag, filename, cachePath string) (int, error) {
	fetchCtx, cancel := context.WithTimeout(ctx, DefaultUpstreamTimeout)
	defer cancel()

	upstreamURL := m.releaseBaseURL + "/" + normTag + "/" + filename
	req, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, upstreamURL, nil)
	if err != nil {
		return http.StatusBadGateway, err
	}
	req.Header.Set("User-Agent", "neo-relayd")

	resp, err := m.httpClient.Do(req)
	if err != nil {
		return http.StatusBadGateway, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return http.StatusNotFound, errors.New("upstream 404")
	}
	if resp.StatusCode != http.StatusOK {
		return http.StatusBadGateway, fmt.Errorf("upstream status %d", resp.StatusCode)
	}

	parentDir := filepath.Dir(cachePath)
	if err := os.MkdirAll(parentDir, 0o755); err != nil {
		return http.StatusInternalServerError, fmt.Errorf("mkdir cache dir: %w", err)
	}

	tmpFile, err := os.CreateTemp(parentDir, ".tmp-"+filename+"-*")
	if err != nil {
		return http.StatusInternalServerError, fmt.Errorf("create temp cache file: %w", err)
	}
	tmpPath := tmpFile.Name()
	cleanupTmp := true
	defer func() {
		if cleanupTmp {
			_ = os.Remove(tmpPath)
		}
	}()

	limited := io.LimitReader(resp.Body, MaxReleaseAssetBytes+1)
	written, err := io.Copy(tmpFile, limited)
	if err != nil {
		_ = tmpFile.Close()
		return http.StatusBadGateway, fmt.Errorf("copy upstream body: %w", err)
	}
	if written > MaxReleaseAssetBytes {
		_ = tmpFile.Close()
		return http.StatusBadGateway, errors.New("upstream release asset exceeds max size limit")
	}
	if err := tmpFile.Close(); err != nil {
		return http.StatusInternalServerError, fmt.Errorf("close temp file: %w", err)
	}
	if err := os.Chmod(tmpPath, 0o644); err != nil {
		return http.StatusInternalServerError, fmt.Errorf("chmod temp file: %w", err)
	}
	if err := os.Rename(tmpPath, cachePath); err != nil {
		return http.StatusInternalServerError, fmt.Errorf("rename cache file: %w", err)
	}
	cleanupTmp = false
	return http.StatusOK, nil
}

func (m *Mirror) tryServeCached(w http.ResponseWriter, r *http.Request, cachePath, filename, cacheStatus string) bool {
	f, err := os.Open(cachePath)
	if err != nil {
		return false
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		return false
	}

	w.Header().Set("Content-Type", assetContentType(filename))
	w.Header().Set("X-Neo-Cache", cacheStatus)
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeContent(w, r, filename, fi.ModTime(), f)
	return true
}

func (m *Mirror) safeCachePath(normTag, filename string) (string, bool) {
	base := filepath.Clean(m.cacheDir)
	joined := filepath.Clean(filepath.Join(base, normTag, filename))
	rel, err := filepath.Rel(base, joined)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", false
	}
	return joined, true
}

func (m *Mirror) lockKey(key string) func() {
	m.keyLocksMu.Lock()
	e, ok := m.keyLocks[key]
	if !ok {
		e = &keyLockEntry{}
		m.keyLocks[key] = e
	}
	e.refs++
	m.keyLocksMu.Unlock()

	e.mu.Lock()
	return func() {
		e.mu.Unlock()
		m.keyLocksMu.Lock()
		e.refs--
		if e.refs == 0 {
			delete(m.keyLocks, key)
		}
		m.keyLocksMu.Unlock()
	}
}

func assetContentType(filename string) string {
	switch {
	case strings.HasSuffix(filename, ".tar.gz"):
		return "application/gzip"
	case strings.HasSuffix(filename, ".zip"):
		return "application/zip"
	case filename == "SHA256SUMS.txt":
		return "text/plain; charset=utf-8"
	default:
		return "application/octet-stream"
	}
}

func writeMirrorJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
