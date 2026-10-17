package api

import (
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
)

// noneAttestation answers a registration challenge with a "none" attestation
// that carries the given COSE key.
func (k *softKey) noneAttestation(t *testing.T, challenge, rpID, origin string, cose []byte) string {
	t.Helper()
	b64 := base64.RawURLEncoding.EncodeToString
	client, _ := json.Marshal(map[string]string{"type": "webauthn.create", "challenge": challenge, "origin": origin})
	rp := sha256.Sum256([]byte(rpID))
	auth := append(rp[:], 0x45) // user present, verified, attested data
	auth = binary.BigEndian.AppendUint32(auth, 0)
	auth = append(auth, make([]byte, 16)...) // AAGUID
	auth = binary.BigEndian.AppendUint16(auth, uint16(len(k.id)))
	auth = append(append(auth, k.id...), cose...)
	obj, err := webauthncbor.Marshal(map[string]any{"fmt": "none", "attStmt": map[string]any{}, "authData": auth})
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{
		"id": b64(k.id), "rawId": b64(k.id), "type": "public-key",
		"response": map[string]string{"attestationObject": b64(obj), "clientDataJSON": b64(client)},
	})
	return string(body)
}

// A "none" attestation is not checked against the key by go-webauthn: a point
// off the curve must be refused here, and a good key must still register.
func TestRegisterRefusesOffCurveKey(t *testing.T) {
	mux, s, _, userC, _, userID := setupUsersTest(t)
	s.DB.Exec(`INSERT INTO settings (key, value) VALUES ('base_url', 'https://example.com')`)
	setPassword(t, s, userID, "longenough123")
	key := newSoftKey(t, []byte("handle-of-the-test-user-32-bytes"))
	pub, _ := key.key.PublicKey.Bytes()
	cose := func(x, y []byte) []byte {
		raw, err := webauthncbor.Marshal(webauthncose.EC2PublicKeyData{
			PublicKeyData: webauthncose.PublicKeyData{KeyType: int64(webauthncose.EllipticKey), Algorithm: int64(webauthncose.AlgES256)},
			Curve:         1, XCoord: x, YCoord: y,
		})
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	register := func(c []byte) *httptest.ResponseRecorder {
		t.Helper()
		rec := doReq(mux, "POST", "/api/auth/webauthn/register/begin", `{"password":"longenough123"}`, userC)
		var begin struct {
			SessionID string `json:"sessionId"`
			PublicKey struct {
				Challenge string `json:"challenge"`
			} `json:"publicKey"`
		}
		json.Unmarshal(rec.Body.Bytes(), &begin)
		req := httptest.NewRequest("POST", "/api/auth/webauthn/register/finish",
			strings.NewReader(key.noneAttestation(t, begin.PublicKey.Challenge, "example.com", "https://example.com", c)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-WA-Session", begin.SessionID)
		req.AddCookie(userC)
		out := httptest.NewRecorder()
		mux.ServeHTTP(out, req)
		return out
	}
	count := func() (n int) {
		s.DB.QueryRow(`SELECT COUNT(*) FROM webauthn_credentials`).Scan(&n)
		return n
	}

	y := append([]byte{}, pub[33:]...)
	y[31] ^= 1 // one bit off: the point leaves the curve
	if rec := register(cose(pub[1:33], y)); rec.Code != http.StatusBadRequest || count() != 0 {
		t.Fatalf("off-curve key: %d %s, stored %d", rec.Code, rec.Body, count())
	}
	if rec := register(cose(pub[1:33], pub[33:])); rec.Code != http.StatusOK || count() != 1 {
		t.Fatalf("valid key: %d %s, stored %d", rec.Code, rec.Body, count())
	}
}
