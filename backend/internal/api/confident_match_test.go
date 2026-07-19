package api

import (
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
)

func hit(id int, titles ...string) seriesHit {
	var m anilist.Media
	m.ID = id
	m.Title.Romaji = titles[0]
	return seriesHit{Media: m, Titles: titles}
}

func TestConfidentMatch(t *testing.T) {
	// primary names are native; aliases/translations carry the other titles
	hits := []seriesHit{
		hit(416843, "名探偵コナン ゼロの日常", "Detective Conan: Zero's Tea Time"),
		hit(72454, "名探偵コナン", "Detective Conan", "Meitantei Conan", "Case Closed"),
	}
	if id, ok := confidentMatch("Detective Conan", hits); !ok || id != 72454 {
		t.Errorf("english: id=%d ok=%v, want 72454", id, ok)
	}
	if id, ok := confidentMatch("Meitantei Conan", hits); !ok || id != 72454 {
		t.Errorf("romaji alias: id=%d ok=%v, want 72454", id, ok)
	}
	if id, ok := confidentMatch("Case Closed", hits); !ok || id != 72454 {
		t.Errorf("alias: id=%d ok=%v, want 72454", id, ok)
	}
	if _, ok := confidentMatch("Totally Unrelated", hits); ok {
		t.Error("no title matches -> not confident")
	}
	if _, ok := confidentMatch("Anything", nil); ok {
		t.Error("empty hits not confident")
	}
}
