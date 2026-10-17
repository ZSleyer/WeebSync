package remote

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"log/slog"
	"net"
	"path"
	"strconv"
	"strings"
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
		got := base64.StdEncoding.EncodeToString(key.Marshal())
		if cfg.InsecureHostKey {
			// security-relevant: connecting without verifying the host key
			slog.Warn("host key accepted unverified", "audit", "insecure-host-key",
				"host", cfg.Host, "key", got)
			return nil
		}
		if got == cfg.HostKey && cfg.HostKey != "" {
			slog.Debug("host key verified", "host", cfg.Host)
			return nil
		}
		reason := "host key mismatch"
		if cfg.HostKey == "" {
			reason = "first contact, key not yet trusted"
		}
		// security-relevant: refused key, UI must prompt accept/reject
		slog.Warn("host key rejected", "audit", "host-key-reject",
			"host", cfg.Host, "reason", reason, "offered", got)
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
	algos := ssh.SupportedAlgorithms()
	sc, chans, reqs, err := ssh.NewClientConn(netConn, addr, &ssh.ClientConfig{
		// only what x/crypto counts as secure, and nothing built on SHA-1 at
		// all: no group14-sha1 key exchange, no hmac-sha1, no ssh-rsa
		// (SHA-1) or DSA host key signatures
		Config: ssh.Config{
			KeyExchanges: noSHA1(algos.KeyExchanges),
			Ciphers:      algos.Ciphers,
			MACs:         noSHA1(algos.MACs),
		},
		User:              cfg.Username,
		Auth:              []ssh.AuthMethod{ssh.Password(cfg.Password)},
		HostKeyCallback:   hostKeyCB,
		HostKeyAlgorithms: hostKeyAlgorithms(cfg.HostKey, algos.HostKeys),
		Timeout:           15 * time.Second,
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

// noSHA1 drops the algorithms built on SHA-1.
func noSHA1(list []string) []string {
	out := make([]string, 0, len(list))
	for _, a := range list {
		if !strings.Contains(a, "sha1") {
			out = append(out, a)
		}
	}
	return out
}

// hostKeyAlgorithms asks the server for the pinned key's own type, as OpenSSH
// does, so a server that also holds a key of another type is not taken for a
// changed one. An RSA key is asked for with SHA-2 signatures only. Before a
// key is pinned, any secure type will do.
func hostKeyAlgorithms(pinned string, secure []string) []string {
	if raw, err := base64.StdEncoding.DecodeString(pinned); err == nil && pinned != "" {
		if pk, err := ssh.ParsePublicKey(raw); err == nil {
			if pk.Type() == ssh.KeyAlgoRSA {
				return []string{ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256}
			}
			return []string{pk.Type()}
		}
	}
	out := noSHA1(secure)
	for i := 0; i < len(out); i++ {
		if out[i] == ssh.KeyAlgoRSA { // SHA-1 signatures; DSA is not in the secure set at all
			out = append(out[:i], out[i+1:]...)
			i--
		}
	}
	return out
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
	// SIZE on an FTP server refuses a directory; do the same, so "has a size"
	// means "is a file" for callers that probe an empty listing
	if fi.IsDir() {
		return 0, fmt.Errorf("%s is a directory", p)
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
