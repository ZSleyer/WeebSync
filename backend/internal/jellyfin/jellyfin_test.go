package jellyfin

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ch4d1/weebsync/internal/plex"
)

const (
	idA  = "0123456789abcdef0123456789abcdef" // show folder one
	idB  = "fedcba9876543210fedcba9876543210" // same show, second folder
	idMv = "00000000000000100000000000000000" // a movie
)

func fakeServer(t *testing.T) *httptest.Server {
	t.Helper()
	ep := func(se, n int, path string, streams ...map[string]any) map[string]any {
		return map[string]any{"Id": path, "Type": "Episode", "ParentIndexNumber": se, "IndexNumber": n,
			"Path": path, "LocationType": "FileSystem", "MediaStreams": streams}
	}
	video := map[string]any{"Type": "Video", "Index": 0, "Width": 1920, "Height": 800}
	jpn := map[string]any{"Type": "Audio", "Index": 1, "Language": "jpn"}
	deuForced := map[string]any{"Type": "Subtitle", "Index": 2, "Language": "deu", "IsForced": true}
	deuFull := map[string]any{"Type": "Subtitle", "Index": 3, "Language": "deu", "Title": "Deutsch"}
	engSigns := map[string]any{"Type": "Subtitle", "Index": 4, "Language": "eng", "Title": "Signs (Forced)"}
	routes := map[string]any{
		"/System/Info": map[string]any{"Id": "srv1", "ServerName": "Test", "Version": "12.2.0"},
		"/Users/Me":    map[string]any{"Id": "u1", "Name": "Chisato"},
		"/Library/VirtualFolders": []map[string]any{
			{"Name": "Anime", "ItemId": "lib1", "CollectionType": "tvshows", "Locations": []string{"/media/a/anime", "/media/b/anime"}},
			{"Name": "Movies", "ItemId": "lib2", "CollectionType": "movies", "Locations": []string{"/media/a/movies"},
				"LibraryOptions": map[string]any{"TypeOptions": []map[string]any{{"Type": "Movie", "MetadataFetchers": []string{"TheMovieDb"}}}}},
		},
		"/Shows/" + idA + "/Episodes": map[string]any{"Items": []any{
			ep(1, 1, "/media/a/anime/Show/Season 01/Show S01E01.mkv", video, jpn, deuForced, deuFull),
			map[string]any{"Id": "v", "Type": "Episode", "ParentIndexNumber": 1, "IndexNumber": 3, "LocationType": "Virtual"},
		}},
		"/Shows/" + idB + "/Episodes": map[string]any{"Items": []any{
			ep(1, 2, "/media/b/anime/Show Dub/Season 01/Show S01E02.mkv", jpn, engSigns),
		}},
		"/Shows/" + idMv + "/Episodes": map[string]any{"Items": []any{}},
	}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Authorization"), `Token="key"`) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		q := r.URL.Query()
		var body any
		switch {
		case r.URL.Path == "/Items" && q.Get("parentId") == "lib1":
			if q.Get("userId") != "u1" {
				t.Errorf("listing without a user: %s", r.URL)
			}
			all := []any{
				map[string]any{"Id": idB, "Type": "Series", "Name": "Show", "Path": "/media/b/anime/Show Dub",
					"ProviderIds": map[string]string{"Tvdb": "42"}, "RecursiveItemCount": 1, "ChildCount": 1},
				map[string]any{"Id": idA, "Type": "Series", "Name": "Show", "Path": "/media/a/anime/Show", "ProductionYear": 2020,
					"ProviderIds": map[string]string{"Tvdb": "42", "Tmdb": "7", "Imdb": "tt0099"}, "RecursiveItemCount": 2, "ChildCount": 1},
			}
			// paged one item at a time, see pageSize below
			start := map[string]int{"0": 0, "1": 1}[q.Get("startIndex")]
			body = map[string]any{"Items": all[start : start+1], "TotalRecordCount": len(all)}
		case r.URL.Path == "/Items" && q.Get("parentId") == "lib2":
			body = map[string]any{"Items": []any{map[string]any{"Id": idMv, "Type": "Movie", "Name": "Film",
				"Path": "/media/a/movies/Film (2001)/Film.mkv", "ProviderIds": map[string]string{"Tmdb": "5"}}}, "TotalRecordCount": 1}
		case r.URL.Path == "/Items" && q.Get("ids") != "":
			var its []any
			for _, id := range strings.Split(q.Get("ids"), ",") {
				switch id {
				case idA:
					its = append(its, map[string]any{"Id": idA, "Type": "Series", "Name": "Show", "Path": "/media/a/anime/Show", "DisplayOrder": "absolute"})
				case idMv:
					its = append(its, map[string]any{"Id": idMv, "Type": "Movie", "Path": "/media/a/movies/Film (2001)/Film.mkv",
						"MediaStreams": []any{video, jpn}})
				}
			}
			body = map[string]any{"Items": its}
		case r.URL.Path == "/Library/Media/Updated" && r.Method == http.MethodPost:
			var in struct {
				Updates []struct{ Path, UpdateType string }
			}
			json.NewDecoder(r.Body).Decode(&in)
			if len(in.Updates) != 1 || in.Updates[0].Path != "/media/a/anime/Show" {
				t.Errorf("refresh body %+v", in)
			}
			w.WriteHeader(http.StatusNoContent)
			return
		default:
			b, ok := routes[r.URL.Path]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			body = b
		}
		json.NewEncoder(w).Encode(body)
	}))
}

