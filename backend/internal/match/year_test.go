package match

import (
	"testing"

	"github.com/ch4d1/weebsync/internal/anilist"
)

// A number inside a title must not veto the entry that carries it.
func TestYearVetoSparesTitleNumbers(t *testing.T) {
	nh := media(1, "Night Head 2041", "", "TV", 2006)
	info := ParseName("Night Head 2041", "Night Head", "")
	if YearVeto(info, nh) {
		t.Error("Night Head 2041 vetoed")
	}
	if i, ok := Pick(info, []anilist.Media{nh}); i != 0 || !ok {
		t.Errorf("Pick = %d %v", i, ok)
	}
	// an explicit year still vetoes an entry of another era
	info = ParseName("Skyscraper (2018)", "Skyscraper", "")
	if !YearVeto(info, media(2, "Skyscraper", "", "TV", 1995)) {
		t.Error("explicit year did not veto")
	}
	// a year that is in the candidate's own title does not
	info = ParseName("Tokyo 2020 [x]", "Tokyo", "")
	if info.Year != 2020 || YearVeto(info, media(3, "Tokyo 2020", "", "TV", 2010)) {
		t.Errorf("year in candidate title vetoed: %+v", info)
	}
}
