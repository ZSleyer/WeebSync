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

// ErrAuthRejected marks a login the server refused: wrong or revoked
// credentials. Repeating it cannot succeed and, against a server with
// intrusion protection, gets the client's address banned.
var ErrAuthRejected = errors.New("authentication rejected")

// authError carries the library's own text (kept for the log and the UI's
// detail line) while matching ErrAuthRejected through errors.Is.
type authError struct{ err error }

func (e *authError) Error() string        { return e.err.Error() }
func (e *authError) Unwrap() error        { return e.err }
func (e *authError) Is(target error) bool { return target == ErrAuthRejected }

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

// ErrBlockedHost marks a host netguard refuses to connect to (cloud metadata,
// link-local and the like). Retrying cannot help; the server's host has to
// change.
var ErrBlockedHost = errors.New("host is a blocked address")

// Connection timeouts, vars so tests can shorten them.
var (
	// ioTimeout: a connection on which nothing arrives (or nothing can be
	// sent) for this long is dead. SSH keepalives keep an idle but healthy
	// connection well inside it.
	ioTimeout = 60 * time.Second
	// handshakeTimeout bounds the whole SSH handshake (banner, key exchange,
	// login), however slowly a peer trickles it.
	handshakeTimeout = 15 * time.Second
	// keepaliveInterval paces the SSH keepalive requests.
	keepaliveInterval = 30 * time.Second
)

// ErrServerBusy marks a connection request that ran out of time waiting for a
// free slot under the server's connection limit: nothing failed, the server
// was in use.
var ErrServerBusy = errors.New("all connections to the server are in use")

// blockedError keeps netguard's text while matching ErrBlockedHost.
type blockedError struct{ err error }

func (e *blockedError) Error() string        { return e.err.Error() }
func (e *blockedError) Unwrap() error        { return e.err }
func (e *blockedError) Is(target error) bool { return target == ErrBlockedHost }

// checkHost runs netguard.Allowed and marks its refusals ErrBlockedHost.
// netguard wraps a failed lookup (%w, transient: retrying may succeed) and
// returns its refusals unwrapped, which is what tells the two apart.
// TODO(orchestrator): a sentinel exported by netguard would make this explicit.
func checkHost(host string) error {
	err := netguard.Allowed(host)
	if err == nil || errors.Unwrap(err) != nil {
		return err
	}
	return &blockedError{err}
}

func Dial(cfg Config) (Client, error) {
	if err := checkHost(cfg.Host); err != nil {
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
