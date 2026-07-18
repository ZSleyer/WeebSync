package remote

import (
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"path"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

type sftpClient struct {
	ssh  *ssh.Client
	sftp *sftp.Client
}

func dialSFTP(cfg Config) (Client, error) {
	// Trust-on-first-use: accept and persist the key on first connect,
	// require an exact match afterwards.
	// mismatch flags the failure outside the callback because the ssh
	// package does not reliably wrap the callback error for errors.Is.
	var mismatch bool
	hostKeyCB := func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		got := base64.StdEncoding.EncodeToString(key.Marshal())
		if cfg.HostKey == "" {
			if cfg.OnHostKey != nil {
				cfg.OnHostKey(got)
			}
			return nil
		}
		if got != cfg.HostKey {
			mismatch = true
			return fmt.Errorf("ssh host key mismatch for %s - server changed or MITM", hostname)
		}
		return nil
	}
	conn, err := ssh.Dial("tcp", fmt.Sprintf("%s:%d", cfg.Host, cfg.Port), &ssh.ClientConfig{
		User:            cfg.Username,
		Auth:            []ssh.AuthMethod{ssh.Password(cfg.Password)},
		HostKeyCallback: hostKeyCB,
		Timeout:         15 * time.Second,
	})
	if err != nil {
		if mismatch {
			return nil, fmt.Errorf("%w for %s:%d", ErrHostKeyMismatch, cfg.Host, cfg.Port)
		}
		return nil, err
	}
	sc, err := sftp.NewClient(conn)
	if err != nil {
		conn.Close()
		return nil, err
	}
	return &sftpClient{ssh: conn, sftp: sc}, nil
}

func (c *sftpClient) List(dir string) ([]Entry, error) {
	infos, err := c.sftp.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	entries := make([]Entry, 0, len(infos))
	for _, fi := range infos {
		entries = append(entries, Entry{
			Name:    fi.Name(),
			Path:    path.Join(dir, fi.Name()),
			Size:    fi.Size(),
			IsDir:   fi.IsDir(),
			ModTime: fi.ModTime(),
		})
	}
	return entries, nil
}

func (c *sftpClient) Open(p string, offset int64) (io.ReadCloser, error) {
	f, err := c.sftp.Open(p)
	if err != nil {
		return nil, err
	}
	if offset > 0 {
		if _, err := f.Seek(offset, io.SeekStart); err != nil {
			f.Close()
			return nil, err
		}
	}
	return f, nil
}

func (c *sftpClient) Size(p string) (int64, error) {
	fi, err := c.sftp.Stat(p)
	if err != nil {
		return 0, err
	}
	return fi.Size(), nil
}

func (c *sftpClient) Close() error {
	c.sftp.Close()
	return c.ssh.Close()
}
