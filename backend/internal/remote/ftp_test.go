package remote

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"fmt"
	"math/big"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeFTP is a minimal FTP control-channel server that records every command
// line it receives. With implicit set it speaks TLS from the first byte.
type fakeFTP struct {
	ln       net.Listener
	mu       sync.Mutex
	cmds     []string
	authTLS  bool // answer AUTH TLS with 234 and upgrade
	implicit bool
	cert     tls.Certificate
	roots    *x509.CertPool
}

func newFakeFTP(t *testing.T, authTLS, implicit bool) *fakeFTP {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "127.0.0.1"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IPAddresses: []net.IP{net.IPv4(127, 0, 0, 1)}, IsCA: true, BasicConstraintsValid: true,
		KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	leaf, _ := x509.ParseCertificate(der)
	f := &fakeFTP{authTLS: authTLS, implicit: implicit, cert: tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, roots: x509.NewCertPool()}
	f.roots.AddCert(leaf)
	f.ln, err = net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.ln.Close() })
	go f.serve()
	return f
}

func (f *fakeFTP) port() int { return f.ln.Addr().(*net.TCPAddr).Port }

func (f *fakeFTP) seen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.cmds...)
}

func (f *fakeFTP) serve() {
	for {
		c, err := f.ln.Accept()
		if err != nil {
			return
		}
		go f.handle(c)
	}
}

func (f *fakeFTP) handle(c net.Conn) {
	defer c.Close()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	cfg := &tls.Config{Certificates: []tls.Certificate{f.cert}}
	if f.implicit {
		c = tls.Server(c, cfg)
	}
	r := bufio.NewReader(c)
	fmt.Fprint(c, "220 ready\r\n")
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimSpace(line)
		f.mu.Lock()
		f.cmds = append(f.cmds, line)
		f.mu.Unlock()
		switch verb, _, _ := strings.Cut(line, " "); strings.ToUpper(verb) {
		case "AUTH":
			if !f.authTLS {
				fmt.Fprint(c, "502 no TLS here\r\n")
				continue
			}
			fmt.Fprint(c, "234 go ahead\r\n")
			c = tls.Server(c, cfg)
			r = bufio.NewReader(c)
		case "USER":
			fmt.Fprint(c, "331 password please\r\n")
		case "PASS":
			fmt.Fprint(c, "230 in\r\n")
		case "FEAT":
			fmt.Fprint(c, "211 no features\r\n")
		case "TYPE", "OPTS", "PBSZ", "PROT":
			fmt.Fprint(c, "200 ok\r\n")
		case "QUIT":
			fmt.Fprint(c, "221 bye\r\n")
			return
		default:
			fmt.Fprint(c, "502 no\r\n")
		}
	}
}

func credentialsSent(cmds []string) bool {
	for _, c := range cmds {
		if v := strings.ToUpper(c); strings.HasPrefix(v, "USER ") || strings.HasPrefix(v, "PASS ") {
			return true
		}
	}
	return false
}

func TestDialPlainFTPRefused(t *testing.T) {
	f := newFakeFTP(t, false, false)
	_, err := Dial(Config{Protocol: "ftp", Host: "127.0.0.1", Port: f.port(), Username: "u", Password: "p"})
	if !errors.Is(err, ErrPlainFTP) || !strings.Contains(err.Error(), "ftps") {
		t.Fatalf("err = %v, want ErrPlainFTP naming ftps", err)
	}
	if got := f.seen(); len(got) != 0 {
		t.Errorf("server saw %v, want nothing", got)
	}
}

func TestFTPSWithoutAuthTLSRefusedBeforeCredentials(t *testing.T) {
	f := newFakeFTP(t, false, false)
	_, err := dialFTPTLS(Config{Protocol: "ftps", Host: "127.0.0.1", Port: f.port(), Username: "u", Password: "secret"}, f.roots, false)
	if err == nil {
		t.Fatal("dial succeeded against a server without AUTH TLS")
	}
	if credentialsSent(f.seen()) {
		t.Errorf("credentials went out: %v", f.seen())
	}
}

func TestFTPSExplicitSendsAuthTLSFirst(t *testing.T) {
	f := newFakeFTP(t, true, false)
	c, err := dialFTPTLS(Config{Protocol: "ftps", Host: "127.0.0.1", Port: f.port(), Username: "u", Password: "p"}, f.roots, false)
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
	got := f.seen()
	if len(got) < 2 || got[0] != "AUTH TLS" || got[1] != "USER u" {
		t.Errorf("commands = %v, want AUTH TLS then USER", got)
	}
}

func TestFTPSImplicitHandshakesFirst(t *testing.T) {
	if implicitFTPSPort != 990 {
		t.Fatal("implicit FTPS port changed")
	}
	f := newFakeFTP(t, false, true)
	c, err := dialFTPTLS(Config{Protocol: "ftps", Host: "127.0.0.1", Port: f.port(), Username: "u", Password: "p"}, f.roots, true)
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
	got := f.seen()
	if len(got) == 0 || got[0] != "USER u" {
		t.Errorf("commands = %v, want a login without AUTH TLS", got)
	}
	// the same server is not reachable as explicit FTPS: the greeting is TLS
	if _, err := dialFTPTLS(Config{Protocol: "ftps", Host: "127.0.0.1", Port: f.port(), Username: "u", Password: "p"}, f.roots, false); err == nil {
		t.Error("explicit dial against an implicit server succeeded")
	}
}
