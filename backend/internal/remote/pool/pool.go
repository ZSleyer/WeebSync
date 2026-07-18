// Package pool multiplexes and caps remote connections per server. For SFTP it
// opens several SFTP channels over a shared SSH connection (one TCP + handshake
// carries browser, index and downloads together), up to a configurable number
// of connections. For FTP/FTPS - which cannot multiplex - it caps concurrent
// connections instead. Downloads and interactive use take priority; the index
// crawler (low priority) waits while capacity is scarce.
package pool

import (
	"context"
	"errors"
	"strings"
	"sync"

	"github.com/ch4d1/weebsync/internal/remote"
	"golang.org/x/crypto/ssh"
)

// errEvicted is returned when a connection is evicted (server reconfigured or
// deleted) while its lease was still being dialed; the caller should retry.
var errEvicted = errors.New("connection pool: server reconfigured during dial")

// Prio orders lease requests: high (downloads, browser, catalog, watch checks)
// wins contested capacity; low (index crawler) waits so it never starves them.
type Prio int

const (
	PriHigh Prio = iota
	PriLow
)

// defaultChannelsPerConn is the SFTP channel budget per connection, kept under
// the common sshd MaxSessions default of 10. Lowered adaptively per server when
// the server rejects a channel earlier than that.
const defaultChannelsPerConn = 8

// Pool owns the per-server connection state.
type Pool struct {
	mu      sync.Mutex
	servers map[int64]*serverPool
}

func New() *Pool { return &Pool{servers: map[int64]*serverPool{}} }

type sshConn struct {
	ssh    *ssh.Client
	open   int  // channels currently leased on this connection
	closed bool // dropped from the pool (dead / evicted)
}

type serverPool struct {
	mu       sync.Mutex
	ready    chan struct{} // closed+replaced to wake waiters (ctx-aware broadcast)
	proto    string
	maxConns int
	chanCap  int // learned SFTP channels per connection (>=1, <= defaultChannelsPerConn)

	conns    []*sshConn // SFTP connections
	ftpInUse int        // FTP: open connections
	hiWait   int        // high-priority waiters (low yields to them)
}

func (p *Pool) get(serverID int64, proto string, maxConns int) *serverPool {
	p.mu.Lock()
	defer p.mu.Unlock()
	sp := p.servers[serverID]
	if sp == nil {
		sp = &serverPool{ready: make(chan struct{}), proto: proto, chanCap: defaultChannelsPerConn}
		p.servers[serverID] = sp
	}
	return sp
}

// Lease returns a remote.Client whose Close releases the channel/slot back to
// the pool (it does not tear down a shared SSH connection). cfg supplies the
// credentials and MaxConns; they are only used when a new connection is dialed.
func (p *Pool) Lease(ctx context.Context, serverID int64, cfg remote.Config, prio Prio) (remote.Client, error) {
	maxConns := cfg.MaxConns
	if maxConns < 1 {
		maxConns = 3
	}
	sp := p.get(serverID, cfg.Protocol, maxConns)
	if cfg.Protocol == "sftp" {
		return sp.leaseSFTP(ctx, cfg, prio, maxConns)
	}
	return sp.leaseFTP(ctx, cfg, prio, maxConns)
}

// Evict closes and forgets all connections for a server (credentials or the
// connection limit changed, or the server was deleted).
func (p *Pool) Evict(serverID int64) {
	p.mu.Lock()
	sp := p.servers[serverID]
	delete(p.servers, serverID)
	p.mu.Unlock()
	if sp != nil {
		sp.closeAll()
	}
}

// Close tears down every pooled connection.
func (p *Pool) Close() {
	p.mu.Lock()
	all := p.servers
	p.servers = map[int64]*serverPool{}
	p.mu.Unlock()
	for _, sp := range all {
		sp.closeAll()
	}
}

func (sp *serverPool) closeAll() {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	for _, c := range sp.conns {
		if !c.closed {
			c.closed = true
			if c.ssh != nil { // nil while a connection is mid-dial
				c.ssh.Close()
			}
		}
	}
	sp.conns = nil
	sp.wake()
}

// wake releases all current waiters so they re-check the condition.
func (sp *serverPool) wake() {
	close(sp.ready)
	sp.ready = make(chan struct{})
}

// reserve is the number of slots low priority must leave free for high; none
// when total capacity is a single slot (else the crawler could never run).
func reserve(prio Prio, totalCap int) int {
	if prio == PriHigh || totalCap <= 1 {
		return 0
	}
	return 1
}

// ── SFTP: multiplex channels over shared connections ────────────────────────

func (sp *serverPool) freeSFTP() int {
	free := (sp.maxConns - len(sp.conns)) * sp.chanCap // capacity of not-yet-dialed conns
	for _, c := range sp.conns {
		if !c.closed {
			free += sp.chanCap - c.open
		}
	}
	return free
}

func (sp *serverPool) connWithRoom() *sshConn {
	for _, c := range sp.conns {
		if !c.closed && c.ssh != nil && c.open < sp.chanCap {
			return c
		}
	}
	return nil
}

func (sp *serverPool) canTakeSFTP(prio Prio) bool {
	if prio == PriLow && sp.hiWait > 0 {
		return false
	}
	return sp.freeSFTP() > reserve(prio, sp.maxConns*sp.chanCap)
}

