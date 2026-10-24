package push

// Web Push from the RFCs: message encryption (RFC 8291 over the aes128gcm
// content coding of RFC 8188) and VAPID authorization (RFC 8292). Keys are
// unpadded base64url: the private key a 32-byte P-256 scalar, the public key
// the 65-byte uncompressed point the browser takes as applicationServerKey.

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

var b64 = base64.RawURLEncoding

// decodeKey reads a base64 key the way browsers and stores hand them out:
// URL or standard alphabet, padded or not.
func decodeKey(s string) ([]byte, error) {
	s = strings.TrimRight(strings.TrimSpace(s), "=")
	if b, err := b64.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.RawStdEncoding.DecodeString(s)
}

// ValidKeys reports whether a subscription's keys can be encrypted for at
// all: p256dh a point on P-256, auth a 16-byte secret. A subscription that
// fails this never receives a push.
func ValidKeys(p256dh, auth string) error {
	ua, err := decodeKey(p256dh)
	if err != nil {
		return fmt.Errorf("push: p256dh: %w", err)
	}
	if _, err := ecdh.P256().NewPublicKey(ua); err != nil {
		return fmt.Errorf("push: p256dh: %w", err)
	}
	secret, err := decodeKey(auth)
	if err != nil {
		return fmt.Errorf("push: auth: %w", err)
	}
	if len(secret) != 16 {
		return errors.New("push: auth secret is not 16 bytes")
	}
	return nil
}

// generateKeys makes a VAPID key pair.
func generateKeys() (private, public string, err error) {
	k, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return "", "", err
	}
	return b64.EncodeToString(k.Bytes()), b64.EncodeToString(k.PublicKey().Bytes()), nil
}

// recordSize is the rs the header announces. The message is one record and
// is not padded up to it: padding to the full size is what Mozilla's
// endpoints reject with 413.
const recordSize = 4096

// encrypt seals payload for a subscription's p256dh key and auth secret.
func encrypt(payload, uaPublic, authSecret []byte) ([]byte, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	eph, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	return encryptWith(payload, uaPublic, authSecret, salt, eph)
}

func encryptWith(payload, uaPublic, authSecret, salt []byte, eph *ecdh.PrivateKey) ([]byte, error) {
	if len(authSecret) != 16 {
		return nil, errors.New("push: auth secret is not 16 bytes")
	}
	if len(payload)+1+16 > recordSize {
		return nil, errors.New("push: payload too large")
	}
	ua, err := ecdh.P256().NewPublicKey(uaPublic)
	if err != nil {
		return nil, fmt.Errorf("push: p256dh: %w", err)
	}
	shared, err := eph.ECDH(ua)
	if err != nil {
		return nil, err
	}
	asPublic := eph.PublicKey().Bytes()

	// combine the ECDH secret with the auth secret (RFC 8291 section 3.4)
	keyInfo := "WebPush: info\x00" + string(uaPublic) + string(asPublic)
	ikm, err := hkdf.Key(sha256.New, shared, authSecret, keyInfo, 32)
	if err != nil {
		return nil, err
	}
	prk, err := hkdf.Extract(sha256.New, ikm, salt)
	if err != nil {
		return nil, err
	}
	cek, err := hkdf.Expand(sha256.New, prk, "Content-Encoding: aes128gcm\x00", 16)
	if err != nil {
		return nil, err
	}
	nonce, err := hkdf.Expand(sha256.New, prk, "Content-Encoding: nonce\x00", 12)
	if err != nil {
		return nil, err
	}

	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	// header: salt, record size, key id length, key id (RFC 8188 section 2.1)
	var out bytes.Buffer
	out.Write(salt)
	_ = binary.Write(&out, binary.BigEndian, uint32(recordSize))
	out.WriteByte(byte(len(asPublic)))
	out.Write(asPublic)
	// the one and last record ends with the 0x02 delimiter
	record := append(append([]byte{}, payload...), 2)
	return gcm.Seal(out.Bytes(), nonce, record, nil), nil
}

// vapid builds the Authorization header value for a push to endpoint
// (RFC 8292): an ES256 JWT for the endpoint's origin, plus the public key.
func vapid(endpoint, subscriber, public, private string, now time.Time) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return "", err
	}
	raw, err := decodeKey(private)
	if err != nil {
		return "", fmt.Errorf("push: vapid private key: %w", err)
	}
	if len(raw) < 32 { // a scalar with leading zero bytes, stored short
		raw = append(make([]byte, 32-len(raw)), raw...)
	}
	key, err := ecdsa.ParseRawPrivateKey(elliptic.P256(), raw)
	if err != nil {
		return "", fmt.Errorf("push: vapid private key: %w", err)
	}
	// a pair that does not belong together would sign a token the push
	// service rejects after the round trip; say so here
	ek, err := key.ECDH()
	if err != nil {
		return "", fmt.Errorf("push: vapid private key: %w", err)
	}
	if pub, err := decodeKey(public); err != nil || !bytes.Equal(pub, ek.PublicKey().Bytes()) {
		return "", errors.New("push: vapid private key does not belong to the public key")
	}
	claims, _ := json.Marshal(map[string]any{
		"aud": u.Scheme + "://" + u.Host,
		"exp": now.Add(12 * time.Hour).Unix(), // the RFC caps it at 24h
		"sub": subscriber,
	})
	unsigned := b64.EncodeToString([]byte(`{"typ":"JWT","alg":"ES256"}`)) + "." + b64.EncodeToString(claims)
	sum := sha256.Sum256([]byte(unsigned))
	r, s, err := ecdsa.Sign(rand.Reader, key, sum[:])
	if err != nil {
		return "", err
	}
	// ES256 is r and s as 32 bytes each, not ASN.1
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return "vapid t=" + unsigned + "." + b64.EncodeToString(sig) + ", k=" + public, nil
}

// send delivers payload to one subscription. The caller closes the body.
func send(ctx context.Context, client *http.Client, endpoint, p256dh, auth string, payload []byte, subscriber, public, private string, ttl int, urgency string) (*http.Response, error) {
	ua, err := decodeKey(p256dh)
	if err != nil {
		return nil, fmt.Errorf("push: p256dh: %w", err)
	}
	secret, err := decodeKey(auth)
	if err != nil {
		return nil, fmt.Errorf("push: auth: %w", err)
	}
	body, err := encrypt(payload, ua, secret)
	if err != nil {
		return nil, err
	}
	authz, err := vapid(endpoint, subscriber, public, private, time.Now())
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Encoding", "aes128gcm")
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("TTL", strconv.Itoa(ttl))
	if urgency != "" {
		req.Header.Set("Urgency", urgency)
	}
	req.Header.Set("Authorization", authz)
	return client.Do(req)
}
