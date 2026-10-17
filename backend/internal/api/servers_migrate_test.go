package api

import (
	"crypto/x509"
	"encoding/json"
	"errors"
	"net/http"
	"net/textproto"
	"strconv"
	"testing"

	"github.com/ch4d1/weebsync/internal/remote/pool"
	"github.com/ch4d1/weebsync/internal/secret"
)

// legacyFTP stores a server with the retired protocol, as an old database holds it.
func legacyFTP(t *testing.T, s *Server, userID int64, port int) int64 {
	t.Helper()
	enc, err := secret.Encrypt("pw")
	if err != nil {
		t.Fatal(err)
	}
	res, err := s.DB.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path, max_connections)
		VALUES (?, 'old', 'ftp', '203.0.113.9', ?, 'u', ?, '/', 3)`, userID, port, enc)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	return id
}

func TestMigrateFTPS(t *testing.T) {
	if err := secret.Init(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	mux, s, adminC, userC, _, uid := setupUsersTest(t)
	s.Conns = pool.New()
	id := legacyFTP(t, s, uid, 21)
	path := "/api/servers/" + strconv.FormatInt(id, 10) + "/migrate-ftps"
	state := func() (string, int) {
		var proto string
		var port int
		_ = s.DB.QueryRow(`SELECT protocol, port FROM servers WHERE id = ?`, id).Scan(&proto, &port)
		return proto, port
	}

	// another user's server is not found
	if rec := doReq(mux, "POST", path, `{"force":true}`, adminC); rec.Code != http.StatusNotFound {
		t.Fatalf("foreign server: %d", rec.Code)
	}

	// a TEST-NET address nobody answers: the test fails, nothing is saved
	rec := doReq(mux, "POST", path, `{"port":990}`, userC)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("failing test: %d %s", rec.Code, rec.Body)
	}
	var fail MigrateFTPSError
	if err := json.Unmarshal(rec.Body.Bytes(), &fail); err != nil || fail.Code == "" || fail.Error == "" {
		t.Fatalf("failure carries no cause: %s", rec.Body)
	}
	if p, port := state(); p != "ftp" || port != 21 {
		t.Fatalf("failed test changed the row: %s %d", p, port)
	}

	if rec := doReq(mux, "POST", path, `{"port":70000}`, userC); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad port: %d", rec.Code)
	}
	if rec := doReq(mux, "POST", "/api/servers/9999/migrate-ftps", `{}`, userC); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown server: %d", rec.Code)
	}

	// force saves without a passing test and keeps the stored password
	if rec := doReq(mux, "POST", path, `{"port":990,"force":true}`, userC); rec.Code != http.StatusOK {
		t.Fatalf("force: %d %s", rec.Code, rec.Body)
	}
	if p, port := state(); p != "ftps" || port != 990 {
		t.Fatalf("after force: %s %d", p, port)
	}
	var enc []byte
	_ = s.DB.QueryRow(`SELECT secret_enc FROM servers WHERE id = ?`, id).Scan(&enc)
	if pw, _ := secret.Decrypt(enc); pw != "pw" {
		t.Fatalf("password lost: %q", pw)
	}
	// a server that is no plain FTP any more is not migrated twice
	if rec := doReq(mux, "POST", path, `{"force":true}`, userC); rec.Code != http.StatusBadRequest {
		t.Fatalf("second migrate: %d", rec.Code)
	}
}

func TestFTPSFailCode(t *testing.T) {
	for _, c := range []struct {
		err  error
		want string
	}{
		{x509.UnknownAuthorityError{}, "cert_untrusted"},
		{x509.HostnameError{Host: "h"}, "cert_untrusted"},
		{&textproto.Error{Code: 534, Msg: "no AUTH TLS"}, "tls_unsupported"},
		{errors.New("tls: first record does not look like a TLS handshake"), "tls_unsupported"},
		{errors.New("dial tcp: connection refused"), "connect_failed"},
	} {
		if got := ftpsFailCode(c.err); got != c.want {
			t.Errorf("%v: got %s, want %s", c.err, got, c.want)
		}
	}
}
