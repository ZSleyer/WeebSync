package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/ch4d1/weebsync/internal/remote/pool"
	"github.com/ch4d1/weebsync/internal/secret"
)

func TestServerColor(t *testing.T) {
	if err := secret.Init(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	mux, s, _, userC, _, _ := setupUsersTest(t)
	s.Conns = pool.New()
	body := `{"name":"seedbox","protocol":"sftp","host":"example.com","username":"u","password":"p","color":"violet"}`
	if rec := doReq(mux, "POST", "/api/servers", body, userC); rec.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	if rec := doReq(mux, "POST", "/api/servers", `{"name":"x","protocol":"sftp","host":"h","username":"u","password":"p","color":"plaid"}`, userC); rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown colour: got %d, want 400", rec.Code)
	}
	rec := doReq(mux, "GET", "/api/servers", "", userC)
	var list []serverInfo
	json.Unmarshal(rec.Body.Bytes(), &list)
	if len(list) != 1 || list[0].Color != "violet" {
		t.Fatalf("list = %+v", list)
	}
	upd := `{"name":"seedbox","protocol":"sftp","host":"example.com","username":"u","color":"teal"}`
	if rec := doReq(mux, "PUT", "/api/servers/"+strconv.FormatInt(list[0].ID, 10), upd, userC); rec.Code != http.StatusOK {
		t.Fatalf("update: %d %s", rec.Code, rec.Body)
	}
	rec = doReq(mux, "GET", "/api/servers", "", userC)
	json.Unmarshal(rec.Body.Bytes(), &list)
	if list[0].Color != "teal" {
		t.Fatalf("after update = %q", list[0].Color)
	}
}
