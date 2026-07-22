package api

import (
	"testing"

	"github.com/ch4d1/weebsync/internal/plex"
)

func TestPickStream(t *testing.T) {
	streams := []plex.EpisodeStream{
		{ID: 1, Type: 1}, // video, never picked
		{ID: 2, Type: 2, LangCode: "deu", Language: "German"},   // Ger dub
		{ID: 3, Type: 2, LangCode: "jpn", Language: "Japanese"}, // Jap dub
		{ID: 4, Type: 3, LangCode: "", Language: "German"},      // Ger sub, code missing
		{ID: 5, Type: 3, LangCode: "eng"},                       // Eng sub
	}
	cases := []struct {
		typ  int
		want string
		id   int64
	}{
		{2, "Jap", 3},
		{2, "Ger", 2},
		{2, "ger", 2}, // case-insensitive app code
		{3, "Ger", 4}, // falls back to Language when languageCode is empty
		{3, "Eng", 5},
		{2, "Fre", 0}, // language not in the file
		{2, "", 0},    // no preference
		{3, "Jap", 0}, // wrong type must not match the Jap dub
	}
	for _, c := range cases {
		if got := pickStream(streams, c.typ, c.want); got != c.id {
			t.Errorf("pickStream(type %d, %q) = %d, want %d", c.typ, c.want, got, c.id)
		}
	}
}