func (sp *serverPool) leaseSFTP(ctx context.Context, cfg remote.Config, prio Prio, maxConns int) (remote.Client, error) {
	for {
		sp.mu.Lock()
		sp.maxConns = maxConns
		if sp.canTakeSFTP(prio) {
			if c := sp.connWithRoom(); c != nil {
				c.open++
				sp.mu.Unlock()
				ch, err := remote.SFTPChannel(c.ssh)
				if err != nil {
					sp.onChannelErr(c, err)
					continue
				}
				return sp.wrap(ch, c), nil
			}
			// no room on an existing connection: dial a new one, but only if
			// there is room for another connection under the cap. Guarding on
			// len here (not just the freeSFTP estimate) stops concurrent leases
			// from each dialing past maxConns while an earlier dial is in flight
			// (a mid-dial conn has ssh==nil, so connWithRoom skips it).
			if len(sp.conns) < sp.maxConns {
				c := &sshConn{open: 1}
				sp.conns = append(sp.conns, c)
				sp.mu.Unlock()
				conn, err := remote.DialSSH(cfg)
				if err != nil {
					sp.mu.Lock()
					sp.dropLocked(c)
					sp.wake()
					sp.mu.Unlock()
					return nil, err
				}
				ch, err := remote.SFTPChannel(conn)
				if err != nil {
					conn.Close()
					sp.mu.Lock()
					sp.dropLocked(c)
					sp.wake()
					sp.mu.Unlock()
					return nil, err
				}
				sp.mu.Lock()
				if c.closed {
					// evicted mid-dial (server reconfigured/deleted): don't hand
					// out a lease on a slot that is no longer in the pool, or the
					// connection would leak. Surface a retryable error.
					sp.mu.Unlock()
					ch.Close()
					conn.Close()
					return nil, errEvicted
				}
				c.ssh = conn
				sp.wake() // the new connection has spare channels: wake waiters
				sp.mu.Unlock()
				return sp.wrap(ch, c), nil
			}
			// at the connection cap with all channels busy: fall through to wait
		}
		ready := sp.ready
		if prio == PriHigh {
			sp.hiWait++
		}
		sp.mu.Unlock()
		select {
		case <-ctx.Done():
			sp.undoWait(prio)
			return nil, ctx.Err()
		case <-ready:
			sp.undoWait(prio)
		}
	}
}

// onChannelErr handles a failed SFTPChannel on an existing connection: a
// session-limit rejection lowers the learned channel cap (the server is
// stricter than configured); any other error means the connection is dead.
func (sp *serverPool) onChannelErr(c *sshConn, err error) {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	c.open-- // roll back the reservation
	if isSessionLimit(err) {
		if working := c.open; working >= 1 && working < sp.chanCap {
			sp.chanCap = working // learn the server's real limit, server-wide
		} else if c.open == 0 {
			sp.dropLocked(c) // can't even open one channel here: drop it
		}
	} else {
		sp.dropLocked(c) // dead connection
	}
	sp.wake()
}

// ── FTP/FTPS: cap concurrent connections (no multiplexing) ──────────────────

func (sp *serverPool) leaseFTP(ctx context.Context, cfg remote.Config, prio Prio, maxConns int) (remote.Client, error) {
	for {
		sp.mu.Lock()
		sp.maxConns = maxConns
		free := sp.maxConns - sp.ftpInUse
		ok := free > reserve(prio, sp.maxConns) && (prio == PriHigh || sp.hiWait == 0)
		if ok {
			sp.ftpInUse++
			sp.mu.Unlock()
			cl, err := remote.Dial(cfg)
			if err != nil {
				sp.mu.Lock()
				sp.ftpInUse--
				sp.wake()
				sp.mu.Unlock()
				return nil, err
			}
			return &lease{Client: cl, release: func() {
				sp.mu.Lock()
				sp.ftpInUse--
				sp.wake()
				sp.mu.Unlock()
			}}, nil
		}
		ready := sp.ready
		if prio == PriHigh {
			sp.hiWait++
		}
		sp.mu.Unlock()
		select {
		case <-ctx.Done():
			sp.undoWait(prio)
			return nil, ctx.Err()
		case <-ready:
			sp.undoWait(prio)
		}
	}
}

// ── shared helpers ──────────────────────────────────────────────────────────

func (sp *serverPool) undoWait(prio Prio) {
	if prio != PriHigh {
		return
	}
	sp.mu.Lock()
	sp.hiWait--
	sp.mu.Unlock()
}

// dropLocked removes a connection from the pool and closes it. Caller holds mu.
func (sp *serverPool) dropLocked(c *sshConn) {
	if c.closed {
		return
	}
	c.closed = true
	if c.ssh != nil {
		c.ssh.Close()
	}
	for i, x := range sp.conns {
		if x == c {
			sp.conns = append(sp.conns[:i], sp.conns[i+1:]...)
			break
		}
	}
}

// wrap returns a Client that releases its SFTP channel on Close: decrement the
// connection's channel count and, if it fell idle while a spare exists, reap it.
func (sp *serverPool) wrap(ch remote.Client, c *sshConn) remote.Client {
	return &lease{Client: ch, release: func() {
		sp.mu.Lock()
		c.open--
		if c.open <= 0 && !c.closed && len(sp.conns) > 1 {
			sp.dropLocked(c) // keep at least one warm connection, reap the rest
		}
		sp.wake()
		sp.mu.Unlock()
	}}
}

type lease struct {
	remote.Client
	release func()
	once    sync.Once
}

func (l *lease) Close() error {
	err := l.Client.Close()
	l.once.Do(l.release)
	return err
}

// isSessionLimit reports whether err is the server refusing a new channel
// because its per-connection session limit is reached (MaxSessions), as opposed
// to a dead connection.
func isSessionLimit(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "administratively prohibited") ||
		strings.Contains(s, "open failed") ||
		strings.Contains(s, "maxsessions") ||
		strings.Contains(s, "rejected")
}
