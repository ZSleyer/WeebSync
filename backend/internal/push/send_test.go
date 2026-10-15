package push

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func mustB64(t *testing.T, s string) []byte {
	t.Helper()
	b, err := decodeKey(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// The worked example of RFC 8291 appendix A, byte for byte.
func TestEncryptRFC8291Example(t *testing.T) {
	plain := mustB64(t, "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24")
	asPriv, err := ecdh.P256().NewPrivateKey(mustB64(t, "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"))
	if err != nil {
		t.Fatal(err)
	}
	if got := b64.EncodeToString(asPriv.PublicKey().Bytes()); got != "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8" {
		t.Fatalf("as_public = %s", got)
	}
	uaPublic := mustB64(t, "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4")
	auth := mustB64(t, "BTBZMqHH6r4Tts7J_aSIgg")
	salt := mustB64(t, "DGv6ra1nlYgDCS1FRnbzlw")
	got, err := encryptWith(plain, uaPublic, auth, salt, asPriv)
	if err != nil {
		t.Fatal(err)
	}
	want := "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
		"mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
		"pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
	if b64.EncodeToString(got) != want {
		t.Fatalf("message\n got  %s\n want %s", b64.EncodeToString(got), want)
	}
}

// decrypt is the user agent's side of RFC 8291, for round trips.
func decrypt(t *testing.T, msg []byte, ua *ecdh.PrivateKey, auth []byte) []byte {
	t.Helper()
	salt, rs, idlen := msg[:16], binary.BigEndian.Uint32(msg[16:20]), int(msg[20])
	if rs != recordSize || idlen != 65 {
		t.Fatalf("header rs=%d idlen=%d", rs, idlen)
	}
	asPub, err := ecdh.P256().NewPublicKey(msg[21 : 21+idlen])
	if err != nil {
		t.Fatal(err)
	}
	shared, _ := ua.ECDH(asPub)
	ikm, _ := hkdf.Key(sha256.New, shared, auth, "WebPush: info\x00"+string(ua.PublicKey().Bytes())+string(asPub.Bytes()), 32)
	prk, _ := hkdf.Extract(sha256.New, ikm, salt)
	cek, _ := hkdf.Expand(sha256.New, prk, "Content-Encoding: aes128gcm\x00", 16)
	nonce, _ := hkdf.Expand(sha256.New, prk, "Content-Encoding: nonce\x00", 12)
	block, _ := aes.NewCipher(cek)
	gcm, _ := cipher.NewGCM(block)
	rec, err := gcm.Open(nil, nonce, msg[21+idlen:], nil)
	if err != nil {
		t.Fatal(err)
	}
	if rec[len(rec)-1] != 2 {
		t.Fatalf("record does not end in the last-record delimiter")
	}
	return rec[:len(rec)-1]
}

func TestEncryptRoundTripUnpadded(t *testing.T) {
	ua, _ := ecdh.P256().GenerateKey(nil)
	auth := bytes.Repeat([]byte{7}, 16)
	payload := []byte(`{"title":"t","body":"b"}`)
	msg, err := encrypt(payload, ua.PublicKey().Bytes(), auth)
	if err != nil {
		t.Fatal(err)
	}
	// header + payload + delimiter + tag: no padding toward the record size
	if want := 86 + len(payload) + 1 + 16; len(msg) != want {
		t.Fatalf("message is %d bytes, want %d", len(msg), want)
	}
	if got := decrypt(t, msg, ua, auth); !bytes.Equal(got, payload) {
		t.Fatalf("round trip = %q", got)
	}
}

// A key pair as the previous implementation stored it must keep working:
// browsers subscribed against that public key.
func TestStoredKeysStillSign(t *testing.T) {
	const priv = "E42KuTzcs1ha5dj7Izy9t7ni4IX8f42sVCEVzg65ZtY"
	const pub = "BMyycsr6USnp4xfx0yHDda6gOZAjcY3Zj_pPhxapyfAF4YoEBngAWq5RfOBvjl1JqOUjNeqM0bAOdpE4yS6N6RE"
	checkVapid(t, priv, pub)
	p, q, err := generateKeys()
	if err != nil {
		t.Fatal(err)
	}
	checkVapid(t, p, q)
}

func checkVapid(t *testing.T, priv, pub string) {
	t.Helper()
	now := time.Unix(1_800_000_000, 0)
	h, err := vapid("https://push.example.net/send/abc?x=1", "mailto:ops@example.com", pub, priv, now)
	if err != nil {
		t.Fatal(err)
	}
	tok, k, ok := strings.Cut(strings.TrimPrefix(h, "vapid t="), ", k=")
	if !ok || k != pub {
		t.Fatalf("header %q", h)
	}
	parts := strings.Split(tok, ".")
	var claims struct {
		Aud string `json:"aud"`
		Exp int64  `json:"exp"`
		Sub string `json:"sub"`
	}
	if err := json.Unmarshal(mustB64(t, parts[1]), &claims); err != nil {
		t.Fatal(err)
	}
	if claims.Aud != "https://push.example.net" || claims.Sub != "mailto:ops@example.com" ||
		claims.Exp <= now.Unix() || claims.Exp > now.Add(24*time.Hour).Unix() {
		t.Fatalf("claims %+v", claims)
	}
	key, err := ecdsa.ParseUncompressedPublicKey(elliptic.P256(), mustB64(t, pub))
	if err != nil {
		t.Fatal(err)
	}
	sig := mustB64(t, parts[2])
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if len(sig) != 64 || !ecdsa.Verify(key, sum[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		t.Fatal("signature does not verify against the public key")
	}
}

func TestSendHeaders(t *testing.T) {
	ua, _ := ecdh.P256().GenerateKey(nil)
	auth := bytes.Repeat([]byte{1}, 16)
	priv, pub, _ := generateKeys()
	var got *http.Request
	var body []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, body = r, func() []byte { b, _ := io.ReadAll(r.Body); return b }()
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()
	resp, err := send(srv.Client(), srv.URL+"/push/1", b64.EncodeToString(ua.PublicKey().Bytes()),
		// a padded standard-alphabet secret, as some stores hand it out
		"AQEBAQEBAQEBAQEBAQEBAQ==", []byte("hi"), "mailto:ops@example.com", pub, priv, 60)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if got.Header.Get("Content-Encoding") != "aes128gcm" || got.Header.Get("TTL") != "60" ||
		!strings.HasPrefix(got.Header.Get("Authorization"), "vapid t=") {
		t.Fatalf("headers %v", got.Header)
	}
	if string(decrypt(t, body, ua, auth)) != "hi" {
		t.Fatal("body does not decrypt")
	}
}
