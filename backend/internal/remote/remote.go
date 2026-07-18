// Package remote provides a unified client over SFTP, FTPS and FTP.
package remote

import (
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/ch4d1/weebsync/internal/netguard"
)

// ErrHostKeyMismatch marks a failed SSH handshake caused by a host key that
// differs from the learned TOFU key. Callers can offer a key reset.
var ErrHostKeyMismatch = errors.New("ssh host key mismatch - server changed or MITM")

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
	Protocol string // sftp | ftps | ftp
	Host     string
	Port     int
	Username string
	Password string
	// HostKey is the known SSH host key (base64, TOFU). Empty = first
	// connect, learned key is written back via the OnHostKey callback.
	HostKey   string
	OnHostKey func(key string) // called when a new host key is learned
}

func Dial(cfg Config) (Client, error) {
	if err := netguard.Allowed(cfg.Host); err != nil {
		return nil, err
	}
	switch cfg.Protocol {
	case "sftp":
		return dialSFTP(cfg)
	case "ftps", "ftp":
		return dialFTP(cfg)
	default:
		return nil, fmt.Errorf("unknown protocol %q", cfg.Protocol)
	}
}
