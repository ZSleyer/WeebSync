package remote

import (
	"net"
	"time"
)

// idleConn fails a Read or Write that makes no progress for ioTimeout. Each
// call arms its own deadline, so a connection that simply sits unused (an FTP
// control connection during a long transfer) never times out - only one that
// is waited on and stays silent does. Without it a peer that vanished without
// a FIN or RST (NAT timeout, frozen server, pulled cable) blocks the read until
// the kernel gives up on TCP, which takes minutes to hours.
type idleConn struct {
	net.Conn
	timeout time.Duration
}

func withIdleTimeout(c net.Conn) net.Conn {
	return &idleConn{Conn: c, timeout: ioTimeout}
}

func (c *idleConn) Read(p []byte) (int, error) {
	if err := c.Conn.SetReadDeadline(time.Now().Add(c.timeout)); err != nil {
		return 0, err
	}
	return c.Conn.Read(p)
}

func (c *idleConn) Write(p []byte) (int, error) {
	if err := c.Conn.SetWriteDeadline(time.Now().Add(c.timeout)); err != nil {
		return 0, err
	}
	return c.Conn.Write(p)
}
