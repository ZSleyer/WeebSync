// Package secret encrypts server credentials at rest (AES-GCM, key derived
// from the WEEBSYNC_SECRET env var).
package secret

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
)

func key() ([]byte, error) {
	s := os.Getenv("WEEBSYNC_SECRET")
	if s == "" {
		return nil, errors.New("WEEBSYNC_SECRET must be set (any long random string)")
	}
	k := sha256.Sum256([]byte(s))
	return k[:], nil
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
