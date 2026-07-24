package remote

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"path"
	"strconv"
	"time"

	"github.com/ch4d1/weebsync/internal/netguard"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

type sftpClient struct {
	// ssh is nil for a pooled channel (SFTPChannel): Close then shuts only
	// the sftp channel, leaving the shared connection open for reuse.
	ssh  *ssh.Client
	sftp *sftp.Client
}

// DialSSH opens the SSH transport (TCP + handshake + auth, TOFU host key)
// without an SFTP subsystem, so the connection pool can multiplex several
// SFTP channels over one connection.
func DialSSH(cfg Config) (*ssh.Client, error) {
	return dialSSH(cfg)
}

// SFTPChannel opens one more SFTP channel over an existing SSH connection.
// The returned Client's Close shuts only this channel, not the connection.
func SFTPChannel(conn *ssh.Client) (Client, error) {
	sc, err := sftp.NewClient(conn)
	if err != nil {
		return nil, err
	}
	return &sftpClient{sftp: sc}, nil
}

func dialSFTP(cfg Config) (Client, error) {
	conn, err := dialSSH(cfg)
	if err != nil {
		return nil, err
	}
	sc, err := sftp.NewClient(conn)
	if err != nil {
		conn.Close()
		return nil, err
	}
	return &sftpClient{ssh: conn, sftp: sc}, nil
}

func dialSSH(cfg Config) (*ssh.Client, error) {
	// Only the exact pinned key passes; anything else - including first
	// contact - aborts the handshake and reports the offered key so the UI
	// can show its fingerprint and ask the user to accept or reject it.
	// hkErr is captured outside the callback because the ssh package does
	// not reliably wrap the callback error for errors.As.
	var hkErr *HostKeyError
	hostKeyCB := func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		if cfg.InsecureHostKey {
			return nil
		}
		got := base64.StdEncoding.EncodeToString(key.Marshal())
		if got == cfg.HostKey && cfg.HostKey != "" {
			return nil
		}
		hkErr = &HostKeyError{Offered: got, Stored: cfg.HostKey}
		return hkErr
	}
	// Resolve once and dial the verified IP through netguard, then run the SSH
	// handshake over that connection - a plain ssh.Dial re-resolves the host and
	// would reopen the DNS-rebinding TOCTOU that netguard.Allowed alone leaves.
	netConn, err := netguard.SafeDial(context.Background(), "tcp", cfg.Host, cfg.Port, 15*time.Second)
	if err != nil {
		return nil, err
	}
	addr := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	sc, chans, reqs, err := ssh.NewClientConn(netConn, addr, &ssh.ClientConfig{
		User:            cfg.Username,
		Auth:            []ssh.AuthMethod{ssh.Password(cfg.Password)},
		HostKeyCallback: hostKeyCB,
		Timeout:         15 * time.Second,
	})
	if err != nil {
		netConn.Close()
		if hkErr != nil {
			return nil, hkErr
		}
		return nil, err
	}
	return ssh.NewClient(sc, chans, reqs), nil
}

// KeyLabel renders a host key (base64 wire format) as "algo SHA256:..." for
// display, e.g. "ssh-ed25519 SHA256:pnPn3SxYc...". Doubles as validation for
// keys echoed back by the trust endpoint.
func KeyLabel(b64 string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", fmt.Errorf("invalid host key: %w", err)
	}
	pk, err := ssh.ParsePublicKey(raw)
	if err != nil {
		return "", fmt.Errorf("invalid host key: %w", err)
	}
	return pk.Type() + " " + ssh.FingerprintSHA256(pk), nil
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
	err := c.sftp.Close()
	if c.ssh != nil { // nil for a pooled channel: keep the connection open
		c.ssh.Close()
	}
	return err
}
