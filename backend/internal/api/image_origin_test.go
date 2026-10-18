package api

import "testing"

func TestImageOrigin(t *testing.T) {
	tests := []struct {
		in          string
		anilistOnly bool
		want        string
	}{
		{"https://s4.anilist.co/file/anilistcdn/media/anime/banner/1.jpg", true, "https://s4.anilist.co/file/anilistcdn/media/anime/banner/1.jpg"},
		{"https://image.tmdb.org/t/p/w342/x.jpg", false, "https://image.tmdb.org/t/p/w342/x.jpg"},
		{"https://artworks.thetvdb.com/banners/posters/1.jpg", false, "https://artworks.thetvdb.com/banners/posters/1.jpg"},
		{"https://image.tmdb.org/t/p/w342/x.jpg", true, ""},
		{"https://example.com/x.jpg", false, ""},
		{"https://evil.s4.anilist.co/x.jpg", false, ""},
		{"https://s4.anilist.co.example.com/x.jpg", false, ""},
		{"http://s4.anilist.co/x.jpg", false, ""},
		{"https://s4.anilist.co:8443/x.jpg", false, ""},
		{"https://u@s4.anilist.co/x.jpg", false, ""},
		{"https://s4.anilist.co/x.jpg?v=1", false, ""},
		{"https://s4.anilist.co/", false, ""},
	}
	for _, tt := range tests {
		got, ok := imageOrigin(tt.in, tt.anilistOnly)
		if got != tt.want || ok != (tt.want != "") {
			t.Errorf("imageOrigin(%q, %v) = %q, %v; want %q", tt.in, tt.anilistOnly, got, ok, tt.want)
		}
	}
}
