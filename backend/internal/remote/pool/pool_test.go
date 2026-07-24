package pool

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// testSFTP is an in-process SSH+SFTP server used to reproduce a real server's
// connection and per-connection session limits so the pool's multiplexing,
// growth, adaptive channel cap and priority can be verified end-to-end.
type testSFTP struct {
	ln          net.Listener
	dir         string
	hostKey     string // base64 host key, pinned by cfg()
	maxSessions int    // channels a single connection may hold (0 = unlimited)

	mu        sync.Mutex
	peakConns int // most TCP connections open at once
	openConns int
}

func startTestSFTP(t *testing.T, maxSessions int) *testSFTP {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromSigner(priv)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hello"), 0o644)

	s := &testSFTP{
		ln: ln, dir: dir, maxSessions: maxSessions,
		hostKey: base64.StdEncoding.EncodeToString(signer.PublicKey().Marshal()),
	}
	cfg := &ssh.ServerConfig{PasswordCallback: func(ssh.ConnMetadata, []byte) (*ssh.Permissions, error) { return nil, nil }}
	cfg.AddHostKey(signer)

	go func() {
		for {
			nc, err := ln.Accept()
			if err != nil {
				return
			}
			go s.serveConn(nc, cfg)
		}
	}()
	t.Cleanup(func() { ln.Close() })
	return s
}

func (s *testSFTP) serveConn(nc net.Conn, cfg *ssh.ServerConfig) {
	sc, chans, reqs, err := ssh.NewServerConn(nc, cfg)
	if err != nil {
		nc.Close()
		return
	}
	s.mu.Lock()
	s.openConns++
	if s.openConns > s.peakConns {
		s.peakConns = s.openConns
	}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.openConns--
		s.mu.Unlock()
		sc.Close()
	}()
	go ssh.DiscardRequests(reqs)

	var sess struct {
		sync.Mutex
		n int
	}
	var wg sync.WaitGroup
	for newChan := range chans {
		if newChan.ChannelType() != "session" {
			newChan.Reject(ssh.UnknownChannelType, "only sessions")
			continue
		}
		sess.Lock()
		if s.maxSessions > 0 && sess.n >= s.maxSessions {
			sess.Unlock()
			// mirror sshd hitting MaxSessions
			newChan.Reject(ssh.Prohibited, "open failed (max sessions)")
			continue
		}
		sess.n++
		sess.Unlock()
		ch, chReqs, err := newChan.Accept()
		if err != nil {
			sess.Lock()
			sess.n--
			sess.Unlock()
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() {
				sess.Lock()
				sess.n--
				sess.Unlock()
			}()
			for req := range chReqs {
				if req.Type == "subsystem" && len(req.Payload) >= 4 && string(req.Payload[4:]) == "sftp" {
					req.Reply(true, nil)
					srv, err := sftp.NewServer(ch)
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
	wg.Wait()
}

func (s *testSFTP) cfg() remote.Config {
	_, port, _ := net.SplitHostPort(s.ln.Addr().String())
	var p int
	for _, c := range port {
		p = p*10 + int(c-'0')
	}
	return remote.Config{Protocol: "sftp", Host: "127.0.0.1", Port: p, Username: "u", Password: "p", HostKey: s.hostKey}
}

func (s *testSFTP) peak() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.peakConns
}

// grab leases a channel and verifies it can actually list the served dir.
func grab(t *testing.T, p *Pool, cfg remote.Config, prio Prio) remote.Client {
	t.Helper()
	cl, err := p.Lease(context.Background(), 1, cfg, prio)
	if err != nil {
		t.Fatalf("lease: %v", err)
	}
	if _, err := cl.List(cfgDir(cfg, t)); err != nil {
		cl.Close()
		t.Fatalf("list over leased channel: %v", err)
	}
	return cl
}

// cfgDir returns the served temp dir; the test server serves the real FS.
var servedDir string

func cfgDir(_ remote.Config, t *testing.T) string { return servedDir }

func TestPoolMultiplexReuse(t *testing.T) {
	s := startTestSFTP(t, 20)
	servedDir = s.dir
	p := New()
	defer p.Close()
	cfg := s.cfg()
	cfg.MaxConns = 3

	var leases []remote.Client
	for i := 0; i < 6; i++ {
		leases = append(leases, grab(t, p, cfg, PriHigh))
	}
	// 6 concurrent channels must share ONE TCP connection (MaxSessions 20)
	if got := s.peak(); got != 1 {
		t.Errorf("peak connections = %d, want 1 (channels should multiplex)", got)
	}
	for _, l := range leases {
		l.Close()
	}
}

func TestPoolAdaptiveCapAndGrow(t *testing.T) {
	s := startTestSFTP(t, 2) // server allows only 2 channels per connection
	servedDir = s.dir
	p := New()
	defer p.Close()
	cfg := s.cfg()
	cfg.MaxConns = 3 // capacity after learning = 3 conns * 2 channels = 6

	var leases []remote.Client
	for i := 0; i < 6; i++ {
		leases = append(leases, grab(t, p, cfg, PriHigh))
	}
	if got := s.peak(); got != 3 {
		t.Errorf("peak connections = %d, want 3 (2 channels each after adaptive cap)", got)
	}
	// learned channel cap must have dropped to the server's real limit
	p.mu.Lock()
	sp := p.servers[1]
	p.mu.Unlock()
	sp.mu.Lock()
	learned := sp.chanCap
	sp.mu.Unlock()
	if learned != 2 {
		t.Errorf("learned chanCap = %d, want 2", learned)
	}
	// capacity is full (6): a 7th lease must block
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	if _, err := p.Lease(ctx, 1, cfg, PriHigh); err == nil {
		t.Error("7th lease should block until capacity frees, got a connection")
	}
	for _, l := range leases {
		l.Close()
	}
}

func TestPoolPriority(t *testing.T) {
	s := startTestSFTP(t, 1) // 1 channel per connection
	servedDir = s.dir
	p := New()
	defer p.Close()
	cfg := s.cfg()
	cfg.MaxConns = 2 // total capacity after learning = 2 conns * 1 channel = 2

	// warm up so the pool learns the real per-connection cap (1): the 2nd lease
	// hits the server's session limit, drops the cap and grows to a 2nd conn.
	a := grab(t, p, cfg, PriHigh)
	b := grab(t, p, cfg, PriHigh)
	b.Close() // reap the spare conn; capacity is now a known 2 with 1 in use

	// 1 of 2 slots free, held by high: low must leave it for downloads -> waits
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	if _, err := p.Lease(ctx, 1, cfg, PriLow); err == nil {
		t.Error("low priority took the reserved slot; should have waited")
	}

	// once the high lease frees, low can proceed
	a.Close()
	ctx2, cancel2 := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel2()
	lo, err := p.Lease(ctx2, 1, cfg, PriLow)
	if err != nil {
		t.Fatalf("low priority after release: %v", err)
	}
	lo.Close()
}

// TestPoolCapUnderConcurrency guards against concurrent leases each dialing past
// maxConns while an earlier dial is still in flight (a mid-dial conn is skipped
// by connWithRoom, so without a len<maxConns gate every racer opens its own).
func TestPoolCapUnderConcurrency(t *testing.T) {
	s := startTestSFTP(t, 1) // 1 channel per connection -> capacity == maxConns
	servedDir = s.dir
	p := New()
	defer p.Close()
	cfg := s.cfg()
	cfg.MaxConns = 2

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 5; j++ {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				cl, err := p.Lease(ctx, 1, cfg, PriHigh)
				cancel()
				if err != nil {
					continue
				}
				cl.List(s.dir)
				cl.Close()
			}
		}()
	}
	wg.Wait()
	if got := s.peak(); got > cfg.MaxConns {
		t.Errorf("peak connections = %d, exceeded maxConns %d", got, cfg.MaxConns)
	}
}

