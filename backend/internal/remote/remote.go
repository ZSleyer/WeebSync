// Package remote provides a unified client over SFTP, FTPS and FTP.
package remote

import (
	"fmt"
	"io"
	"time"
)

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
	switch cfg.Protocol {
	case "sftp":
		return dialSFTP(cfg)
	case "ftps", "ftp":
		return dialFTP(cfg)
	default:
		return nil, fmt.Errorf("unknown protocol %q", cfg.Protocol)
	}
}
