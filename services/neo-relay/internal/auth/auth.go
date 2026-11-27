package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const tokenPrefix = "neo1"

var (
	ErrMissingToken  = errors.New("missing bearer token")
	ErrInvalidToken  = errors.New("invalid neo token")
	ErrExpiredToken  = errors.New("expired neo token")
	ErrInvalidClaims = errors.New("invalid token claims")
	ErrInvalidTier   = errors.New("invalid node tier")
)

var validTiers = map[string]bool{
	"master": true,
	"os":     true,
	"relay":  true,
	"admin":  true,
}

type Claims struct {
	ClusterID string `json:"cluster_id"`
	NodeID    string `json:"node_id"`
	Tier      string `json:"tier"`
	IAT       int64  `json:"iat"`
	Exp       int64  `json:"exp"`
}

// KeyRing manages root and per-cluster HMAC secrets for multi-master isolation.
// If ClusterSecrets defines an explicit secret for a cluster_id, that independent
// secret is used (enabling isolated rotation/revocation per master). Otherwise, a
// domain-separated subkey is derived from RootSecret via HMAC(root, "cluster:"+clusterID).
type KeyRing struct {
	RootSecret     []byte
	ClusterSecrets map[string][]byte
}

func ValidTier(tier string) bool {
	return validTiers[tier]
}

func ValidClusterID(clusterID, tier string) bool {
	if clusterID == "*" {
		return tier == "admin"
	}
	if len(clusterID) == 0 || len(clusterID) > 32 {
		return false
	}
	for i := 0; i < len(clusterID); i++ {
		c := clusterID[i]
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func (kr KeyRing) keyForCluster(clusterID string) ([]byte, error) {
	if kr.ClusterSecrets != nil {
		if sec, ok := kr.ClusterSecrets[clusterID]; ok && len(sec) > 0 {
			return sec, nil
		}
	}
	if len(kr.RootSecret) == 0 {
		return nil, errors.New("empty keyring secret")
	}
	return computeHMAC(kr.RootSecret, "cluster:"+clusterID), nil
}

// MintToken issues a Neo-scoped HMAC-SHA256 token bound to (cluster_id, node_id, tier).
func MintToken(secret []byte, clusterID, nodeID, tier string, ttl time.Duration, now time.Time) (string, error) {
	return MintTokenWithKeyRing(KeyRing{RootSecret: secret}, clusterID, nodeID, tier, ttl, now)
}

func MintTokenWithKeyRing(kr KeyRing, clusterID, nodeID, tier string, ttl time.Duration, now time.Time) (string, error) {
	if !ValidTier(tier) {
		return "", ErrInvalidTier
	}
	if !ValidClusterID(clusterID, tier) {
		return "", ErrInvalidClaims
	}
	if strings.TrimSpace(nodeID) == "" || len(nodeID) > 64 {
		return "", ErrInvalidClaims
	}
	if ttl <= 0 {
		return "", errors.New("ttl must be positive")
	}
	signingKey, err := kr.keyForCluster(clusterID)
	if err != nil {
		return "", err
	}
	claims := Claims{
		ClusterID: clusterID,
		NodeID:    nodeID,
		Tier:      tier,
		IAT:       now.Unix(),
		Exp:       now.Add(ttl).Unix(),
	}
	raw, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	payload := base64.RawURLEncoding.EncodeToString(raw)
	signingInput := tokenPrefix + "." + payload
	sig := computeHMAC(signingKey, signingInput)
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

func VerifyToken(secret []byte, token string, now time.Time) (Claims, error) {
	return VerifyTokenWithKeyRing(KeyRing{RootSecret: secret}, token, now)
}

// VerifyTokenWithKeyRing validates token format, claims, per-cluster HMAC signature, and expiration.
func VerifyTokenWithKeyRing(kr KeyRing, token string, now time.Time) (Claims, error) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 3 || parts[0] != tokenPrefix {
		return Claims{}, ErrInvalidToken
	}
	rawClaims, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return Claims{}, ErrInvalidClaims
	}
	var claims Claims
	if err := json.Unmarshal(rawClaims, &claims); err != nil {
		return Claims{}, ErrInvalidClaims
	}
	if !ValidTier(claims.Tier) || !ValidClusterID(claims.ClusterID, claims.Tier) ||
		strings.TrimSpace(claims.NodeID) == "" || len(claims.NodeID) > 64 {
		return Claims{}, ErrInvalidClaims
	}
	signingKey, err := kr.keyForCluster(claims.ClusterID)
	if err != nil {
		return Claims{}, ErrInvalidToken
	}
	gotSig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return Claims{}, ErrInvalidToken
	}
	signingInput := parts[0] + "." + parts[1]
	wantSig := computeHMAC(signingKey, signingInput)
	if subtle.ConstantTimeCompare(gotSig, wantSig) != 1 {
		return Claims{}, ErrInvalidToken
	}
	if claims.Exp <= now.Unix() {
		return Claims{}, ErrExpiredToken
	}
	return claims, nil
}

// ExtractRequestToken reads Authorization: Bearer <tok> or ?token=<tok>.
func ExtractRequestToken(r *http.Request) (string, error) {
	if authz := strings.TrimSpace(r.Header.Get("Authorization")); authz != "" {
		if len(authz) > 7 && strings.EqualFold(authz[:7], "Bearer ") {
			tok := strings.TrimSpace(authz[7:])
			if tok != "" {
				return tok, nil
			}
		}
		return "", ErrInvalidToken
	}
	if q := strings.TrimSpace(r.URL.Query().Get("token")); q != "" {
		return q, nil
	}
	return "", ErrMissingToken
}

func computeHMAC(secret []byte, input string) []byte {
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(input))
	return mac.Sum(nil)
}

func FormatBearer(token string) string {
	return fmt.Sprintf("Bearer %s", token)
}
