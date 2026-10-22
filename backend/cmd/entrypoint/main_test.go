package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFileEnv(t *testing.T) {
	f := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(f, []byte("hunter2\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := fileEnv([]string{"A=1", "FILE__WEEBSYNC_SECRET=" + f})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != "A=1" || got[1] != "WEEBSYNC_SECRET=hunter2" {
		t.Fatalf("got %v", got)
	}
	if _, err := fileEnv([]string{"FILE__X=/nonexistent/file"}); err == nil {
		t.Fatal("a missing file must fail, not start without the secret")
	}
}

func TestParse(t *testing.T) {
	if n, err := parseID("PUID", ""); err != nil || n != defaultID {
		t.Fatalf("default: %d %v", n, err)
	}
	if n, err := parseID("PUID", "1000"); err != nil || n != 1000 {
		t.Fatalf("1000: %d %v", n, err)
	}
	for _, bad := range []string{"-1", "abc", "+5", "99999999999"} {
		if _, err := parseID("PUID", bad); err == nil {
			t.Errorf("PUID=%q accepted", bad)
		}
	}
	if n, err := parseUmask("077"); err != nil || n != 0o77 {
		t.Fatalf("umask: %d %v", n, err)
	}
	for _, bad := range []string{"9", "1000", "x", ""} {
		if _, err := parseUmask(bad); err == nil {
			t.Errorf("UMASK=%q accepted", bad)
		}
	}
}

// Without root the ids are the caller's own, so nothing changes; the walk must
// still create a missing dir and succeed on a tree with a download root.
func TestChownTree(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "data")
	if err := os.MkdirAll(filepath.Join(data, "downloads", "show"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "weebsync.db"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	uid, gid := os.Getuid(), os.Getgid()
	if err := chownTree(data, []string{filepath.Join(data, "downloads")}, uid, gid); err != nil {
		t.Fatal(err)
	}
	fresh := filepath.Join(root, "new")
	if err := chownTree(fresh, nil, uid, gid); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatal(err)
	}
}

func TestInMountinfo(t *testing.T) {
	info := "36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 - ext3 /dev/root rw\n" +
		"40 36 0:50 / /config rw,relatime - ext4 /dev/sda1 rw\n"
	if !inMountinfo(info, "/config") || inMountinfo(info, "/data") || inMountinfo(info, "/mnt1") {
		t.Fatal("mount point must match the 5th field exactly")
	}
}
