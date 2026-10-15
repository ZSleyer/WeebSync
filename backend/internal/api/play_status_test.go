package api

import (
	"math"
	"testing"
)

func TestPlayStatusSegmentProgress(t *testing.T) {
	src := playSource{userID: 1, serverID: 2, path: "/a/x.avi"}
	run := &hlsRun{start: 2, exited: make(chan struct{})}
	// split mid-line, as a pipe hands it over; the first block has no time yet
	for _, chunk := range []string{"out_time_us=N/A\nspeed=N", "/A\nprogress=continue\nout_time_us=7", "500000\nspeed=   0.5x\n"} {
		run.prog.Write([]byte(chunk))
	}
	// the run starts at segment 2 (12 s); segment 3 is 18-24 s, so 7.5 s in
	// is 1.5 s into it and 4.5 s of source are left at half speed
	sess := &hlsSession{key: hlsKey{src: src}, run: run, waiting: map[int]int{3: 1, 4: 1}}
	h := &hlsSessions{all: map[hlsKey]*hlsSession{sess.key: sess}}
	st := PlayStatus{Done: -1, Left: -1, Speed: -1}
	h.progressOf(src, &st)
	if math.Abs(st.Done-0.25) > 1e-9 || math.Abs(st.Left-9) > 1e-9 || st.Speed != 0.5 {
		t.Fatalf("got %+v, want done 0.25, left 9, speed 0.5", st)
	}

	other := PlayStatus{Done: -1, Left: -1, Speed: -1}
	h.progressOf(playSource{userID: 9, serverID: 2, path: "/a/x.avi"}, &other)
	if other.Done != -1 {
		t.Fatalf("another user's file reported %+v", other)
	}
}
