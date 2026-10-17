package remote

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/textproto"
	"path"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/ch4d1/weebsync/internal/netguard"
	"github.com/jlaffaye/ftp"
)

type ftpClient struct {
	conn *ftp.ServerConn
}

// implicitFTPSPort is the port on which FTPS starts TLS right after the TCP
// connect instead of negotiating it with AUTH TLS.
const implicitFTPSPort = 990

func dialFTP(cfg Config) (Client, error) {
	return dialFTPTLS(cfg, nil, cfg.Port == implicitFTPSPort)
}

// dialFTPTLS dials with explicit roots (nil = system roots) and the TLS mode
// spelled out, so tests need neither port 990 nor a system-trusted certificate.
func dialFTPTLS(cfg Config, roots *x509.CertPool, implicit bool) (Client, error) {
	// FTPS: certificate and host name checked against the system roots (a
	// private CA comes in through SSL_CERT_FILE / SSL_CERT_DIR), nothing
	// older than TLS 1.2, and one session cache for the control and every
	// data connection, which servers that insist on TLS session reuse need
	if cfg.Protocol != "ftps" {
		return nil, ErrPlainFTP
	}
	tlsCfg := &tls.Config{ServerName: cfg.Host, RootCAs: roots, MinVersion: tls.VersionTLS12, ClientSessionCache: tls.NewLRUClientSessionCache(16)}
	var dials atomic.Int32
	opts := []ftp.DialOption{
		ftp.DialWithTimeout(15 * time.Second),
		ftp.DialWithDialFunc(func(network, address string) (net.Conn, error) {
			host, portText, err := net.SplitHostPort(address)
			if err != nil {
				return nil, err
			}
			port, err := strconv.Atoi(portText)
			if err != nil {
				return nil, err
			}
			conn, err := netguard.SafeDial(context.Background(), network, host, port, 15*time.Second)
			// The first dial is the control connection, which the library
			// upgrades itself (AUTH TLS) unless the port is the implicit one,
			// where TLS starts before the greeting. Every later one is a data
			// connection: with a dial func the library hands it back as it
			// came, so after announcing PROT P it is wrapped here, or files
			// and listings would cross the network in clear text. The
			// handshake runs on the first read, as in the library, which
			// some servers need.
			if err != nil || (dials.Add(1) == 1 && !implicit) {
				return conn, err
			}
			return tls.Client(conn, tlsCfg), nil
		}),
	}
	if implicit {
		// Only sets the config (PBSZ/PROT P at login); the dial func above
		// does the handshakes
		opts = append(opts, ftp.DialWithTLS(tlsCfg))
	} else {
		opts = append(opts, ftp.DialWithExplicitTLS(tlsCfg))
	}
	conn, err := ftp.Dial(fmt.Sprintf("%s:%d", cfg.Host, cfg.Port), opts...)
	if err != nil {
		return nil, err
	}
	if err := conn.Login(cfg.Username, cfg.Password); err != nil {
		conn.Quit()
		// 530 is "not logged in": the server refused the credentials
		var perr *textproto.Error
		if errors.As(err, &perr) && perr.Code == ftp.StatusNotLoggedIn {
			return nil, &authError{err}
		}
		return nil, err
	}
	return &ftpClient{conn: conn}, nil
}

func (c *ftpClient) List(dir string) ([]Entry, error) {
	items, err := c.conn.List(dir)
	if err != nil {
		return nil, err
	}
	entries := make([]Entry, 0, len(items))
	for _, it := range items {
		if it.Name == "." || it.Name == ".." {
			continue
		}
		if it.Size > math.MaxInt64 {
			return nil, fmt.Errorf("file too large: %s", it.Name)
		}
		entries = append(entries, Entry{
			Name:    it.Name,
			Path:    path.Join(dir, it.Name),
			Size:    int64(it.Size),
			IsDir:   it.Type == ftp.EntryTypeFolder,
			ModTime: it.Time,
		})
	}
	return entries, nil
}

// ftpReader finishes the data connection transfer on Close.
type ftpReader struct{ resp *ftp.Response }

func (r *ftpReader) Read(p []byte) (int, error) { return r.resp.Read(p) }
func (r *ftpReader) Close() error               { return r.resp.Close() }

func (c *ftpClient) Open(p string, offset int64) (io.ReadCloser, error) {
	if offset < 0 {
		return nil, fmt.Errorf("negative offset")
	}
	resp, err := c.conn.RetrFrom(p, uint64(offset))
	if err != nil {
		return nil, err
	}
	return &ftpReader{resp: resp}, nil
}

func (c *ftpClient) Size(p string) (int64, error) {
	return c.conn.FileSize(p)
}

func (c *ftpClient) Close() error {
	return c.conn.Quit()
}
