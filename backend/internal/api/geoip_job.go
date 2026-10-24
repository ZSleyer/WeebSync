package api

import (
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/geoip"
	"github.com/ch4d1/weebsync/internal/netguard"
)

// Approximate session locations come from the DB-IP "IP to City Lite"
// database (CC BY 4.0, attribution shown in the UI). It is an opt-in setting:
// switched on, the server downloads the monthly file into its data directory
// and looks addresses up locally, so no address ever leaves the machine.

const (
	geoipJob  = "geoip:update"
	geoipFile = "dbip-city-lite.mmdb"
	// geoipBaseURL serves dbip-city-lite-YYYY-MM.mmdb.gz
	geoipBaseURL = "https://download.db-ip.com/free"
	// a Pi on a slow line needs minutes, not seconds
	geoipTimeout = 15 * time.Minute
	geoipTick    = 24 * time.Hour
	// DB-IP publishes on the 1st at about 06:30 UTC
	geoipPublishHour = 8
)

// A month is ~60 MB compressed and ~127 MB unpacked; the caps leave room to
// grow and stop a hostile or broken answer from filling the disk. Variables so
// a test can shrink them.
var (
	geoipMaxGz  int64 = 120 << 20
	geoipMaxRaw int64 = 400 << 20
)

var errGeoipNotPublished = errors.New("not published")

func (s *Server) geoipDir() string  { return filepath.Join(s.DataDir, "geoip") }
func (s *Server) geoipPath() string { return filepath.Join(s.geoipDir(), geoipFile) }

func (s *Server) geoipEnabled() bool {
	return s.DataDir != "" && truthySetting(db.Setting(s.DB, "geoip_enabled"))
}

// geoipReader is the live database, nil while the feature is off or nothing
// has been downloaded yet.
func (s *Server) geoipReader() *geoip.Reader {
	if !s.geoipEnabled() {
		return nil
	}
	return s.geoip.Load()
}

// geoipPlace resolves an address for display. Private, loopback and
// link-local addresses have no place, and a lookup that fails has none
// either: a location is a nicety, never a reason to fail a request.
func geoipPlace(r *geoip.Reader, ip string) geoip.Place {
	if r == nil {
		return geoip.Place{}
	}
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return geoip.Place{}
	}
	addr = addr.Unmap()
	if addr.IsPrivate() || addr.IsLoopback() || addr.IsLinkLocalUnicast() || addr.IsUnspecified() {
		return geoip.Place{}
	}
	p, err := r.Lookup(addr)
	if err != nil {
		slog.Debug("geoip lookup failed", "err", err)
		return geoip.Place{}
	}
	return p
}

// GeoipLoop keeps the database current: it opens what is on disk, then once a
// day checks whether a newer month is out.
func (s *Server) GeoipLoop(ctx context.Context) {
	s.geoipCheck()
	tick := time.NewTicker(geoipTick)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			s.geoipCheck()
		}
	}
}

// geoipCheck opens the stored file when none is loaded and starts a download
// when the stored one is missing or a month behind. A no-op while disabled.
func (s *Server) geoipCheck() {
	if !s.geoipEnabled() {
		return
	}
	if s.geoip.Load() == nil {
		s.openGeoip()
	}
	if geoipDue(s.geoip.Load(), time.Now().UTC()) {
		s.runJobFor(geoipJob, geoipTimeout+time.Minute, func(ctx context.Context) { s.updateGeoip(ctx, false) })
	}
}

// openGeoip loads the stored database, if there is one.
func (s *Server) openGeoip() {
	r, err := geoip.Open(s.geoipPath())
	switch {
	case errors.Is(err, os.ErrNotExist):
		return
	case err != nil:
		slog.Warn("geoip: stored database unusable", "err", logSafe(err.Error()))
		return
	}
	s.geoip.Store(r)
}

// geoipDue reports whether a newer monthly file should exist by now: the held
// one was built in an earlier month and the current month's has been out since
// the morning of the 1st.
func geoipDue(r *geoip.Reader, now time.Time) bool {
	if r == nil {
		return true
	}
	built := r.BuildTime()
	if built.Year() == now.Year() && built.Month() == now.Month() {
		return false
	}
	return !now.Before(time.Date(now.Year(), now.Month(), 1, geoipPublishHour, 0, 0, 0, time.UTC))
}

// geoipURLs lists the monthly files to try, newest first: the current month
// can still be missing early on the 1st.
func geoipURLs(base string, now time.Time) []string {
	now = now.UTC()
	prev := time.Date(now.Year(), now.Month()-1, 1, 0, 0, 0, 0, time.UTC)
	f := func(t time.Time) string {
		return fmt.Sprintf("%s/dbip-city-lite-%s.mmdb.gz", base, t.Format("2006-01"))
	}
	return []string{f(now), f(prev)}
}

