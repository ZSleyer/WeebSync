package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/geoip"
	"github.com/ch4d1/weebsync/internal/geoip/geoiptest"
)

var geoipNets = []geoiptest.Net{
	{CIDR: "203.0.113.0/24", City: "Darmstadt", Country: "DE"},
	{CIDR: "10.0.0.0/8", City: "Privatestadt", Country: "XX"},
}

// geoipServer is a server with the feature on and its data dir in the temp
// dir, downloading from base.
func geoipServer(t *testing.T, base string) *Server {
	t.Helper()
	d := dbtest.Open(t)
	if err := db.SetSetting(d, "geoip_enabled", "true"); err != nil {
		t.Fatal(err)
	}
	return testServer(t, &Server{
		DB: d, OIDC: auth.NewManager(context.Background(), d),
		DataDir: t.TempDir(), geoipBase: base, geoipClient: http.DefaultClient,
	})
}

// geoipHost serves the monthly files: answers maps a URL path to a status and
// body, anything else is a 404. hits counts the requests.
func geoipHost(t *testing.T, answers map[string]func(http.ResponseWriter)) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.Header.Get("User-Agent") != "weebsync" {
			t.Errorf("User-Agent = %q", r.Header.Get("User-Agent"))
		}
		if h, ok := answers[r.URL.Path]; ok {
			h(w)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

func geoipServe(b []byte) func(http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		if _, err := w.Write(b); err != nil {
			panic(err)
		}
	}
}

func geoipMonthPath(t time.Time) string {
	return "/dbip-city-lite-" + t.UTC().Format("2006-01") + ".mmdb.gz"
}

func geoipThisMonth() time.Time { return time.Now().UTC() }
func geoipLastMonth() time.Time {
	n := geoipThisMonth()
	return time.Date(n.Year(), n.Month()-1, 15, 0, 0, 0, 0, time.UTC)
}

func geoipMmdb(o geoiptest.Options) []byte { return geoiptest.Gzip(geoiptest.Build(geoipNets, o)) }

