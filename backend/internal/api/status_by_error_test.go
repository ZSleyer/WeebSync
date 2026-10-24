package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/remote"
	"github.com/ch4d1/weebsync/internal/transfer"
	"github.com/go-webauthn/webauthn/protocol/webauthncbor"
	"github.com/go-webauthn/webauthn/protocol/webauthncose"
)

// A failing server lookup is a database error, not "server not found": only
// sql.ErrNoRows may answer 404.
func TestServerLookupFailureIsNot404(t *testing.T) {
	mux, s, adminC, userC := setupAdminTest(t)
	if _, err := s.DB.Exec(`ALTER TABLE servers RENAME COLUMN user_id TO owner_id`); err != nil {
		t.Fatal(err)
	}
	for _, rt := range []struct {
		method, path, body string
		c                  *http.Cookie
	}{
		{"POST", "/api/admin/jobs/index-crawl/run", `{"serverId":1}`, adminC},
		{"POST", "/api/servers/1/catalog/rematch", `{"path":"/x"}`, userC},
		{"GET", "/api/servers/1/catalog/explain?folder=/x/Show", "", userC},
		{"GET", "/api/servers/1/catalog/scope?path=/x", "", userC},
		{"PUT", "/api/servers/1/catalog/scope", `{"path":"/x","kind":"anime"}`, userC},
	} {
		if rec := doReq(mux, rt.method, rt.path, rt.body, rt.c); rec.Code != http.StatusInternalServerError {
			t.Errorf("%s %s: got %d, want 500: %s", rt.method, rt.path, rec.Code, rec.Body)
		}
	}
}

func watchStatusServer(t *testing.T) (*http.ServeMux, *Server, *http.Cookie) {
	t.Helper()
	d := dbtest.Open(t)
	root := t.TempDir()
	offline := func(userID, serverID int64) (remote.Client, string, error) {
		return nil, "", errors.New("offline")
	}
	s := &Server{DB: d, DownloadRoot: root, LocalRoots: []string{root}, Anilist: anilist.New(d),
		Transfers: transfer.NewManager(d, offline, root)}
	drainJobsAtCleanup(t, s)
	mux := http.NewServeMux()
	s.Register(mux)
	if _, err := d.Exec(`INSERT INTO users (email, is_admin) VALUES ('a@example.com', 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`INSERT INTO servers (user_id, name, protocol, host, port, username, secret_enc, root_path)
		VALUES (1, 'srv', 'sftp', 'localhost', 22, 'u', X'00', '/')`); err != nil {
		t.Fatal(err)
	}
	return mux, s, cookieForUser(t, d, 1)
}

// A watch write that fails for any reason but a duplicate is not "watch
// already exists": only a UNIQUE violation answers 409.
func TestWatchWriteFailureIsNot409(t *testing.T) {
	mux, s, cookie := watchStatusServer(t)
	if rec := doReq(mux, "POST", "/api/watches", `{"serverId":1,"remotePath":"/x/Show","localPath":"anime"}`, cookie); rec.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "POST", "/api/watches", `{"serverId":1,"remotePath":"/x/Show","localPath":"anime"}`, cookie); rec.Code != http.StatusConflict {
		t.Errorf("duplicate create: got %d, want 409: %s", rec.Code, rec.Body)
	}
	failWrites(t, s, "INSERT", "watches")
	failWrites(t, s, "UPDATE", "watches")
	if rec := doReq(mux, "POST", "/api/watches", `{"serverId":1,"remotePath":"/x/Other","localPath":"anime"}`, cookie); rec.Code != http.StatusInternalServerError {
		t.Errorf("create: got %d, want 500: %s", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "PUT", "/api/watches/1", `{"remotePath":"/x/Show","localPath":"elsewhere"}`, cookie); rec.Code != http.StatusInternalServerError {
		t.Errorf("update: got %d, want 500: %s", rec.Code, rec.Body)
	}
}

// A failing watch lookup on update is a database error, not "watch not found".
func TestWatchUpdateLookupFailureIsNot404(t *testing.T) {
	mux, s, cookie := watchStatusServer(t)
	if rec := doReq(mux, "PUT", "/api/watches/1", `{"remotePath":"/x/Show","localPath":"elsewhere"}`, cookie); rec.Code != http.StatusNotFound {
		t.Errorf("missing watch: got %d, want 404: %s", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "POST", "/api/watches", `{"serverId":1,"remotePath":"/x/Show","localPath":"anime"}`, cookie); rec.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	if _, err := s.DB.Exec(`ALTER TABLE watches RENAME COLUMN plex_sub_lang TO sub_lang_x`); err != nil {
		t.Fatal(err)
	}
	if rec := doReq(mux, "PUT", "/api/watches/1", `{"remotePath":"/x/Show","localPath":"elsewhere"}`, cookie); rec.Code != http.StatusInternalServerError {
		t.Errorf("update: got %d, want 500: %s", rec.Code, rec.Body)
	}
}

// A passkey that cannot be stored for any reason but a duplicate is not
// "credential already registered".
func TestPasskeyStoreFailureIsNot409(t *testing.T) {
	mux, s, _, userC, _, userID := setupUsersTest(t)
	if _, err := s.DB.Exec(`INSERT INTO settings (key, value) VALUES ('base_url', 'https://example.com')`); err != nil {
		t.Fatal(err)
	}
	setPassword(t, s, userID, "longenough123")
	key := newSoftKey(t, []byte("handle-of-the-test-user-32-bytes"))
	pub, _ := key.key.PublicKey.Bytes()
	cose, err := webauthncbor.Marshal(webauthncose.EC2PublicKeyData{
		PublicKeyData: webauthncose.PublicKeyData{KeyType: int64(webauthncose.EllipticKey), Algorithm: int64(webauthncose.AlgES256)},
		Curve:         1, XCoord: pub[1:33], YCoord: pub[33:],
	})
	if err != nil {
		t.Fatal(err)
	}
	failWrites(t, s, "INSERT", "webauthn_credentials")

	rec := doReq(mux, "POST", "/api/auth/webauthn/register/begin", `{"password":"longenough123"}`, userC)
	var begin struct {
		SessionID string `json:"sessionId"`
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &begin); err != nil {
		t.Fatalf("begin: %d %s", rec.Code, rec.Body)
	}
	req := httptest.NewRequest("POST", "/api/auth/webauthn/register/finish",
		strings.NewReader(key.noneAttestation(t, begin.PublicKey.Challenge, "example.com", "https://example.com", cose)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-WA-Session", begin.SessionID)
	req.AddCookie(userC)
	out := httptest.NewRecorder()
	mux.ServeHTTP(out, req)
	if out.Code != http.StatusInternalServerError {
		t.Errorf("got %d, want 500: %s", out.Code, out.Body)
	}
}
