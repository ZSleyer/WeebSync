package auth

import "net/http"

// SetCookie writes c with the attributes every WeebSync cookie shares, so a new
// cookie cannot forget one of them. Secure follows the deployment posture (see
// isHTTPS) rather than being hardcoded: a plain-HTTP install on the LAN still
// has to be able to log in.
func SetCookie(w http.ResponseWriter, r *http.Request, c *http.Cookie) {
	c.HttpOnly = true
	c.SameSite = http.SameSiteLaxMode
	c.Secure = isHTTPS(r)
	http.SetCookie(w, c)
}

// hostPrefix marks a cookie the browser only accepts with Secure, Path=/ and
// no Domain (RFC 6265bis, "__Host-" prefix). A sister subdomain cannot set
// one, so it cannot toss its own session or OIDC state into this app.
const hostPrefix = "__Host-"

// cookieName is the name the cookie called name gets for r: host-prefixed
// whenever SetCookie marks it Secure. A plain-HTTP install has no Secure
// cookie, and a browser refuses a host-prefixed one without it.
func cookieName(r *http.Request, name string) string {
	if isHTTPS(r) {
		return hostPrefix + name
	}
	return name
}

// FlowCookie is a short-lived cookie scoped to path, named and placed the
// way the session and OIDC cookies are: host-prefixed at Path=/ under HTTPS,
// the plain name at path over plain HTTP. Write it with SetCookie.
func FlowCookie(r *http.Request, name, path, value string, maxAge int) *http.Cookie {
	return &http.Cookie{Name: cookieName(r, name), Value: value, Path: cookiePath(r, path), MaxAge: maxAge}
}

// FlowCookieValue reads a cookie FlowCookie set; "" (refused) without one or
// with an empty value, which proves nothing.
func FlowCookieValue(r *http.Request, name string) string {
	c, err := r.Cookie(cookieName(r, name))
	if err != nil {
		return ""
	}
	return c.Value
}

// cookiePath is where a cookie scoped to path lives for r: a host-prefixed
// cookie has to be Path=/.
func cookiePath(r *http.Request, path string) string {
	if isHTTPS(r) {
		return "/"
	}
	return path
}
