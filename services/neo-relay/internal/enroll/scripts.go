package enroll

import (
	_ "embed"
	"net/url"
	"strings"
)

const publicURLPlaceholder = "{{PUBLIC_URL}}"

//go:embed assets/install.sh
var installShTemplate string

//go:embed assets/install.ps1
var installPs1Template string

// RenderInstallSh substitutes {{PUBLIC_URL}} with a sanitized public relay base URL.
func RenderInstallSh(publicURL string) string {
	return strings.ReplaceAll(installShTemplate, publicURLPlaceholder, SanitizePublicURL(publicURL))
}

// RenderInstallPs1 substitutes {{PUBLIC_URL}} with a sanitized public relay base URL.
func RenderInstallPs1(publicURL string) string {
	return strings.ReplaceAll(installPs1Template, publicURLPlaceholder, SanitizePublicURL(publicURL))
}

// SanitizePublicURL validates and normalizes a public HTTP(S) base URL before embedding
// into shell or PowerShell bootstrap scripts, preventing header-based script injection.
func SanitizePublicURL(raw string) string {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return ""
	}
	if u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return ""
	}
	for i := 0; i < len(u.Host); i++ {
		c := u.Host[i]
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
			c == '.' || c == '-' || c == ':' || c == '[' || c == ']') {
			return ""
		}
	}
	path := strings.TrimRight(u.Path, "/")
	for i := 0; i < len(path); i++ {
		c := path[i]
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
			c == '/' || c == '.' || c == '-' || c == '_') {
			return ""
		}
	}
	return scheme + "://" + u.Host + path
}
