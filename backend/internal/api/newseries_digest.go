package api

import (
	"strings"
	"time"
)

// newSeriesMaxWait caps how long a burst of finds can hold the notification
// back: the quiet period restarts with every find, so a long sweep would
// otherwise never report. A user on a slower frequency keeps their own
// (longer) period. A var so tests do not have to wait.
var newSeriesMaxWait = 15 * time.Minute

// newSeriesListed is how many titles the summary names before "and N more".
const newSeriesListed = 3

// newSeriesBatch is what one user's sweep has found since the last summary.
type newSeriesBatch struct {
	titles []string
	cover  string // of the first find; the push shows one image
	first  time.Time
	timer  *time.Timer
}

// notifyNewSeries collects a brand-new series for its server's owner and sends
// one notification once finds stop arriving (or the cap is hit). Matching a
// whole collection folder creates hundreds of series within minutes; one push
// per series, all sharing a tag and re-alerting, was a stream of replaced
// notifications. A lone find still goes out alone, after the quiet period.
func (s *Server) notifyNewSeries(userID int64, title, cover string) {
	quiet := s.notifyQuiet(userID)
	s.newSeriesMu.Lock()
	defer s.newSeriesMu.Unlock()
	if s.newSeries == nil {
		s.newSeries = map[int64]*newSeriesBatch{}
	}
	b := s.newSeries[userID]
	if b == nil {
		b = &newSeriesBatch{first: time.Now(), cover: cover}
		s.newSeries[userID] = b
	}
	if title != "" {
		seen := false
		for _, t := range b.titles {
			seen = seen || t == title
		}
		if !seen {
			b.titles = append(b.titles, title)
		}
	}
	if b.timer != nil {
		b.timer.Stop()
	}
	deadline := b.first.Add(max(newSeriesMaxWait, quiet))
	delay := min(quiet, time.Until(deadline))
	b.timer = time.AfterFunc(max(delay, 0), func() { s.spawn(func() { s.flushNewSeries(userID) }) })
}

// flushNewSeries sends the summary for one user and clears their batch.
func (s *Server) flushNewSeries(userID int64) {
	s.newSeriesMu.Lock()
	b := s.newSeries[userID]
	delete(s.newSeries, userID)
	s.newSeriesMu.Unlock()
	if b == nil || len(b.titles) == 0 {
		return
	}
	title, body := newSeriesSummary(s.userLocale(userID), b.titles)
	s.NotifyEvent(userID, "suggestion", title, body, "/suggestions", b.cover)
}

// newSeriesSummary words the notification: the lone title, or a count with the
// first few titles.
func newSeriesSummary(locale string, titles []string) (title, body string) {
	n := len(titles)
	if n == 1 {
		return tr(locale, "notify.newSeries"), titles[0]
	}
	body = strings.Join(titles[:min(n, newSeriesListed)], ", ")
	if n > newSeriesListed {
		body += " " + tr(locale, "notify.andMore", n-newSeriesListed)
	}
	return tr(locale, "notify.newSeriesMany", n), body
}
