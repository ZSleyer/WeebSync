package remote

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"io"
	"net"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// stuckReader never answers a read: the SFTP side of a server that hangs
// while its SSH transport stays healthy.
type stuckReader struct{ release chan struct{} }

func (r stuckReader) ReadAt([]byte, int64) (int, error) {
	<-r.release
	return 0, io.EOF
}

type stuckFiles struct{ release chan struct{} }

func (f stuckFiles) Fileread(*sftp.Request) (io.ReaderAt, error) { return stuckReader(f), nil }

// stuckSFTPServer is an SSH server whose transport answers keepalives but whose
// SFTP subsystem never answers a READ.
func stuckSFTPServer(t *testing.T) (int, string) {
	t.Helper()
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &ssh.ServerConfig{PasswordCallback: func(ssh.ConnMetadata, []byte) (*ssh.Permissions, error) { return nil, nil }}
	cfg.AddHostKey(signer)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			nc, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer nc.Close()
				sc, chans, reqs, err := ssh.NewServerConn(nc, cfg)
				if err != nil {
					return
				}
				defer sc.Close()
				go ssh.DiscardRequests(reqs)
				for nch := range chans {
					ch, chReqs, err := nch.Accept()
					if err != nil {
						continue
					}
					go func() {
						for req := range chReqs {
							if req.Type == "subsystem" {
								req.Reply(true, nil)
								h := sftp.InMemHandler()
								h.FileGet = stuckFiles{release}
								srv := sftp.NewRequestServer(ch, h)
								srv.Serve()
								ch.Close()
								return
							}
							req.Reply(false, nil)
						}
					}()
				}
			}()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port, base64.StdEncoding.EncodeToString(signer.PublicKey().Marshal())
}

// A read the SFTP server never answers is not caught by the idle deadline:
// keepalives keep the transport busy. Abort is the way out - it tears the
// connection down, which fails the pending request, so whoever waits on it
// can clean up.
func TestAbortEndsStuckSFTPRead(t *testing.T) {
	shortTimeouts(t, 300*time.Millisecond, 5*time.Second, 100*time.Millisecond)
	port, key := stuckSFTPServer(t)
	for _, pooled := range []bool{false, true} {
		cfg := Config{Protocol: "sftp", Host: "127.0.0.1", Port: port, Username: "u", Password: "p", HostKey: key}
		var c Client
		if pooled {
			conn, err := DialSSH(cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			if c, err = SFTPChannel(conn); err != nil {
				t.Fatal(err)
			}
		} else {
			var err error
			if c, err = Dial(cfg); err != nil {
				t.Fatal(err)
			}
		}
		src, err := c.Open("/stuck.mkv", 0)
		if err != nil {
			t.Fatal(err)
		}
		read := make(chan error, 1)
		go func() {
			_, err := src.Read(make([]byte, 1024))
			read <- err
		}()
		select {
		case err := <-read:
			t.Fatalf("pooled=%v: read returned early: %v", pooled, err)
		case <-time.After(time.Second): // well past the idle deadline: keepalives hold it
		}
		a, ok := c.(Aborter)
		if !ok {
			t.Fatalf("pooled=%v: client cannot be aborted", pooled)
		}
		a.Abort()
		select {
		case err := <-read:
			if err == nil {
				t.Errorf("pooled=%v: read after abort returned no error", pooled)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("pooled=%v: read still stuck after Abort", pooled)
		}
		closed := make(chan struct{})
		go func() {
			src.Close()
			c.Close()
			close(closed)
		}()
		select {
		case <-closed:
		case <-time.After(3 * time.Second):
			t.Fatalf("pooled=%v: Close still blocked after Abort", pooled)
		}
	}
}
