package main

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestFileEnv(t *testing.T) {
	f := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(f, []byte("hunter2\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := fileEnv([]string{"A=1", "WEEBSYNC_SECRET=old", "FILE__WEEBSYNC_SECRET=" + f})
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(got)
	want := []string{"A=1", "WEEBSYNC_SECRET=hunter2"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v, want %v (the file wins, FILE__ itself is gone)", got, want)
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
	for _, bad := range []string{"-1", "abc", "+5", "99999999999", "0", "00"} {
		if _, err := parseID("PUID", bad); err == nil {
			t.Errorf("PUID=%q accepted", bad)
		}
	}
	if _, err := parseID("PGID", "0"); err == nil || !strings.Contains(err.Error(), "PGID=0") {
		t.Errorf("PGID=0 must be refused with a clear message, got %v", err)
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

func TestParseMountinfo(t *testing.T) {
	info := "36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 - ext3 /dev/root rw\n" +
		"40 36 0:50 / /config rw,relatime - ext4 /dev/sda1 rw\n" +
		"41 40 0:50 /media /config/my\\040media rw - ext4 /dev/sda1 rw\n" +
		"\n"
	got := parseMountinfo(info)
	want := []string{"/mnt2", "/config", "/config/my media"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func recorder(ops *[]string) func(string, int, int) error {
	return func(p string, _, _ int) error { *ops = append(*ops, p); return nil }
}

// The tree: state files, a download root with media, a bind mount on the same
// file system (so st_dev is no help), a symlink out of the tree. The ids asked
// for differ from the files' owner, so every visited entry is chowned.
func fixture(t *testing.T) (data string) {
	t.Helper()
	root := t.TempDir()
	outside := filepath.Join(root, "outside")
	data = filepath.Join(root, "data")
	for _, d := range []string{
		outside,
		filepath.Join(data, "sub"),
		filepath.Join(data, "downloads", "show"),
		filepath.Join(data, "media", "show"),
	} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{
		filepath.Join(data, "weebsync.db"),
		filepath.Join(data, "sub", "x"),
		filepath.Join(data, "downloads", "show", "ep.mkv"),
		filepath.Join(data, "media", "show", "ep1.mkv"),
		filepath.Join(outside, "victim"),
	} {
		if err := os.WriteFile(f, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(outside, filepath.Join(data, "link")); err != nil {
		t.Fatal(err)
	}
	return data
}

func TestChownTree(t *testing.T) {
	data := fixture(t)
	var ops []string
	uid, gid := os.Getuid()+1, os.Getgid()+1
	err := chownTree(data, []string{filepath.Join(data, "downloads")},
		[]string{filepath.Join(data, "media"), "/unrelated"}, true, uid, gid, recorder(&ops))
	if err != nil {
		t.Fatal(err)
	}
	real, _ := filepath.EvalSymlinks(data)
	want := []string{
		real,
		filepath.Join(real, "downloads"), // the top only
		filepath.Join(real, "link"),      // the link itself
		filepath.Join(real, "sub"),
		filepath.Join(real, "sub", "x"),
		filepath.Join(real, "weebsync.db"),
	}
	slices.Sort(ops)
	if !slices.Equal(ops, want) {
		t.Fatalf("chowned\n%q\nwant\n%q", ops, want)
	}
}

func TestChownTreeMountsUnknown(t *testing.T) {
	data := fixture(t)
	var ops []string
	if err := chownTree(data, nil, nil, false, os.Getuid()+1, os.Getgid()+1, recorder(&ops)); err != nil {
		t.Fatal(err)
	}
	real, _ := filepath.EvalSymlinks(data)
	if len(ops) != 1 || ops[0] != real {
		t.Fatalf("without a mount list only the top may change, got %q", ops)
	}
}

func TestChownTreeCreatesDir(t *testing.T) {
	fresh := filepath.Join(t.TempDir(), "new")
	var ops []string
	if err := chownTree(fresh, nil, nil, true, 1, 1, recorder(&ops)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatal(err)
	}
}
