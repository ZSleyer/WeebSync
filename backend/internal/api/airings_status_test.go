package api

import "testing"

// A calendar slot says whether its episode is on disk and when its file
// reached the server: a sighting where there is one, else the slot plus the
// watch's own upload lag - and only for the track the watch fetches.
func TestMarkAirings(t *testing.T) {
	const h = int64(3600)
	// released at 0h, 100h, 200h, 300h; sighted 2h, 103h, 204h after release
	base := map[int]int64{1: 0, 2: 100 * h, 3: 200 * h, 4: 300 * h}
	seen := map[int]int64{1: 2 * h, 2: 103 * h, 3: 204 * h}
	local := map[int]bool{epKey(1, 1): true, epKey(1, 2): true}
	airings := []Airing{
		{At: 200 * h, Episode: 3},
		{At: 300 * h, Episode: 4},
		{At: 330 * h, Episode: 4, Dub: "de", Est: true},
	}
	markAirings(airings, local, seen, base, "")

	if a := airings[0]; a.Have || a.RemoteAt != 204*h || a.RemoteEst {
		t.Errorf("sighted episode: %+v, want the sighting, not on disk", a)
	}
	// lag is the median of 2h, 3h, 4h
	if a := airings[1]; a.RemoteAt != 303*h || !a.RemoteEst {
		t.Errorf("unsighted episode: %+v, want slot + 3h, estimated", a)
	}
	if a := airings[2]; a.RemoteAt != 0 {
		t.Errorf("dub slot on an original watch: %+v, want no server time", a)
	}

	// on disk: specials (season 0) do not count for the numbering
	marked := []Airing{{Episode: 1}, {Episode: 2}, {Episode: 5}}
	markAirings(marked, map[int]bool{epKey(1, 1): true, epKey(0, 5): true}, nil, nil, "")
	if !marked[0].Have || marked[1].Have || marked[2].Have {
		t.Errorf("have: %+v", marked)
	}
	// nothing sighted yet: no lag, no server time
	if marked[0].RemoteAt != 0 {
		t.Errorf("no sightings: %+v, want no server time", marked[0])
	}
}
