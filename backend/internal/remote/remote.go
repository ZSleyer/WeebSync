// Package remote provides a unified client over SFTP and FTPS.
package remote

import (
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/ch4d1/weebsync/internal/netguard"
)

// HostKeyError aborts an SSH handshake whose host key is not the pinned one.
// Offered lets the caller show its fingerprint and pin the key after explicit
// user approval; Stored is empty on first contact.
type HostKeyError struct {
	Offered string // base64 key the server presented
	Stored  string // base64 pinned key, "" = first contact
}

func (e *HostKeyError) Error() string {
	if e.Stored == "" {
		return "ssh host key not trusted yet - review its fingerprint and accept it"
	}
	return "ssh host key mismatch - server changed or MITM"
}

type Entry struct {
	Name    string    `json:"name"`
	Path    string    `json:"path"`
	Size    int64     `json:"size"`
	IsDir   bool      `json:"isDir"`
	ModTime time.Time `json:"modTime"`
}

type Client interface {
	List(path string) ([]Entry, error)
	// Open returns a reader positioned at offset (for resume).
	Open(path string, offset int64) (io.ReadCloser, error)
	Size(path string) (int64, error)
	Close() error
}

type Config struct {
	Protocol string // sftp | ftps
	Host     string
	Port     int
	Username string
	Password string
	// HostKey is the pinned SSH host key (base64). Anything else the server
	// presents - including first contact while this is empty - fails the
	// dial with *HostKeyError until the user explicitly pins a key.
	HostKey string
	// InsecureHostKey accepts any host key. One-shot CLI tools only,
	// never the server.
	InsecureHostKey bool
	// MaxConns caps concurrent connections to this server (default applied by
	// the caller). For SFTP the pool multiplexes channels over up to this many
	// connections; for FTPS it caps concurrent connections directly.
	MaxConns int
}

// ErrPlainFTP is what a server stored with the retired protocol "ftp" gets
// instead of a connection: USER and PASS would cross the network in clear text.
var ErrPlainFTP = errors.New("plain FTP is not supported (credentials would be sent unencrypted), use protocol ftps")

func Dial(cfg Config) (Client, error) {
	if err := netguard.Allowed(cfg.Host); err != nil {
		return nil, err
	}
	switch cfg.Protocol {
	case "sftp":
		return dialSFTP(cfg)
	case "ftps":
		return dialFTP(cfg)
	case "ftp":
		return nil, ErrPlainFTP
	default:
		return nil, fmt.Errorf("unknown protocol %q", cfg.Protocol)
	}
}
