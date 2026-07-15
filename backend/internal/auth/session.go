package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"net/http"
	"time"
)

const sessionTTL = 30 * 24 * time.Hour

type User struct {
	ID      int64  `json:"id"`
	Email   string `json:"email"`
	IsAdmin bool   `json:"isAdmin"`
}

type ctxKey struct{}

func UserFrom(ctx context.Context) *User {
	u, _ := ctx.Value(ctxKey{}).(*User)
	return u
}

func hashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

func CreateSession(d *sql.DB, w http.ResponseWriter, r *http.Request, userID int64) error {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return err
	}
	token := hex.EncodeToString(raw)
	expires := time.Now().Add(sessionTTL)
	if _, err := d.Exec(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`,
		hashToken(token), userID, expires.UTC().Format(time.RFC3339)); err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "weebsync_session",
		Value:    token,
		Path:     "/",
		Expires:  expires,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   isHTTPS(r),
	})
	return nil
}

func DestroySession(d *sql.DB, w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie("weebsync_session"); err == nil {
		d.Exec(`DELETE FROM sessions WHERE token_hash = ?`, hashToken(c.Value))
	}
	http.SetCookie(w, &http.Cookie{
		Name: "weebsync_session", Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: isHTTPS(r),
	})
}

func isHTTPS(r *http.Request) bool {
	return r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
}

// Middleware resolves the session cookie to a user; 401 when required and absent.
func Middleware(d *sql.DB, required bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			c, err := r.Cookie("weebsync_session")
			if err == nil {
				var u User
				var expires string
				var isAdmin int
				err = d.QueryRow(`SELECT u.id, u.email, u.is_admin, s.expires_at
					FROM sessions s JOIN users u ON u.id = s.user_id
					WHERE s.token_hash = ?`, hashToken(c.Value)).
					Scan(&u.ID, &u.Email, &isAdmin, &expires)
				if err == nil {
					if exp, perr := time.Parse(time.RFC3339, expires); perr == nil && exp.After(time.Now()) {
						u.IsAdmin = isAdmin == 1
						next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, &u)))
						return
					}
					d.Exec(`DELETE FROM sessions WHERE token_hash = ?`, hashToken(c.Value))
				}
			}
			if required {
				http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
