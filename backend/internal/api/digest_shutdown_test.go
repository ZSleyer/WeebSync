package api

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/mailer"
)

// A daily digest collects in memory for up to a day; a container restart in
// between used to drop it without a trace. Shutdown has to send what is
// collected before the database closes.
func TestShutdownFlushesCollectedDigests(t *testing.T) {
	s := digestTestServer(t)
	defer swapQuiet(t, time.Hour)()
	var mu sync.Mutex
	sent := map[string]int{}
	s.digestSend = func(userID int64, category string, items []digestItem) {
		mu.Lock()
		defer mu.Unlock()
		sent[category] += len(items)
	}
	// the queue still works: a timer flush would wait another round
	insertDownload(t, s, "running")
	s.NotifyDownload(1, "download_done", digestItem{serverID: 1, remotePath: "/one.mkv"})
	s.NotifyDownload(1, "download_done", digestItem{serverID: 1, remotePath: "/two.mkv"})
	s.NotifyDownload(1, "download_failed", digestItem{serverID: 1, remotePath: "/three.mkv", note: "x"})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s.Shutdown(ctx)

	mu.Lock()
	defer mu.Unlock()
	if sent["download_done"] != 2 || sent["download_failed"] != 1 {
		t.Fatalf("sent at shutdown = %v, want 2 done and 1 failed", sent)
	}
	s.digestMu.Lock()
	defer s.digestMu.Unlock()
	if len(s.digest) != 0 {
		t.Errorf("digests left after shutdown: %v", s.digest)
	}
}

// slowSMTP is a mail server that greets after a pause and takes one message;
// got is closed once the message's DATA has arrived.
func slowSMTP(t *testing.T, greetAfter time.Duration) (port string, got <-chan struct{}) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	done := make(chan struct{})
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		time.Sleep(greetAfter)
		r := bufio.NewReader(c)
		say := func(l string) { fmt.Fprintf(c, "%s\r\n", l) }
		say("220 stub")
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			switch cmd := strings.ToUpper(strings.TrimSpace(line)); {
			case strings.HasPrefix(cmd, "EHLO"), strings.HasPrefix(cmd, "HELO"):
				say("250 stub")
			case cmd == "DATA":
				say("354 go on")
				for {
					l, err := r.ReadString('\n')
					if err != nil {
						return
					}
					if l == ".\r\n" {
						break
					}
				}
				close(done)
				say("250 queued")
			case cmd == "QUIT":
				say("221 bye")
				return
			default:
				say("250 ok")
			}
		}
	}()
	_, port, _ = net.SplitHostPort(ln.Addr().String())
	return port, done
}

// The shutdown flush hands the digest mail to EmailNotify, which sends it in
// the background: Shutdown has to wait for that send too, or the process
// exits before the SMTP server has the mail.
func TestShutdownFlushDeliversDigestMail(t *testing.T) {
	s := digestTestServer(t)
	defer swapQuiet(t, time.Hour)()
	s.Mail = mailer.New(s.DB)
	port, got := slowSMTP(t, 200*time.Millisecond)
	for k, v := range map[string]string{"smtp_host": "127.0.0.1", "smtp_port": port, "smtp_security": "none", "smtp_from": "weebsync@example.com"} {
		if err := db.SetSetting(s.DB, k, v); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.DB.Exec(`UPDATE users SET email_verified = 1, email_prefs = 'download_done' WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	s.NotifyDownload(1, "download_done", digestItem{serverID: 1, remotePath: "/one.mkv"})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s.Shutdown(ctx)
	select {
	case <-got:
	default:
		t.Fatal("Shutdown returned before the digest mail reached the mail server")
	}
}

// A send that hangs (an SMTP server that never answers) must not hold the
// shutdown past its budget.
func TestShutdownDigestFlushBoundedByBudget(t *testing.T) {
	s := digestTestServer(t)
	defer swapQuiet(t, time.Hour)()
	release := make(chan struct{})
	started := make(chan struct{}, 1)
	s.digestSend = func(int64, string, []digestItem) {
		started <- struct{}{}
		<-release
	}
	defer close(release)
	s.NotifyDownload(1, "download_done", digestItem{serverID: 1, remotePath: "/one.mkv"})

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	returned := make(chan struct{})
	go func() {
		s.Shutdown(ctx)
		close(returned)
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("the digest was never sent at shutdown")
	}
	select {
	case <-returned:
	case <-time.After(5 * time.Second):
		t.Fatal("a hanging send held Shutdown past its budget")
	}
}
