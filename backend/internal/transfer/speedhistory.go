package transfer

import (
	"sync"
	"time"
)

// SpeedSpan is how many seconds of download speed the server keeps per user:
// the dashboard's widest chart window, so a fresh page load starts full.
const SpeedSpan = 600

// speedRing holds one user's total rate, one sample per wall-clock second,
// newest at head. A second nobody recorded reads as zero.
type speedRing struct {
	buf  [SpeedSpan]int64
	head int   // index of the newest sample
	last int64 // unix second of the newest sample, 0 while empty
}

func (r *speedRing) push(sec, v int64) {
	if r.last != 0 && sec <= r.last {
		return
	}
	gap := int64(SpeedSpan)
	if r.last != 0 {
		gap = min(sec-r.last, SpeedSpan)
	}
	// skipped seconds were idle: write zeros for them, then the new value
	for i := int64(1); i < gap; i++ {
		r.head = (r.head + 1) % SpeedSpan
		r.buf[r.head] = 0
	}
	r.head = (r.head + 1) % SpeedSpan
	r.buf[r.head] = v
	r.last = sec
}

// samples returns the window ending at now, oldest first, zeros where idle.
func (r *speedRing) samples(now int64) []int64 {
	out := make([]int64, SpeedSpan)
	if r.last == 0 || now-r.last >= SpeedSpan {
		return out
	}
	idle := max(now-r.last, 0) // seconds since the newest sample, all zero
	for i := int64(0); i < SpeedSpan-idle; i++ {
		out[SpeedSpan-1-idle-i] = r.buf[(r.head-int(i)+SpeedSpan)%SpeedSpan]
	}
	return out
}

// speedHistory is the per-user set of rings, fed once a second.
type speedHistory struct {
	mu    sync.Mutex
	rings map[int64]*speedRing
}

func (h *speedHistory) record(sec int64, perUser map[int64]int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.rings == nil {
		h.rings = map[int64]*speedRing{}
	}
	for uid, v := range perUser {
		r := h.rings[uid]
		if r == nil {
			r = &speedRing{}
			h.rings[uid] = r
		}
		r.push(sec, v)
	}
}

func (h *speedHistory) get(uid, now int64) []int64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r := h.rings[uid]; r != nil {
		return r.samples(now)
	}
	return make([]int64, SpeedSpan)
}

// sampleSpeeds records every user's summed rate for the current second. A
// user with nothing running is only recorded once they have a ring, so idle
// users cost nothing until their first download.
func (m *Manager) sampleSpeeds(now time.Time) {
	m.mu.Lock()
	perUser := map[int64]int64{}
	for _, r := range m.active {
		perUser[r.userID] += r.bps
	}
	m.mu.Unlock()
	m.speeds.mu.Lock()
	for uid := range m.speeds.rings {
		if _, ok := perUser[uid]; !ok {
			perUser[uid] = 0
		}
	}
	m.speeds.mu.Unlock()
	m.speeds.record(now.Unix(), perUser)
}

func (m *Manager) speedLoop() {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for now := range tick.C {
		m.mu.Lock()
		stopping := m.stopping
		m.mu.Unlock()
		if stopping {
			return
		}
		m.sampleSpeeds(now)
	}
}

// SpeedHistory returns the user's total download rate over the last
// SpeedSpan seconds, oldest first, and the unix second of its last sample.
func (m *Manager) SpeedHistory(userID int64) ([]int64, int64) {
	now := time.Now().Unix()
	return m.speeds.get(userID, now), now
}