func TestClientSpeaksPlexTypes(t *testing.T) {
	srv := fakeServer(t)
	defer srv.Close()
	old := pageSize
	pageSize = 1
	defer func() { pageSize = old }()
	c := New(srv.URL, "key")

	shows, err := c.Shows("lib1")
	if err != nil || len(shows) != 1 {
		t.Fatalf("two folders of one tvdb show must bundle into one: %+v %v", shows, err)
	}
	sh := shows[0]
	if sh.RatingKey != ShortKey(idA) || sh.TVDBID != 42 || sh.TMDBID != 7 || sh.IMDBID != 99 || sh.LeafCount != 3 || len(sh.Locations) != 2 {
		t.Fatalf("show %+v", sh)
	}
	if k, ok := c.ShowKeyForPath("/media/b/anime/Show Dub/Season 01"); !ok || k != sh.RatingKey {
		t.Errorf("second folder must resolve to the bundled show, got %q %v", k, ok)
	}
	if _, ok := c.ShowKeyForPath("/media/a/anime"); ok {
		t.Error("a library root names no show")
	}

	eps, err := c.Episodes(sh.RatingKey)
	if err != nil || len(eps) != 2 {
		t.Fatalf("episodes of both folders, no virtual ones: %+v %v", eps, err)
	}
	sm, err := c.SeasonMedia(sh.RatingKey)
	if err != nil {
		t.Fatal(err)
	}
	if got := sm[1]; got.ResHeight != 1080 || strings.Join(got.Dub, ",") != "jpn" || strings.Join(got.Sub, ",") != "deu" {
		t.Errorf("forced tracks add no language, scope 1080 stays 1080: %+v", got)
	}

	o, err := c.ShowPreferences(sh.RatingKey)
	if err != nil || o.Provider != "tmdb" || o.Order != "absolute" {
		t.Errorf("ordering %+v %v", o, err)
	}
	if l := c.DeepLink("srv1", sh.RatingKey); l != srv.URL+"/web/#/details?id="+idA+"&serverId=srv1" {
		t.Errorf("deep link %q", l)
	}
	if err := c.SetStreams(1, 2, 3); !errors.Is(err, plex.ErrUnsupported) {
		t.Errorf("stream selection must report unsupported, got %v", err)
	}
	if err := c.Refresh("", "/media/a/anime/Show/"); err != nil {
		t.Error(err)
	}

	// a key this client never listed resolves through a fresh listing
	c2 := New(srv.URL, "key")
	sm2, err := c2.SeasonMedia(ShortKey(idMv))
	if err != nil || sm2[0].File == "" || sm2[0].ResHeight != 1080 {
		t.Errorf("movie quality sits under season 0: %+v %v", sm2, err)
	}
	id, err := c2.Identity()
	if err != nil || id.MachineIdentifier != "srv1" || id.MyPlexUsername != "Chisato" {
		t.Errorf("identity %+v %v", id, err)
	}
}

func TestQuickConnectAndFavorites(t *testing.T) {
	authed := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Authorization"), `DeviceId="dev1"`) {
			w.WriteHeader(http.StatusBadRequest) // Initiate refuses a missing DeviceId
			return
		}
		var body any
		switch r.URL.Path {
		case "/QuickConnect/Enabled":
			body = true
		case "/QuickConnect/Initiate":
			body = map[string]any{"Secret": "s3cret", "Code": "123456"}
		case "/QuickConnect/Connect":
			body = map[string]any{"Secret": r.URL.Query().Get("secret"), "Authenticated": authed}
		case "/Users/AuthenticateWithQuickConnect":
			body = map[string]any{"AccessToken": "usertok", "User": map[string]any{"Id": "u9", "Name": "Takina"}}
		case "/Users/Me":
			body = map[string]any{"Id": "u9", "Name": "Takina"}
		case "/Items":
			if r.URL.Query().Get("isFavorite") != "true" || r.URL.Query().Get("userId") != "u9" {
				t.Errorf("favourites query %s", r.URL)
			}
			body = map[string]any{"Items": []any{
				map[string]any{"Type": "Series", "Name": "Lycoris Recoil", "ProductionYear": 2022, "ProviderIds": map[string]string{"Tvdb": "414057"}},
				map[string]any{"Type": "Movie", "Name": "Film", "ProviderIds": map[string]string{"Tmdb": "5"}},
			}}
		default:
			w.WriteHeader(http.StatusNotFound)
			return
		}
		json.NewEncoder(w).Encode(body)
	}))
	defer srv.Close()
	c := New(srv.URL, "")
	c.DeviceID = "dev1"
	qc, err := c.QuickConnectStart()
	if err != nil || qc.Code != "123456" {
		t.Fatalf("start %+v %v", qc, err)
	}
	if tok, _, err := c.QuickConnectToken(qc.Secret); err != nil || tok != "" {
		t.Fatalf("not entered yet must give no token: %q %v", tok, err)
	}
	authed = true
	tok, u, err := c.QuickConnectToken(qc.Secret)
	if err != nil || tok != "usertok" || u.Name != "Takina" {
		t.Fatalf("token %q %+v %v", tok, u, err)
	}
	uc := New(srv.URL, tok)
	uc.DeviceID = "dev1"
	favs, err := uc.Favorites()
	if err != nil || len(favs) != 2 || favs[0].TVDB != 414057 || favs[1].Type != "movie" || favs[1].TMDB != 5 {
		t.Fatalf("favourites %+v %v", favs, err)
	}
}

func TestShortKey(t *testing.T) {
	if ShortKey(idMv) != "1" {
		t.Errorf("got %q", ShortKey(idMv))
	}
	if ShortKey("ffffffffffffffffffffffffffffffff") != "1152921504606846975" { // 2^60-1, fits int64
		t.Error("max")
	}
	if ShortKey("") != "" || ShortKey("000000000000000ab") != "" {
		t.Error("too short or zero must give no key")
	}
}
