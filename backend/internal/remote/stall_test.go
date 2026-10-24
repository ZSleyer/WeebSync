package remote

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// shortTimeouts shrinks the connection timeouts for one test.
func shortTimeouts(t *testing.T, io, handshake, keepalive time.Duration) {
	t.Helper()
	oldIO, oldHS, oldKA := ioTimeout, handshakeTimeout, keepaliveInterval
	ioTimeout, handshakeTimeout, keepaliveInterval = io, handshake, keepalive
	t.Cleanup(func() { ioTimeout, handshakeTimeout, keepaliveInterval = oldIO, oldHS, oldKA })
}

// silentServer accepts TCP connections and never says a word: a tarpit, or a
// server too overloaded to send its banner.
func silentServer(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var conns []net.Conn
	t.Cleanup(func() {
		ln.Close()
		mu.Lock()
		for _, c := range conns {
			c.Close()
		}
		mu.Unlock()
	})
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			conns = append(conns, c)
			mu.Unlock()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

// within fails the test unless fn returns within d; fn's error is returned.
func within(t *testing.T, d time.Duration, what string, fn func() error) error {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- fn() }()
	select {
	case err := <-done:
		return err
	case <-time.After(d):
		t.Fatalf("%s still blocked after %v", what, d)
		return nil
	}
}

// An SSH server that accepts the connection but never sends its banner used
// to hold the dial forever: ClientConfig.Timeout only bounds ssh.Dial's own
// TCP connect, not a handshake run over a ready connection. In the pool that
// kept a placeholder occupying one of the server's connection slots for good.
func TestSSHHandshakeStallTimesOut(t *testing.T) {
	shortTimeouts(t, time.Hour, 200*time.Millisecond, time.Hour)
	port := silentServer(t)
	cfg := Config{Protocol: "sftp", Host: "127.0.0.1", Port: port, Username: "u", Password: "p", HostKey: "x"}
	if err := within(t, 3*time.Second, "SSH dial", func() error { _, err := DialSSH(cfg); return err }); err == nil {
		t.Fatal("dial to a silent server succeeded")
	}
}

// The same for FTPS: a control connection that never sends its greeting.
// DialWithTimeout does not apply once a dial func is set, and the library sets
// no read deadlines of its own.
func TestFTPGreetingStallTimesOut(t *testing.T) {
	shortTimeouts(t, 200*time.Millisecond, time.Hour, time.Hour)
	port := silentServer(t)
	cfg := Config{Protocol: "ftps", Host: "127.0.0.1", Port: port, Username: "u", Password: "p"}
	if err := within(t, 3*time.Second, "FTPS dial", func() error { _, err := dialFTPTLS(cfg, nil, false); return err }); err == nil {
		t.Fatal("dial to a silent server succeeded")
	}
}

// sftpServer serves dir over SFTP on loopback and returns its port and host key.
func sftpServer(t *testing.T, dir string) (int, string) {
	t.Helper()
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
				go ssh.DiscardRequests(reqs) // answers keepalives
				for nch := range chans {
					ch, chReqs, err := nch.Accept()
					if err != nil {
						continue
					}
					go func() {
						for req := range chReqs {
							if req.Type == "subsystem" {
								req.Reply(true, nil)
								srv, err := sftp.NewServer(ch, sftp.WithServerWorkingDirectory(dir))
								if err == nil {
									srv.Serve()
								}
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

// freezeProxy forwards TCP to target until frozen; then it holds every byte
// in both directions without closing anything - a NAT entry that expired, a
// server that froze, a cable pulled somewhere on the way.
type freezeProxy struct {
	port   int
	frozen atomic.Bool
	closed atomic.Bool
}

func newFreezeProxy(t *testing.T, target int) *freezeProxy {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &freezeProxy{port: ln.Addr().(*net.TCPAddr).Port}
	var mu sync.Mutex
	var conns []net.Conn
	t.Cleanup(func() {
		p.closed.Store(true)
		ln.Close()
		mu.Lock()
		for _, c := range conns {
			c.Close()
		}
		mu.Unlock()
	})
	pipe := func(dst, src net.Conn) {
		buf := make([]byte, 32*1024)
		for {
			n, err := src.Read(buf)
			for p.frozen.Load() {
				if p.closed.Load() {
					return
				}
				time.Sleep(10 * time.Millisecond)
			}
			if n > 0 {
				if _, werr := dst.Write(buf[:n]); werr != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			up, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(target)))
			if err != nil {
				c.Close()
				continue
			}
			mu.Lock()
			conns = append(conns, c, up)
			mu.Unlock()
			go pipe(up, c)
			go pipe(c, up)
		}
	}()
	return p
}

// A connection that goes silent mid-transfer used to block the read until the
// kernel gave up on TCP, minutes to hours later; the download slot stayed
// taken and the row "running". With an idle deadline on the connection the
// read fails once nothing has arrived for the idle timeout, keepalives
// included.
func TestSFTPStalledTransferTimesOut(t *testing.T) {
	shortTimeouts(t, 400*time.Millisecond, 5*time.Second, 100*time.Millisecond)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "ep01.mkv"), make([]byte, 4<<20), 0o644); err != nil {
		t.Fatal(err)
	}
	port, key := sftpServer(t, dir)
	proxy := newFreezeProxy(t, port)
	c, err := Dial(Config{Protocol: "sftp", Host: "127.0.0.1", Port: proxy.port, Username: "u", Password: "p", HostKey: key})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { go c.Close() }() // may block on the frozen peer; not what this test is about
	src, err := c.Open("ep01.mkv", 0)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 32*1024)
	if _, err := io.ReadFull(src, buf); err != nil {
		t.Fatal(err)
	}
	proxy.frozen.Store(true)
	err = within(t, 5*time.Second, "read on a frozen connection", func() error {
		for {
			if _, err := src.Read(buf); err != nil {
				return err
			}
		}
	})
	if err == nil {
		t.Fatal("no error from a frozen connection")
	}
}

// The idle deadline must not kill a healthy connection that merely has
// nothing to do - the pool keeps one warm between downloads. Keepalives keep
// traffic on it.
func TestSSHKeepaliveHoldsIdleConnection(t *testing.T) {
	shortTimeouts(t, 300*time.Millisecond, 5*time.Second, 100*time.Millisecond)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	port, key := sftpServer(t, dir)
	conn, err := DialSSH(Config{Protocol: "sftp", Host: "127.0.0.1", Port: port, Username: "u", Password: "p", HostKey: key})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	time.Sleep(time.Second) // idle for three idle timeouts
	ch, err := SFTPChannel(conn)
	if err != nil {
		t.Fatalf("idle connection died: %v", err)
	}
	defer ch.Close()
	if _, err := ch.List("."); err != nil {
		t.Fatalf("list over the idle connection: %v", err)
	}
}