// updateGeoip downloads the newest database and swaps it in. force skips the
// "is a newer month out" reasoning (an admin asked). One log line per failure;
// the next daily tick retries.
func (s *Server) updateGeoip(ctx context.Context, force bool) {
	if !s.geoipEnabled() {
		return
	}
	base := s.geoipBase
	if base == "" {
		base = geoipBaseURL
	}
	now := time.Now().UTC()
	var lastErr error
	for i, url := range geoipURLs(base, now) {
		cur := s.geoip.Load()
		if i > 0 && !force && cur != nil && !geoipDue(cur, time.Date(now.Year(), now.Month()-1, 15, 0, 0, 0, 0, time.UTC)) {
			// the current month is not out yet and we hold the previous one
			return
		}
		r, err := s.downloadGeoip(ctx, url)
		if errors.Is(err, errGeoipNotPublished) {
			lastErr = err
			continue
		}
		if err != nil {
			slog.Warn("geoip: download failed", "err", logSafe(err.Error()))
			return
		}
		if !s.geoipEnabled() {
			// switched off while the file came down: leave nothing behind
			s.dropGeoip()
			return
		}
		// Not closed: a request may be inside Lookup on the old reader right
		// now, and Close would pull the descriptor out from under it. Once
		// nothing holds it, the garbage collector closes the file, and on
		// Linux the replaced file's blocks are freed with the last descriptor.
		s.geoip.Store(r)
		if err := db.SetSetting(s.DB, "geoip_at", time.Now().UTC().Format(time.RFC3339)); err != nil {
			// only the "last updated" stamp; the database itself is in place
			slog.Warn("geoip: stamp not stored", "err", err)
		}
		slog.Info("geoip: database updated", "built", r.BuildTime().Format("2006-01-02"))
		return
	}
	slog.Warn("geoip: no database published", "err", logSafe(lastErr.Error()))
}

// dropGeoip forgets the loaded database and deletes the file, which is what
// switching the feature off means: nothing of it stays on disk.
func (s *Server) dropGeoip() {
	s.geoip.Store(nil)
	if s.DataDir == "" {
		return
	}
	if err := os.Remove(s.geoipPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
		slog.Warn("geoip: stored database not removed", "err", err)
	}
	s.sweepGeoipParts()
}

// sweepGeoipParts removes partial downloads a killed process left behind (a
// failed download cleans up after itself, a SIGKILL or power loss cannot).
// Downloads are serialised by the job key, so none is in flight when this runs
// from the download itself.
func (s *Server) sweepGeoipParts() {
	parts, err := filepath.Glob(filepath.Join(s.geoipDir(), "dbip-*.part"))
	if err != nil {
		return // only a malformed pattern, which this one is not
	}
	for _, p := range parts {
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			slog.Warn("geoip: leftover partial file not removed", "err", err)
		}
	}
}

// downloadGeoip fetches one monthly file, checks that it is a city database
// of a believable age and moves it into place. It returns the opened
// database; on any failure nothing is left in the geoip directory but the
// file that was already there.
func (s *Server) downloadGeoip(ctx context.Context, url string) (r *geoip.Reader, err error) {
	if err := os.MkdirAll(s.geoipDir(), 0o755); err != nil {
		return nil, err
	}
	s.sweepGeoipParts()
	// The partial file lives next to its destination, not in the temp dir:
	// the rename must not cross file systems and the service's sandbox may
	// not allow the temp dir at all.
	part, err := os.CreateTemp(s.geoipDir(), "dbip-*.part")
	if err != nil {
		return nil, err
	}
	renamed := false
	defer func() {
		if err != nil && !renamed {
			if cerr := part.Close(); cerr != nil && !errors.Is(cerr, os.ErrClosed) {
				slog.Debug("geoip: closing partial file", "err", cerr)
			}
			if rerr := os.Remove(part.Name()); rerr != nil {
				slog.Warn("geoip: partial file not removed", "err", rerr)
			}
		}
	}()

	ctx, cancel := context.WithTimeout(ctx, geoipTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "weebsync")
	client := s.geoipClient
	if client == nil {
		client = netguard.PublicClient(geoipTimeout)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return nil, errGeoipNotPublished
	default:
		return nil, fmt.Errorf("download answered %d", resp.StatusCode)
	}

	// a body cut off by the cap shows up as a truncated gzip stream
	gz, err := gzip.NewReader(io.LimitReader(resp.Body, geoipMaxGz))
	if err != nil {
		return nil, fmt.Errorf("not a gzip file: %w", err)
	}
	n, err := io.Copy(part, io.LimitReader(gz, geoipMaxRaw+1))
	if err != nil {
		return nil, fmt.Errorf("unpacking: %w", err)
	}
	if n > geoipMaxRaw {
		return nil, errors.New("unpacked database exceeds the size limit")
	}
	if err := part.Sync(); err != nil {
		return nil, err
	}
	if err := part.Close(); err != nil {
		return nil, err
	}

	// validate before it replaces anything, then reopen at the final path
	// (an open handle would block the rename on some platforms)
	chk, err := geoip.Open(part.Name())
	if err != nil {
		return nil, fmt.Errorf("invalid database: %w", err)
	}
	built, typ := chk.BuildTime(), chk.Type()
	if err := chk.Close(); err != nil {
		return nil, err
	}
	if !strings.Contains(typ, "City") {
		return nil, fmt.Errorf("unexpected database type %q", typ)
	}
	if built.Year() < 2020 || built.After(time.Now().Add(24*time.Hour)) {
		return nil, fmt.Errorf("implausible build date %s", built.Format("2006-01-02"))
	}
	if err := os.Rename(part.Name(), s.geoipPath()); err != nil {
		return nil, err
	}
	renamed = true // the cleanup above has nothing left to remove
	r, oerr := geoip.Open(s.geoipPath())
	if oerr != nil {
		return nil, fmt.Errorf("opening the new database: %w", oerr)
	}
	return r, nil
}
