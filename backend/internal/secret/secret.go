// Package secret encrypts server credentials at rest (AES-GCM). Key source:
// WEEBSYNC_SECRET env var if set, otherwise an auto-generated key file in the
// data dir (created on first start).
package secret

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

var keyBytes []byte

// Init loads the encryption key. Precedence: WEEBSYNC_SECRET env var, then
// <dataDir>/secret.key; if neither exists a random key is generated and
// written to the file (0600). Must be called once at startup.
func Init(dataDir string) error {
	if s := os.Getenv("WEEBSYNC_SECRET"); s != "" {
		k := sha256.Sum256([]byte(s))
		keyBytes = k[:]
		return nil
	}
	path := filepath.Join(dataDir, "secret.key")
	b, err := os.ReadFile(path)
	switch {
	case err == nil:
		b = bytes.TrimSpace(b)
		if len(b) == 0 {
			return fmt.Errorf("%s is empty — delete it to regenerate (existing credentials become unreadable) or set WEEBSYNC_SECRET", path)
		}
	case errors.Is(err, os.ErrNotExist):
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			return err
		}
		b = []byte(hex.EncodeToString(raw))
		if err := os.WriteFile(path, b, 0o600); err != nil {
			return fmt.Errorf("write key file: %w", err)
		}
	default:
		return fmt.Errorf("read key file: %w", err)
	}
	k := sha256.Sum256(b)
	keyBytes = k[:]
	return nil
}

func key() ([]byte, error) {
	if keyBytes == nil {
		return nil, errors.New("secret.Init not called")
	}
	return keyBytes, nil
}

func gcm() (cipher.AEAD, error) {
	k, err := key()
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(k)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func Encrypt(plaintext string) ([]byte, error) {
	g, err := gcm()
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, g.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return g.Seal(nonce, nonce, []byte(plaintext), nil), nil
}

func Decrypt(data []byte) (string, error) {
	g, err := gcm()
	if err != nil {
		return "", err
	}
	if len(data) < g.NonceSize() {
		return "", fmt.Errorf("ciphertext too short")
	}
	plain, err := g.Open(nil, data[:g.NonceSize()], data[g.NonceSize():], nil)
	if err != nil {
		return "", fmt.Errorf("decrypt failed (WEEBSYNC_SECRET changed?): %w", err)
	}
	return string(plain), nil
}