func TestReserve(t *testing.T) {
	cases := []struct {
		prio  Prio
		total int
		want  int
	}{
		{PriHigh, 5, 0},
		{PriLow, 5, 1},
		{PriLow, 1, 0}, // single-slot server: no reserve or index never runs
	}
	for _, c := range cases {
		if got := reserve(c.prio, c.total); got != c.want {
			t.Errorf("reserve(%v,%d)=%d want %d", c.prio, c.total, got, c.want)
		}
	}
}

// TestDialHostKeyPinning verifies the strict pinning in remote.dialSSH against
// a real handshake (the in-process server lives in this package): unknown and
// wrong keys are refused with the offered key reported, the pinned key passes.
func TestDialHostKeyPinning(t *testing.T) {
	s := startTestSFTP(t, 0)

	cfg := s.cfg()
	cfg.HostKey = "" // first contact: refuse, report the offered key
	var hk *remote.HostKeyError
	if _, err := remote.DialSSH(cfg); !errors.As(err, &hk) {
		t.Fatalf("empty pin: want HostKeyError, got %v", err)
	} else if hk.Offered != s.hostKey || hk.Stored != "" {
		t.Fatalf("empty pin: offered=%q stored=%q", hk.Offered, hk.Stored)
	}

	cfg.HostKey = "AAAA" // wrong pin: mismatch
	if _, err := remote.DialSSH(cfg); !errors.As(err, &hk) || hk.Stored != "AAAA" {
		t.Fatalf("wrong pin: want mismatch HostKeyError, got %v", err)
	}

	conn, err := remote.DialSSH(s.cfg()) // correct pin: connects
	if err != nil {
		t.Fatalf("correct pin: %v", err)
	}
	conn.Close()
}
