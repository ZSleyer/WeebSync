package transfer

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/remote"
)

// OnFinished moves files and writes the database (the replaced copy goes to
// the trash). Shutdown has to wait for it like for the worker that fired it,
// or the process ends halfway through and the database closes under it.
func TestShutdownWaitsForOnFinished(t *testing.T) {
	d := newRetryDB(t)
	root := t.TempDir()
	dial := func(userID, serverID int64) (remote.Client, string, error) {
		return &stubClient{dir: "/x/Show", name: "ep01.mkv", size: 8}, "", nil
	}
	m := NewManager(d, dial, root)
	started, release := make(chan struct{}), make(chan struct{})
	m.OnFinished = func(*Download) {
		close(started)
		<-release
	}
	t.Cleanup(func() { m.Shutdown(t.Context()) })

	target := filepath.Join(root, "Show", "ep01.mkv")
	if _, err := d.Exec(`INSERT INTO downloads (user_id, server_id, remote_path, local_path, size)
		VALUES (1, 1, '/x/Show/ep01.mkv', ?, 8)`, target); err != nil {
		t.Fatal(err)
	}
	m.Wake()
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("OnFinished never ran")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() { m.Shutdown(ctx); close(done) }()
	select {
	case <-done:
		close(release)
		t.Fatal("Shutdown returned while OnFinished was still running")
	case <-time.After(200 * time.Millisecond):
	}
	close(release)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Shutdown did not return after OnFinished ended")
	}
}
