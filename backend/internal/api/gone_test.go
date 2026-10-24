package api

import (
	"errors"
	"fmt"
	"io/fs"
	"net/textproto"
	"testing"
)

// The crawler drops a directory and its whole indexed tree when gone says so.
// A permission refusal or a network error that merely carries the digits 550
// is not a missing directory.
func TestGoneOnlyForMissingDirectories(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"sftp not exist", fmt.Errorf("list: %w", fs.ErrNotExist), true},
		{"ftp 550 no such file", &textproto.Error{Code: 550, Msg: "/anime/X: No such file or directory"}, true},
		{"ftp 550 wrapped", fmt.Errorf("list /anime/X: %w", &textproto.Error{Code: 550, Msg: "Directory not found"}), true},
		{"ftp 550 permission", &textproto.Error{Code: 550, Msg: "Permission denied"}, false},
		{"ftp 550 vsftpd open failure", &textproto.Error{Code: 550, Msg: "Failed to open directory."}, false},
		{"port 55012 in a network error", errors.New("dial tcp 10.0.0.2:55012: i/o timeout"), false},
		{"550 in a path", errors.New("read /anime/Show 5500: connection reset by peer"), false},
		{"ftp 450 no such file", &textproto.Error{Code: 450, Msg: "No such file"}, false},
	}
	for _, c := range cases {
		if got := gone(c.err); got != c.want {
			t.Errorf("%s: gone(%v) = %v, want %v", c.name, c.err, got, c.want)
		}
	}
}
