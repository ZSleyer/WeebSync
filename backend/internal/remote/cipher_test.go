package remote

import (
	"crypto/ed25519"
	"crypto/rand"
	"net"
	"slices"
	"testing"

	"golang.org/x/crypto/ssh"
)

// sshServerWith accepts one SSH connection offering only the given ciphers.
func sshServerWith(t *testing.T, ciphers []string) int {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &ssh.ServerConfig{
		Config:           ssh.Config{Ciphers: ciphers},
		PasswordCallback: func(ssh.ConnMetadata, []byte) (*ssh.Permissions, error) { return nil, nil },
	}
	cfg.AddHostKey(signer)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		sc, chans, reqs, err := ssh.NewServerConn(c, cfg)
		if err != nil {
			return
		}
		go ssh.DiscardRequests(reqs)
		go func() {
			for ch := range chans {
				ch.Reject(ssh.Prohibited, "no")
			}
		}()
		sc.Wait()
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

func TestNoChaChaInClientOffer(t *testing.T) {
	list := []string{"aes128-gcm@openssh.com", "chacha20-poly1305@openssh.com", "aes256-ctr"}
	if got := noChaCha(list); !slices.Equal(got, []string{"aes128-gcm@openssh.com", "aes256-ctr"}) {
		t.Errorf("noChaCha = %v", got)
	}
	if slices.Contains(noChaCha(ssh.SupportedAlgorithms().Ciphers), "chacha20-poly1305@openssh.com") {
		t.Error("chacha20-poly1305 still offered")
	}
}

func TestDialSSHRefusesChaChaOnlyServer(t *testing.T) {
	port := sshServerWith(t, []string{"chacha20-poly1305@openssh.com"})
	c, err := dialSSH(Config{Protocol: "sftp", Host: "127.0.0.1", Port: port, Username: "u", Password: "p", InsecureHostKey: true})
	if err == nil {
		c.Close()
		t.Fatal("handshake succeeded with chacha20-poly1305 as the only cipher")
	}
}

func TestDialSSHAcceptsAESServer(t *testing.T) {
	port := sshServerWith(t, []string{"aes128-gcm@openssh.com"})
	c, err := dialSSH(Config{Protocol: "sftp", Host: "127.0.0.1", Port: port, Username: "u", Password: "p", InsecureHostKey: true})
	if err != nil {
		t.Fatalf("AES-GCM server refused: %v", err)
	}
	c.Close()
}
