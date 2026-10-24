package api

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net"
	"net/http"
	"strconv"
	"sync/atomic"
	"testing"

	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/remote/pool"
	"github.com/ch4d1/weebsync/internal/secret"
	"golang.org/x/crypto/ssh"
)

// rejectingSSH is an SSH server on loopback that refuses every password and
// counts the attempts. It returns its port and its host key (base64), so a
// server row can pin it.
func rejectingSSH(t *testing.T, attempts *atomic.Int32) (int, string) {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &ssh.ServerConfig{PasswordCallback: func(ssh.ConnMetadata, []byte) (*ssh.Permissions, error) {
		attempts.Add(1)
		return nil, errors.New("denied")
	}}
	cfg.AddHostKey(signer)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				_, _, _, _ = ssh.NewServerConn(c, cfg) // fails at auth, by design
			}()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port, base64.StdEncoding.EncodeToString(signer.PublicKey().Marshal())
}

// The connection test lifts a tripped login breaker, since a test is how a
// fixed password is proven. Lifting it before checking whose server it is let
// any user reopen the door on another user's server, so the next job dialed the
// remote with the rejected password again - one step closer to its intrusion
// protection locking the account.
func TestServerTestDoesNotResetOthersAuthBreaker(t *testing.T) {
	if err := secret.Init(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	mux, s, _, userC, adminID, _ := setupUsersTest(t)
	s.Conns = pool.New()
	var attempts atomic.Int32
	port, key := rejectingSSH(t, &attempts)
	enc, err := secret.Encrypt("wrong")
	if err != nil {
		t.Fatal(err)
	}
	res, err := s.DB.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path, host_key)
		VALUES (?, 'srv', 'sftp', '127.0.0.1', ?, 'u', ?, '/', ?)`, adminID, port, enc, key)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()

	// the owner's job runs into the rejected login: the breaker opens
	if _, _, err := s.DialServer(adminID, id); !errors.Is(err, remote.ErrAuthRejected) {
		t.Fatalf("first dial: %v, want an auth rejection", err)
	}
	before := attempts.Load()

	// another user "tests" the owner's server
	rec := doReq(mux, "POST", "/api/servers/"+strconv.FormatInt(id, 10)+"/test", "", userC)
	if rec.Code != http.StatusNotFound {
		t.Errorf("foreign server test: got %d %s, want 404", rec.Code, rec.Body)
	}

	// the owner's next job must still be held back by the breaker
	if _, _, err := s.DialServer(adminID, id); !errors.Is(err, remote.ErrAuthRejected) {
		t.Fatalf("second dial: %v, want the stored auth rejection", err)
	}
	if got := attempts.Load(); got != before {
		t.Errorf("the server saw %d more login attempts after a foreign connection test", got-before)
	}
}
