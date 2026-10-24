package transfer

import (
	"encoding/json"
	"testing"
)

// A slow page that has not read its event stream for a while has a full
// buffer, and progress events for it are dropped - harmless, the next one
// replaces them. A download's end is not replaced by anything: dropped, the
// page showed the row running until its next poll. The end has to arrive even
// when the buffer is full, at the cost of an older progress event.
func TestFinalEventSurvivesFullSubscriber(t *testing.T) {
	m := NewManager(newRetryDB(t), nil, t.TempDir())
	t.Cleanup(func() { m.Shutdown(t.Context()) })
	ch, unsubscribe := m.Subscribe()
	defer unsubscribe()

	for i := range cap(ch) {
		m.publish(&Download{ID: int64(i + 1), Status: "running"})
	}
	m.publish(&Download{ID: 99, Status: "done"})

	found := false
	for len(ch) > 0 {
		var d Download
		if err := json.Unmarshal([]byte(<-ch), &d); err != nil {
			t.Fatal(err)
		}
		if d.ID == 99 && d.Status == "done" {
			found = true
		}
	}
	if !found {
		t.Error("the done event was dropped on a full subscriber buffer")
	}
}