func geoipLookup(t *testing.T, r *geoip.Reader, ip string) geoip.Place {
	t.Helper()
	p, err := r.Lookup(netip.MustParseAddr(ip))
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// dirFiles lists what is in the geoip directory.
func geoipDirFiles(t *testing.T, s *Server) []string {
	t.Helper()
	ents, err := os.ReadDir(s.geoipDir())
	if os.IsNotExist(err) {
		return nil
	} else if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range ents {
		out = append(out, e.Name())
	}
	return out
}

func TestGeoipUpdateStoresDatabase(t *testing.T) {
	host, _ := geoipHost(t, map[string]func(http.ResponseWriter){
		geoipMonthPath(geoipThisMonth()): geoipServe(geoipMmdb(geoiptest.Options{})),
	})
	s := geoipServer(t, host.URL)
	s.updateGeoip(context.Background(), false)

	r := s.geoipReader()
	if r == nil {
		t.Fatal("no reader after a successful update")
	}
	if p := geoipLookup(t, r, "203.0.113.9"); p.City != "Darmstadt" || p.Country != "DE" {
		t.Errorf("lookup = %+v", p)
	}
	if got := geoipDirFiles(t, s); len(got) != 1 || got[0] != geoipFile {
		t.Errorf("geoip dir = %v, want only %s", got, geoipFile)
	}
	if db.Setting(s.DB, "geoip_at") == "" {
		t.Error("geoip_at not stamped")
	}
}

func TestGeoipFallsBackToPreviousMonth(t *testing.T) {
	host, hits := geoipHost(t, map[string]func(http.ResponseWriter){
		geoipMonthPath(geoipLastMonth()): geoipServe(geoipMmdb(geoiptest.Options{Built: geoipLastMonth()})),
	})
	s := geoipServer(t, host.URL)
	s.updateGeoip(context.Background(), false)
	if s.geoipReader() == nil {
		t.Fatal("no reader: the previous month was not tried")
	}
	if hits.Load() != 2 {
		t.Errorf("%d requests, want the current month then the previous", hits.Load())
	}
	// nothing newer is out, and the held database is the previous month's:
	// another run must not download it again
	s.updateGeoip(context.Background(), false)
	if hits.Load() != 3 {
		t.Errorf("%d requests, want just the current month asked once more", hits.Load())
	}
}

func TestGeoipBadDownloadsKeepTheOldDatabase(t *testing.T) {
	old := geoipMmdb(geoiptest.Options{Built: geoipLastMonth()})
	huge := geoiptest.Gzip(make([]byte, 4<<20))
	cases := map[string]func(http.ResponseWriter){
		"not gzip": geoipServe([]byte("<html>not a database</html>")),
		"not mmdb": geoipServe(geoiptest.Gzip([]byte("plain bytes, no metadata marker"))),
		"wrong type": geoipServe(geoiptest.Gzip(geoiptest.Build(geoipNets,
			geoiptest.Options{Type: "DBIP-ASN-Lite"}))),
		"from the future": geoipServe(geoiptest.Gzip(geoiptest.Build(geoipNets,
			geoiptest.Options{Built: time.Now().AddDate(0, 0, 10)}))),
		"truncated":    geoipServe(old[:len(old)/2]),
		"server error": func(w http.ResponseWriter) { http.Error(w, "no", http.StatusInternalServerError) },
		"too big":      geoipServe(huge),
	}
	for name, h := range cases {
		t.Run(name, func(t *testing.T) {
			host, _ := geoipHost(t, map[string]func(http.ResponseWriter){geoipMonthPath(geoipThisMonth()): h})
			s := geoipServer(t, host.URL)
			if err := os.MkdirAll(s.geoipDir(), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(s.geoipPath(), geoiptest.Build(geoipNets, geoiptest.Options{Built: geoipLastMonth()}), 0o644); err != nil {
				t.Fatal(err)
			}
			s.openGeoip()
			before := s.geoip.Load()
			if before == nil {
				t.Fatal("stored database not opened")
			}
			prev := geoipMaxRaw
			geoipMaxRaw = 1 << 20
			t.Cleanup(func() { geoipMaxRaw = prev })

			s.updateGeoip(context.Background(), true)

			if s.geoip.Load() != before {
				t.Error("the live reader was replaced")
			}
			if got := geoipDirFiles(t, s); len(got) != 1 || got[0] != geoipFile {
				t.Errorf("geoip dir = %v, want only the old %s", got, geoipFile)
			}
			if geoipLookup(t, before, "203.0.113.9").City != "Darmstadt" {
				t.Error("old reader no longer answers")
			}
			if db.Setting(s.DB, "geoip_at") != "" {
				t.Error("failure stamped geoip_at")
			}
		})
	}
}

func TestGeoipCompressedSizeCap(t *testing.T) {
	host, _ := geoipHost(t, map[string]func(http.ResponseWriter){geoipMonthPath(geoipThisMonth()): geoipServe(geoipMmdb(geoiptest.Options{}))})
	s := geoipServer(t, host.URL)
	prev := geoipMaxGz
	geoipMaxGz = 64
	t.Cleanup(func() { geoipMaxGz = prev })
	s.updateGeoip(context.Background(), true)
	if s.geoip.Load() != nil || len(geoipDirFiles(t, s)) != 0 {
		t.Errorf("a body over the cap left %v behind", geoipDirFiles(t, s))
	}
}

func TestGeoipOffDoesNothing(t *testing.T) {
	host, hits := geoipHost(t, map[string]func(http.ResponseWriter){geoipMonthPath(geoipThisMonth()): geoipServe(geoipMmdb(geoiptest.Options{}))})
	s := geoipServer(t, host.URL)
	if err := db.SetSetting(s.DB, "geoip_enabled", "false"); err != nil {
		t.Fatal(err)
	}
	s.updateGeoip(context.Background(), true)
	s.geoipCheck()
	if hits.Load() != 0 || len(geoipDirFiles(t, s)) != 0 {
		t.Errorf("switched off: %d requests, files %v", hits.Load(), geoipDirFiles(t, s))
	}
}

func TestGeoipDropRemovesTheFile(t *testing.T) {
	host, _ := geoipHost(t, map[string]func(http.ResponseWriter){geoipMonthPath(geoipThisMonth()): geoipServe(geoipMmdb(geoiptest.Options{}))})
	s := geoipServer(t, host.URL)
	s.updateGeoip(context.Background(), true)
	if s.geoip.Load() == nil {
		t.Fatal("setup: no database")
	}
	s.dropGeoip()
	if s.geoip.Load() != nil || len(geoipDirFiles(t, s)) != 0 {
		t.Errorf("after drop: reader %v, files %v", s.geoip.Load(), geoipDirFiles(t, s))
	}
}

func TestGeoipDue(t *testing.T) {
	dir := t.TempDir()
	open := func(built time.Time) *geoip.Reader {
		p := filepath.Join(dir, built.Format("20060102")+".mmdb")
		if err := os.WriteFile(p, geoiptest.Build(geoipNets, geoiptest.Options{Built: built}), 0o600); err != nil {
			t.Fatal(err)
		}
		r, err := geoip.Open(p)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if err := r.Close(); err != nil {
				t.Error(err)
			}
		})
		return r
	}
	sep := open(time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC))
	for _, c := range []struct {
		name string
		r    *geoip.Reader
		now  time.Time
		want bool
	}{
		{"nothing held", nil, time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC), true},
		{"same month", sep, time.Date(2026, 9, 20, 0, 0, 0, 0, time.UTC), false},
		{"1st before publication", sep, time.Date(2026, 10, 1, 7, 59, 0, 0, time.UTC), false},
		{"1st after publication", sep, time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC), true},
		{"later in the month", sep, time.Date(2026, 10, 19, 0, 0, 0, 0, time.UTC), true},
		{"year turns", open(time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC)), time.Date(2027, 1, 2, 0, 0, 0, 0, time.UTC), true},
	} {
		if got := geoipDue(c.r, c.now); got != c.want {
			t.Errorf("%s: due = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestGeoipURLs(t *testing.T) {
	got := geoipURLs("https://x.example/free", time.Date(2027, 1, 31, 12, 0, 0, 0, time.UTC))
	want := []string{
		"https://x.example/free/dbip-city-lite-2027-01.mmdb.gz",
		"https://x.example/free/dbip-city-lite-2026-12.mmdb.gz",
	}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("urls = %v, want %v", got, want)
	}
}

// With the lookup on, a session from a public address carries its place and
// one from a private address carries none; switched off, neither does.
func TestSessionsCarryAPlace(t *testing.T) {
	host, _ := geoipHost(t, map[string]func(http.ResponseWriter){geoipMonthPath(geoipThisMonth()): geoipServe(geoipMmdb(geoiptest.Options{}))})
	s := geoipServer(t, host.URL)
	s.updateGeoip(context.Background(), true)
	mux := http.NewServeMux()
	s.Register(mux)
	if _, err := s.DB.Exec(`INSERT INTO users (id, email, is_admin) VALUES (1, 'a@example.com', 1)`); err != nil {
		t.Fatal(err)
	}
	var me *http.Cookie
	for _, ua := range []string{"public", "private", "unknown"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/", nil)
		req.Header.Set("User-Agent", ua)
		if err := auth.CreateSession(s.DB, rec, req, 1, true); err != nil {
			t.Fatal(err)
		}
		me = rec.Result().Cookies()[0]
	}
	for ua, ip := range map[string]string{"public": "203.0.113.7", "private": "10.1.2.3", "unknown": "198.51.100.9"} {
		if _, err := s.DB.Exec(`UPDATE sessions SET ip = ? WHERE user_agent = ?`, ip, ua); err != nil {
			t.Fatal(err)
		}
	}
	list := func() map[string]sessionInfo {
		t.Helper()
		rec := doReq(mux, "GET", "/api/auth/sessions", "", me)
		if rec.Code != http.StatusOK {
			t.Fatalf("list: %d %s", rec.Code, rec.Body)
		}
		var out []sessionInfo
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		m := map[string]sessionInfo{}
		for _, x := range out {
			m[x.UserAgent] = x
		}
		return m
	}
	got := list()
	if p := got["public"]; p.City != "Darmstadt" || p.CountryCode != "DE" {
		t.Errorf("public address: %+v, want Darmstadt DE", p)
	}
	for _, ua := range []string{"private", "unknown"} {
		if p := got[ua]; p.City != "" || p.CountryCode != "" {
			t.Errorf("%s address: %+v, want no place", ua, p)
		}
	}
	if err := db.SetSetting(s.DB, "geoip_enabled", "false"); err != nil {
		t.Fatal(err)
	}
	if p := list()["public"]; p.City != "" || p.CountryCode != "" {
		t.Errorf("feature off: %+v, want no place", p)
	}
}
