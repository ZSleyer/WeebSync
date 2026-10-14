package api

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-webauthn/webauthn/protocol/webauthncbor"
	"github.com/go-webauthn/webauthn/protocol/webauthncose"
	"github.com/go-webauthn/webauthn/webauthn"
)

// softKey is a software authenticator: one discoverable ES256 credential that
// signs assertions with or without the user-verified flag. Browsers refuse to
// create a passkey on a device that cannot verify its user, so a passkey from
// before the rule can only be played back this way.
type softKey struct {
	key    *ecdsa.PrivateKey
	id     []byte
	handle []byte
	count  uint32
}

func newSoftKey(t *testing.T, handle []byte) *softKey {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	id := make([]byte, 16)
	rand.Read(id)
	return &softKey{key: k, id: id, handle: handle}
}

// credJSON is the stored form go-webauthn reads back.
func (k *softKey) credJSON(t *testing.T) []byte {
	t.Helper()
	pub, _ := k.key.PublicKey.Bytes() // 0x04 || X || Y
	cose, err := webauthncbor.Marshal(webauthncose.EC2PublicKeyData{
		PublicKeyData: webauthncose.PublicKeyData{KeyType: int64(webauthncose.EllipticKey), Algorithm: int64(webauthncose.AlgES256)},
		Curve:         1, XCoord: pub[1:33], YCoord: pub[33:],
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(webauthn.Credential{ID: k.id, PublicKey: cose, AttestationType: "none"})
	return raw
}

// assertion answers a login challenge for rpID/origin.
func (k *softKey) assertion(challenge, rpID, origin string, uv bool) string {
	b64 := base64.RawURLEncoding.EncodeToString
	client, _ := json.Marshal(map[string]string{"type": "webauthn.get", "challenge": challenge, "origin": origin})
	rp := sha256.Sum256([]byte(rpID))
	flags := byte(0x01) // user present
	if uv {
		flags |= 0x04
	}
	k.count++
	auth := append(append(rp[:], flags), binary.BigEndian.AppendUint32(nil, k.count)...)
	ch := sha256.Sum256(client)
	digest := sha256.Sum256(append(append([]byte{}, auth...), ch[:]...))
	sig, _ := ecdsa.SignASN1(rand.Reader, k.key, digest[:])
	body, _ := json.Marshal(map[string]any{
		"id": b64(k.id), "rawId": b64(k.id), "type": "public-key",
		"response": map[string]string{
			"authenticatorData": b64(auth), "clientDataJSON": b64(client),
			"signature": b64(sig), "userHandle": b64(k.handle),
		},
	})
	return string(body)
}

// A passkey sign-in without the UV flag is refused for a passkey registered
// under the rule; one from before the rule gets in once more, onto the page
// that asks to replace it; a verified sign-in marks the passkey as verifying.
func TestPasskeyLoginUserVerification(t *testing.T) {
	mux, s, _, _, _, userID := setupUsersTest(t)
	s.DB.Exec(`INSERT INTO settings (key, value) VALUES ('base_url', 'https://example.com')`)
	setPassword(t, s, userID, "longenough123")
	handle := []byte("handle-of-the-test-user-32-bytes")
	s.DB.Exec(`UPDATE users SET webauthn_handle = ? WHERE id = ?`, handle, userID)
	key := newSoftKey(t, handle)
	if _, err := s.DB.Exec(`INSERT INTO webauthn_credentials (user_id, credential_id, cred_json, name, passwordless, uv_required)
		VALUES (?, ?, ?, 'key', 1, 1)`, userID, key.id, key.credJSON(t)); err != nil {
		t.Fatal(err)
	}
	login := func(uv bool) *httptest.ResponseRecorder {
		t.Helper()
		rec := doReq(mux, "POST", "/api/auth/webauthn/login/begin", "", nil)
		var begin struct {
			SessionID string `json:"sessionId"`
			PublicKey struct {
				Challenge string `json:"challenge"`
			} `json:"publicKey"`
		}
		json.Unmarshal(rec.Body.Bytes(), &begin)
		req := httptest.NewRequest("POST", "/api/auth/webauthn/login/finish",
			strings.NewReader(key.assertion(begin.PublicKey.Challenge, "example.com", "https://example.com", uv)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-WA-Session", begin.SessionID)
		out := httptest.NewRecorder()
		mux.ServeHTTP(out, req)
		return out
	}

	if rec := login(false); rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "PIN or biometrics") {
		t.Fatalf("unverified sign-in with a verifying passkey: %d %s", rec.Code, rec.Body)
	}
	if rec := login(true); rec.Code != http.StatusOK {
		t.Fatalf("verified sign-in: %d %s", rec.Code, rec.Body)
	}

	// a passkey from before the rule
	s.DB.Exec(`UPDATE webauthn_credentials SET uv_required = 0`)
	rec := login(false)
	if rec.Code != http.StatusOK {
		t.Fatalf("legacy passkey without verification: %d %s", rec.Code, rec.Body)
	}
	c := rec.Result().Cookies()[0]
	if me := doReq(mux, "GET", "/api/auth/me", "", c); !strings.Contains(me.Body.String(), `"upgradeRequired":"passkey"`) {
		t.Errorf("legacy sign-in not held: %s", me.Body)
	}
	var due int
	s.DB.QueryRow(`SELECT replace_due FROM webauthn_credentials`).Scan(&due)
	if due != 1 {
		t.Error("legacy passkey not marked for replacement")
	}
	if rec := doReq(mux, "GET", "/api/servers", "", c); rec.Code != http.StatusForbidden {
		t.Errorf("held account reached the app: %d", rec.Code)
	}

	// the same legacy passkey, this time verifying, counts as verifying from now on
	s.DB.Exec(`UPDATE users SET auth_upgrade = ''`)
	s.DB.Exec(`UPDATE webauthn_credentials SET replace_due = 0`)
	if rec := login(true); rec.Code != http.StatusOK {
		t.Fatalf("legacy passkey with verification: %d %s", rec.Code, rec.Body)
	}
	var uvRequired int
	s.DB.QueryRow(`SELECT uv_required FROM webauthn_credentials`).Scan(&uvRequired)
	if uvRequired != 1 {
		t.Error("a verifying sign-in did not mark the passkey")
	}
	if rec := login(false); rec.Code != http.StatusUnauthorized {
		t.Errorf("after proving verification, an unverified sign-in still got in: %d", rec.Code)
	}
}
