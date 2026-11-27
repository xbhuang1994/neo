package ws

import "testing"

func TestComputeAcceptKeyRFC6455Vector(t *testing.T) {
	// RFC 6455 Section 1.3 / 4.2.2 test vector
	const clientKey = "dGhlIHNhbXBsZSBub25jZQ=="
	const wantAccept = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
	if got := computeAcceptKey(clientKey); got != wantAccept {
		t.Fatalf("computeAcceptKey(%q) = %q, want %q", clientKey, got, wantAccept)
	}
}
