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

// The browse page words a listing error, it deletes nothing: any FTP 550 is a
// folder that is not there for it (404), however the server phrases it, while
// the crawler's gone() stays strict for the same replies.
func TestBrowseMissingTakesEvery550(t *testing.T) {
	cases := []struct {
		name      string
		err       error
		browse404 bool
		crawlGone bool
	}{
		{"vsftpd", &textproto.Error{Code: 550, Msg: "Failed to open directory."}, true, false},
		{"IIS", fmt.Errorf("list: %w", &textproto.Error{Code: 550, Msg: "The system cannot find the path specified."}), true, false},
		{"proftpd", &textproto.Error{Code: 550, Msg: "/x: No such file or directory"}, true, true},
		{"sftp", fmt.Errorf("list: %w", fs.ErrNotExist), true, true},
		{"timeout", errors.New("dial tcp 10.0.0.2:55012: i/o timeout"), false, false},
		{"ftp 421", &textproto.Error{Code: 421, Msg: "Service not available"}, false, false},
	}
	for _, c := range cases {
		if got := browseMissing(c.err); got != c.browse404 {
			t.Errorf("%s: browseMissing = %v, want %v", c.name, got, c.browse404)
		}
		if got := gone(c.err); got != c.crawlGone {
			t.Errorf("%s: gone = %v, want %v", c.name, got, c.crawlGone)
		}
	}
}
