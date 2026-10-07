package transfer

import "testing"

func TestSpeedRingFillsGapsAndAges(t *testing.T) {
	var r speedRing
	r.push(100, 10)
	r.push(101, 20)
	r.push(104, 40) // 102 and 103 were idle
	r.push(104, 99) // same second again: ignored

	got := r.samples(104)
	if len(got) != SpeedSpan {
		t.Fatalf("len = %d, want %d", len(got), SpeedSpan)
	}
	tail := got[SpeedSpan-5:]
	want := []int64{10, 20, 0, 0, 40}
	for i := range want {
		if tail[i] != want[i] {
			t.Fatalf("tail = %v, want %v", tail, want)
		}
	}

	// two quiet seconds later the window has moved on and ends in zeros
	tail = r.samples(106)[SpeedSpan-4:]
	if tail[0] != 0 || tail[1] != 40 || tail[2] != 0 || tail[3] != 0 {
		t.Fatalf("aged tail = %v", tail)
	}

	// a gap longer than the window clears it
	r.push(104+SpeedSpan+5, 7)
	all := r.samples(104 + SpeedSpan + 5)
	for i, v := range all[:SpeedSpan-1] {
		if v != 0 {
			t.Fatalf("sample %d = %d after a long gap, want 0", i, v)
		}
	}
	if all[SpeedSpan-1] != 7 {
		t.Fatalf("newest = %d, want 7", all[SpeedSpan-1])
	}
}

func TestSpeedRingWraps(t *testing.T) {
	var r speedRing
	for s := int64(1); s <= SpeedSpan+10; s++ {
		r.push(s, s)
	}
	got := r.samples(SpeedSpan + 10)
	if got[0] != 11 || got[SpeedSpan-1] != SpeedSpan+10 {
		t.Fatalf("ends = %d..%d, want 11..%d", got[0], got[SpeedSpan-1], SpeedSpan+10)
	}
}

func TestSpeedHistoryPerUser(t *testing.T) {
	var h speedHistory
	h.record(50, map[int64]int64{1: 5, 2: 8})
	if got := h.get(1, 50); got[SpeedSpan-1] != 5 {
		t.Fatalf("user 1 newest = %d", got[SpeedSpan-1])
	}
	if got := h.get(2, 50); got[SpeedSpan-1] != 8 {
		t.Fatalf("user 2 newest = %d", got[SpeedSpan-1])
	}
	if got := h.get(3, 50); len(got) != SpeedSpan || got[SpeedSpan-1] != 0 {
		t.Fatalf("unknown user should read all zeros")
	}
}
