package transfer

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// A real permission failure must classify, not just a hand-built sentinel: the
// production path only ever sees an *fs.PathError from os.OpenFile, and that is
// the value the classification has to recognize.
func TestClassifyErrorRealPermissionDenied(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: mode bits do not deny access")
	}
	dir := filepath.Join(t.TempDir(), "media")
	if err := os.Mkdir(dir, 0o500); err != nil { // r-x: listable, not writable
		t.Fatal(err)
	}
	_, err := os.OpenFile(filepath.Join(dir, "ep.mkv.part"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err == nil {
		t.Fatal("expected the write into a 0o500 directory to fail")
	}
	if got := classifyError(err); got != ErrCodePermissionDenied {
		t.Errorf("classifyError(%v) = %q, want %q", err, got, ErrCodePermissionDenied)
	}
	if RetryableCode(classifyError(err)) {
		t.Error("a permission failure must not be treated as retryable")
	}
}

func TestClassifyError(t *testing.T) {
	// wrapped the way the download path wraps: %w through a PathError
	enospc := fmt.Errorf("write ep.mkv.part: %w", &os.PathError{Op: "write", Path: "/media/ep.mkv.part", Err: syscall.ENOSPC})
	erofs := &os.PathError{Op: "open", Path: "/media/ep.mkv.part", Err: syscall.EROFS}

	cases := []struct {
		name string
		err  error
		want string
	}{
		{"no error", nil, ""},
		{"wrapped ENOSPC", enospc, ErrCodeDiskFull},
		{"EROFS", erofs, ErrCodeReadOnly},
		{"ordinary failure", errors.New("incomplete transfer: 10 of 20 bytes"), ""},
		{"remote failure", fmt.Errorf("dial: %w", errors.New("connection refused")), ""},
	}
	for _, c := range cases {
		if got := classifyError(c.err); got != c.want {
			t.Errorf("%s: classifyError = %q, want %q", c.name, got, c.want)
		}
	}

	// an unclassified failure stays retryable: a dropped connection is worth
	// another attempt, a read-only mount is not
	if !RetryableCode("") {
		t.Error("an unclassified failure must stay retryable")
	}
	if RetryableCode(ErrCodeDiskFull) || RetryableCode(ErrCodeReadOnly) {
		t.Error("disk_full and read_only must not be retryable")
	}
}

// A refused rename must not be filed under "no write permission". The
// directory took every byte of the download; sending the user after a
// permission bit that is already correct is the one answer that cannot help.
func TestClassifyRenameFailure(t *testing.T) {
	link := func(errno syscall.Errno) error {
		return &os.LinkError{Op: "renameat", Old: "Show/ep.mkv.part", New: "Show/ep.mkv", Err: errno}
	}

	cases := []struct {
		name string
		err  error
		want string
	}{
		// mergerfs and friends: the two names live on different branches
		{"EXDEV", link(syscall.EXDEV), ErrCodeRenameFailed},
		// sticky directory, existing episode owned by somebody else
		{"EACCES", link(syscall.EACCES), ErrCodeRenameFailed},
		{"EPERM", link(syscall.EPERM), ErrCodeRenameFailed},
		// the target name is taken by a directory
		{"EISDIR", link(syscall.EISDIR), ErrCodeRenameFailed},
		{"EEXIST", link(syscall.EEXIST), ErrCodeRenameFailed},
		// a second row renamed the same .part away first
		{"ENOENT", link(syscall.ENOENT), ErrCodeRenameFailed},
		// a full or read-only device is the same problem in any phase, and
		// already has an answer of its own
		{"ENOSPC keeps its own code", link(syscall.ENOSPC), ErrCodeDiskFull},
		{"EROFS keeps its own code", link(syscall.EROFS), ErrCodeReadOnly},
		// a media server holding the target open lets go by itself
		{"EBUSY stays unclassified", link(syscall.EBUSY), ""},
		{"ETXTBSY stays unclassified", link(syscall.ETXTBSY), ""},
		// still wrapped, still classified
		{"wrapped", fmt.Errorf("finishing download: %w", link(syscall.EXDEV)), ErrCodeRenameFailed},
	}
	for _, c := range cases {
		if got := classifyError(c.err); got != c.want {
			t.Errorf("%s: classifyError = %q, want %q", c.name, got, c.want)
		}
	}

	// no retry can talk a filesystem into supporting a replace, so the row must
	// end as an error the user is told about instead of failing ten more times
	if RetryableCode(ErrCodeRenameFailed) {
		t.Error("rename_failed must not be treated as retryable")
	}
	if !RetryableCode(classifyError(link(syscall.EBUSY))) {
		t.Error("a busy target must stay retryable")
	}
}

// The probe now performs two operations, and every failure path has to clean up
// after itself: a probe file left in a media directory is one the user finds
// and wonders about.
func TestCheckWritableAtLeavesNothingBehind(t *testing.T) {
	root := t.TempDir()
	local, err := OpenLocal([]string{root}, filepath.Join(root, "Show"))
	if err != nil {
		t.Fatal(err)
	}
	defer local.Close()

	if code, err := CheckWritableAt(local); code != "" || err != nil {
		t.Fatalf("CheckWritableAt = %q, %v; want the directory to pass", code, err)
	}
	entries, err := os.ReadDir(filepath.Join(root, "Show"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		names := make([]string, len(entries))
		for i, e := range entries {
			names[i] = e.Name()
		}
		t.Errorf("probe left %v behind", names)
	}
}

// The probe has to keep naming the failure it always named: a directory that
// refuses the create never gets as far as the rename.
func TestCheckWritableAtUnwritableDirectory(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: mode bits do not deny access")
	}
	root := t.TempDir()
	dir := filepath.Join(root, "Show")
	if err := os.Mkdir(dir, 0o500); err != nil { // r-x: listable, not writable
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(dir, 0o700) })

	local, err := OpenLocal([]string{root}, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer local.Close()
	if code, _ := CheckWritableAt(local); code != ErrCodePermissionDenied {
		t.Errorf("CheckWritableAt = %q, want %q", code, ErrCodePermissionDenied)
	}
}
