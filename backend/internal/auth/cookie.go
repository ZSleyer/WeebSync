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
