package remote

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"math"
	"net"
	"path"
	"strconv"
	"time"

	"github.com/ch4d1/weebsync/internal/netguard"
	"github.com/jlaffaye/ftp"
)

type ftpClient struct {
	conn *ftp.ServerConn
}

func dialFTP(cfg Config) (Client, error) {
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
			return netguard.SafeDial(context.Background(), network, host, port, 15*time.Second)
		}),
	}
	if cfg.Protocol == "ftps" {
		opts = append(opts, ftp.DialWithExplicitTLS(&tls.Config{ServerName: cfg.Host}))
	}
	conn, err := ftp.Dial(fmt.Sprintf("%s:%d", cfg.Host, cfg.Port), opts...)
	if err != nil {
		return nil, err
	}
	if err := conn.Login(cfg.Username, cfg.Password); err != nil {
		conn.Quit()
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
