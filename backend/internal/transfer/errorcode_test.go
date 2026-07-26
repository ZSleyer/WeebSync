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
