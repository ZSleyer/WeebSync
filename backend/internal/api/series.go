package api

import (
	"log/slog"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/match"
	"github.com/ch4d1/weebsync/internal/rename"
)

// persistMatch stores a folder's provider match and keeps the derived tables in
// step: the canonical series bundle (series/series_provider) and the folder's
// quality variant. Every matcher writes through here so a match can never land
// without being bundled. media_id 0 (explicit no-match) only writes the row.
// A match that was not stored is reported and goes no further; the background
// matchers try again on a later pass, a user's own pick gets the error.
func (s *Server) persistMatch(serverID int64, folder string, mediaID int, manual bool, source string) error {
	m := 0
	if manual {
		m = 1
	}
	var oldID int
	var oldSource string
	s.DB.QueryRow(`SELECT media_id, source FROM catalog_matches WHERE server_id = ? AND folder = ?`,
		serverID, folder).Scan(&oldID, &oldSource)
	if _, err := s.DB.Exec(`INSERT OR REPLACE INTO catalog_matches (server_id, folder, media_id, manual, source) VALUES (?, ?, ?, ?, ?)`,
		serverID, folder, mediaID, m, source); err != nil {
		slog.Warn("match not stored", "server", serverID, "folder", logSafe(folder), "err", err)
		return err
	}
	var left int64
	if oldID != 0 && (oldID != mediaID || oldSource != source) {
		left = s.detachProvider(oldSource, oldID)
	}
	if mediaID == 0 {
		return nil
	}
	created, title := s.linkSeries(source, mediaID)
	if left != 0 {
		s.retitleSeries(left, source, mediaID)
	}
	s.settleSeries(source, mediaID)
	s.refreshVariant(serverID, folder)
	// a brand-new series (first time this show is seen anywhere) is a
	// suggestion worth telling the server's owner about. Backfill calls
	// linkSeries directly, not persistMatch, so it never fires this. server 0
	// (local) has no owner row - skip.
	if created && !manual && serverID != 0 {
		var owner int64
		if s.DB.QueryRow(`SELECT user_id FROM servers WHERE id = ?`, serverID).Scan(&owner) == nil && owner != 0 {
			s.NotifyEvent(owner, "suggestion", tr(s.userLocale(owner), "notify.newSeries"), title, "/suggestions")
		}
	}
	return nil
}

// linkSeries attaches a (source, media_id) provider hit to a canonical series,
// creating the series when none matches. Two things decide, in this order:
//
//   - the show-level id (showIdentity): an AniList work that the Fribb mapping
//     files as season N of a TVDB/TMDB show joins that show. This is what makes
//     a long-running show one entry - the cours name themselves differently
//     ("Stardust Crusaders"), so the title fold alone split JoJo into five.
//   - the fold key of the base title, season markers stripped, for everything
//     the mapping does not carry. The year gate keeps remakes apart ("Fruits
//     Basket" 2001 vs 2019).
//
// ponytail: keying by StripMarkers+FoldKey will NOT join AniList romaji to a
// TMDB english title that differs. The Plex-GUID reconcile pass (reconcilePlex)
// is the cross-provider join for shows that share a TVDB/TMDB id - upgrade here
// only if that proves insufficient.
// linkSeries returns (created, title): created is true only when a brand-new
// series row was inserted (not when the provider joined an existing series or
// was already bundled), so the caller can raise a "new series" notification.
func (s *Server) linkSeries(source string, mediaID int) (created bool, title string) {
	if source == mangaSource {
		return false, "" // series bundle what is watched; a manga is read
	}
	media, _ := s.sourceMedia(source, mediaID)
	if media == nil {
		return false, "" // metadata not cached yet; a later match/sweep links it
	}
	title = media.Title.Romaji
	if title == "" {
		title = media.Title.English
	}
	if title == "" {
		return false, ""
	}
	key := seriesKey(source, title)
	if key == "" {
		return false, ""
	}
	year := media.SeasonYear

	s.seriesMu.Lock()
	defer s.seriesMu.Unlock()

	// every lookup below decides whether a series is created: one that failed
	// must stop here, or a read error passes for "not there yet" and the show
	// is bundled twice. A later match or sweep links it.
	var have int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM series_provider WHERE source = ? AND media_id = ?`,
		source, mediaID).Scan(&have); err != nil || have > 0 {
		return false, title // already bundled, or unknown
	}

	// a season of a known show joins that show, whatever it calls itself. The
	// show-level id decides before the title fold does, or "Stardust Crusaders"
	// would start an entry of its own next to "JoJo no Kimyou na Bouken".
	ref, isSeason := showRef{}, false
	if source == "anilist" {
		ref, isSeason = s.showIdentity(mediaID)
	}
	var seriesID int64
	if isSeason {
		seriesID = s.seriesByProvider(ref.Source, ref.MediaID)
	}
	if seriesID == 0 {
		var err error
		if seriesID, err = s.findSeries(key, year, false); err != nil {
			slog.Warn("series lookup failed", "title", logSafe(title), "err", err)
			return false, title
		}
		// an anime matched on TVDB or TMDB still joins its AniList bundle,
		// which is keyed by the romaji fold; only anime are looked up so,
		// or "Rooster" would find "Roster"
		if fk := match.FoldKey(match.StripMarkers(title)); seriesID == 0 && source != "anilist" && fk != key {
			if seriesID, err = s.findSeries(fk, year, true); err != nil {
				return false, title
			}
		}
	}
	if seriesID == 0 {
		res, err := s.DB.Exec(`INSERT INTO series (key, title, year) VALUES (?, ?, ?)`, key, title, year)
		if err != nil {
			return false, title
		}
		seriesID, _ = res.LastInsertId()
		created = true
	}
	s.DB.Exec(`INSERT OR IGNORE INTO series_provider (source, media_id, series_id) VALUES (?, ?, ?)`,
		source, mediaID, seriesID)
	if isSeason {
		s.claimShow(seriesID, ref, title, year)
		if !created {
			s.refreshShowTitle(seriesID)
		}
	}
	if created {
		slog.Debug("series created", "seriesId", seriesID, "title", logSafe(title), "year", year, "source", logSafe(source), "media", mediaID)
	} else {
		slog.Debug("series joined", "seriesId", seriesID, "title", logSafe(title), "source", logSafe(source), "media", mediaID)
	}
	return created, title
}

// detachProvider takes a provider off its series once no folder is matched to
// it any more, and returns the series it left (0 when it stayed). Without
// this a replaced match lived on as the series' identity: Plex had hung the
// show's TVDB id on the series of a wrong AniList guess, the folder's TVDB
// match then joined that series as "already bundled", and title and kind kept
// coming from the AniList entry nobody matched any more. A provider put on a
// series by hand stays. What the provider brought goes with it - its titles,
// the seasons it named, the kind read from it - and a series left with no
// provider at all is dropped.
func (s *Server) detachProvider(source string, mediaID int) int64 {
	s.seriesMu.Lock()
	defer s.seriesMu.Unlock()
	var seriesID int64
	var manual, still int
	if s.DB.QueryRow(`SELECT series_id, manual FROM series_provider WHERE source = ? AND media_id = ?`,
		source, mediaID).Scan(&seriesID, &manual) != nil || manual == 1 {
		return 0
	}
	if s.DB.QueryRow(`SELECT COUNT(*) FROM catalog_matches WHERE source = ? AND media_id = ?`,
		source, mediaID).Scan(&still) != nil || still > 0 {
		return 0
	}
	// the show an AniList entry on the series is filed under by the anime
	// mapping is the series' own identity, not a match that left: Detective
	// Conan taken back from TVDB to AniList keeps its TVDB id, which is what
	// bridges it to Plex
	if source == "tvdb" || source == "tmdb:tv" {
		col := "tvdb_id"
		if source == "tmdb:tv" {
			col = "tmdb_id"
		}
		var mapped int
		s.DB.QueryRow(`SELECT COUNT(*) FROM anime_ids a JOIN series_provider sp
			ON sp.source = 'anilist' AND sp.media_id = a.anilist_id
			WHERE sp.series_id = ? AND a.`+col+` = ?`, seriesID, mediaID).Scan(&mapped)
		if mapped > 0 {
			return 0
		}
	}
	// series_titles names the provider without the tmdb kind
	titleSource, _, _ := strings.Cut(source, ":")
	tx, err := s.DB.Begin()
	if err != nil {
		return 0
	}
	defer tx.Rollback()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`DELETE FROM series_provider WHERE source = ? AND media_id = ?`, []any{source, mediaID}},
		{`DELETE FROM series_titles WHERE series_id = ? AND source = ?`, []any{seriesID, titleSource}},
		{`DELETE FROM series_seasons WHERE series_id = ? AND source = ?`, []any{seriesID, titleSource}},
		{`UPDATE series SET kind = '', titles_fetched_at = '' WHERE id = ?`, []any{seriesID}},
	} {
		if _, err := tx.Exec(q.sql, q.args...); err != nil {
			slog.Warn("provider not detached", "source", logSafe(source), "media", mediaID, "err", err)
			return 0
		}
	}
	var left int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM series_provider WHERE series_id = ?`, seriesID).Scan(&left); err != nil {
		return 0
	}
	if left == 0 {
		for _, q := range []string{
			`DELETE FROM series_titles WHERE series_id = ?`,
			`DELETE FROM series_seasons WHERE series_id = ?`,
			`UPDATE catalog_variants SET series_id = 0 WHERE series_id = ?`,
			`DELETE FROM series WHERE id = ?`,
		} {
			if _, err := tx.Exec(q, seriesID); err != nil {
				return 0
			}
		}
	}
	if tx.Commit() != nil {
		return 0
	}
	slog.Info("provider detached from series", "series", seriesID, "source", logSafe(source), "media", mediaID, "dropped", left == 0)
	if left == 0 {
		return 0
	}
	return seriesID
}

// retitleSeries names a series after the provider a folder now matches, when
// that provider sits on the series another one just left: the name was the
// leaver's.
func (s *Server) retitleSeries(seriesID int64, source string, mediaID int) {
	var on int64
	if s.DB.QueryRow(`SELECT series_id FROM series_provider WHERE source = ? AND media_id = ?`,
		source, mediaID).Scan(&on) != nil || on != seriesID {
		return
	}
	media, _ := s.sourceMedia(source, mediaID)
	if media == nil {
		return
	}
	title := media.Title.Romaji
	if title == "" {
		title = media.Title.English
	}
	key := seriesKey(source, title)
	if key == "" {
		return
	}
	s.DB.Exec(`UPDATE series SET key = ?, title = ?, year = ? WHERE id = ?`, key, title, media.SeasonYear, seriesID)
}

// settleSeries gives a series a folder matched on TVDB or TMDB the name and kind
// of that match, when no AniList entry is on it: AniList names what it lists,
// everything else is named by what the folder matched. Without this a series
// kept the name of whatever was on it before - an AniList guess the folder
// left in an earlier step, or the first title the bundle was made from - and
// its kind waited for the next sweep.
func (s *Server) settleSeries(source string, mediaID int) {
	if source != "tvdb" && source != tvdbMovieSource && !strings.HasPrefix(source, "tmdb:") {
		return
	}
	var seriesID int64
	if s.DB.QueryRow(`SELECT series_id FROM series_provider WHERE source = ? AND media_id = ?`,
		source, mediaID).Scan(&seriesID) != nil {
		return
	}
	rows, err := s.DB.Query(`SELECT source, media_id FROM series_provider WHERE series_id = ?`, seriesID)
	if err != nil {
		return
	}
	var refs []providerRef
	for rows.Next() {
		var r providerRef
		if rows.Scan(&r.Source, &r.MediaID) == nil {
			refs = append(refs, r)
		}
	}
	rows.Close()
	if rows.Err() != nil {
		return
	}
	for _, r := range refs {
		if r.Source == "anilist" {
			return
		}
	}
	// an anime matched on TVDB keeps every id the mapping knows: they are
	// its own; only live action sheds what an AniList guess left behind
	if !s.inAnimeIDs(source, mediaID) {
		refs = s.dropAnimeLeftovers(seriesID, refs)
	}
	s.retitleSeries(seriesID, source, mediaID)
	// undecided (TVDB not cached yet) keeps what was decided before - it was
	// reset wholesale once and a library went back to the old guesses for
	// half an hour - except "anime": dropping the leftovers above is what
	// can change it, so the sweep decides that one again
	if kind := s.decideSeriesKind(refs); kind != "" {
		s.DB.Exec(`UPDATE series SET kind = ? WHERE id = ?`, kind, seriesID)
	} else {
		s.DB.Exec(`UPDATE series SET kind = '' WHERE id = ? AND kind = ?`, seriesID, kindAnime)
	}
}

// dropAnimeLeftovers takes the show ids off a series that the anime mapping
// hung there for an AniList entry no longer on it: House of the Dragon kept
// the TVDB id of "Dragon, Ie wo Kau." and with it the anime kind. An id stays
// when a folder matches it or someone put it there by hand. Returns what is
// left of refs.
func (s *Server) dropAnimeLeftovers(seriesID int64, refs []providerRef) []providerRef {
	out := refs[:0:0]
	plexIDs := s.plexIDs()
	for _, r := range refs {
		var matched, manual int
		// an id Plex holds came from Plex, not from an AniList guess: the
		// anime mapping has wrong rows (Adventure Time: Fionna and Cake under
		// an AniList id), Plex names the show in the library
		mapped := s.inAnimeIDs(r.Source, r.MediaID) && !plexIDs[plexIDKey(r.Source, r.MediaID)]
		if mapped {
			s.DB.QueryRow(`SELECT COUNT(*) FROM catalog_matches WHERE source = ? AND media_id = ?`, r.Source, r.MediaID).Scan(&matched)
			s.DB.QueryRow(`SELECT manual FROM series_provider WHERE source = ? AND media_id = ?`, r.Source, r.MediaID).Scan(&manual)
		}
		if mapped && matched == 0 && manual == 0 {
			if _, err := s.DB.Exec(`DELETE FROM series_provider WHERE source = ? AND media_id = ? AND series_id = ?`,
				r.Source, r.MediaID, seriesID); err == nil {
				slog.Info("anime leftover dropped from series", "series", seriesID, "source", logSafe(r.Source), "media", r.MediaID)
				continue
			}
		}
		out = append(out, r)
	}
	return out
}

// plexIDs is every TVDB and TMDB id the Plex library holds, keyed as
// plexIDKey does; empty without Plex.
func (s *Server) plexIDs() map[string]bool {
	out := map[string]bool{}
	for _, g := range s.plexGuidIndex() {
		if g.TVDB != 0 {
			out[plexIDKey("tvdb", g.TVDB)] = true
		}
		if g.TMDB != 0 {
			out[plexIDKey("tmdb:", g.TMDB)] = true
		}
	}
	return out
}

// plexIDKey names an id by its catalogue; TMDB's tv and movie tags count as
// one, as Plex's guid does not say which.
func plexIDKey(source string, id int) string {
	if strings.HasPrefix(source, "tmdb") {
		source = "tmdb"
	}
	return source + ":" + strconv.Itoa(id)
}

// inAnimeIDs reports whether the anime mapping knows a TVDB or TMDB id.
func (s *Server) inAnimeIDs(source string, id int) bool {
	col := ""
	switch source {
	case "tvdb":
		col = "tvdb_id"
	case "tmdb:tv", "tmdb:movie":
		col = "tmdb_id"
	default:
		return false
	}
	var n int
	s.DB.QueryRow(`SELECT COUNT(*) FROM anime_ids WHERE `+col+` = ?`, id).Scan(&n)
	return n > 0
}

// seriesRules names how series are named and keyed; bumping it settles every
// series a TVDB or TMDB match sits on once, at startup.
const seriesRules = "2026-10-tvdb-extended"

// SettleMatchedSeries runs settleSeries over every stored TVDB and TMDB match
// once per rule set: series bundled before it carried the name of an AniList
// guess their folder has since left.
func (s *Server) SettleMatchedSeries() {
	if db.Setting(s.DB, "series_rules") == seriesRules {
		return
	}
	// TVDB records cached before they carried genres and the next episode
	// turn stale: still good for a name, fetched again as they are needed, and
	// a kind waits undecided till then (decideSeriesKind)
	s.DB.Exec(`UPDATE anilist_cache SET fetched_at = '2000-01-01 00:00:00' WHERE key LIKE 'tvdb:media:%'`)
	rows, err := s.DB.Query(`SELECT DISTINCT source, media_id FROM catalog_matches
		WHERE media_id != 0 AND (source IN ('tvdb', 'tvdb:movie') OR source LIKE 'tmdb:%')`)
	if err != nil {
		return
	}
	var refs []providerRef
	for rows.Next() {
		var r providerRef
		if rows.Scan(&r.Source, &r.MediaID) == nil {
			refs = append(refs, r)
		}
	}
	rows.Close()
	if rows.Err() != nil {
		return
	}
	for _, r := range refs {
		s.settleSeries(r.Source, r.MediaID)
	}
	slog.Info("matched series settled", "matches", len(refs))
	db.SetSetting(s.DB, "series_rules", seriesRules)
}

// seriesKey is the bundling key of a title: the romaji fold for AniList, the
// plain form for TVDB and TMDB, whose titles are English, German or native.
func seriesKey(source, title string) string {
	if source == "anilist" {
		return match.FoldKey(match.StripMarkers(title))
	}
	return match.PlainKey(match.StripMarkers(title))
}

// findSeries returns the id of an existing series matching key under the year
// gate (year within 1, or either side unknown), or 0 for none. Caller holds
// seriesMu. A read that failed is an error, not a "none". anime limits it to
// series an AniList entry is on.
func (s *Server) findSeries(key string, year int, anime bool) (int64, error) {
	q := `SELECT id, year FROM series WHERE key = ?`
	if anime {
		q += ` AND id IN (SELECT series_id FROM series_provider WHERE source = 'anilist')`
	}
	rows, err := s.DB.Query(q, key)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var sy int
		if err := rows.Scan(&id, &sy); err != nil {
			return 0, err
		}
		if d := year - sy; year == 0 || sy == 0 || (d >= -1 && d <= 1) {
			return id, nil
		}
	}
	return 0, rows.Err()
}

// probeState records HOW a copy's languages were established. It is three
// states rather than a flag because "we have not looked yet" and "we looked and
// the container would not answer" call for opposite decisions: the first is
// worth waiting for, the second is as good as the evidence will ever get.
type probeState int

const (
	probeNone     probeState = 0 // parsed out of the file names, nothing measured
	probeMeasured probeState = 1 // container streams read (ffprobe, or Plex's own analysis)
	probeFailed   probeState = 2 // measuring was attempted and impossible: no ffprobe, unreadable container, host down
)

// FolderQuality is the resolution and language make-up of one physical folder,
// aggregated over its files (season subfolders included).
type FolderQuality struct {
	ResRank int      // max video height, 0 = unknown
	Dub     []string // canonical dub language codes, sorted
	Sub     []string // canonical sub language codes, sorted
	// Soft is the subset of Sub that is actually SELECTABLE: a subtitle stream
	// in the container, or a subtitle file lying next to the video. A language
	// that appears in Sub but not here is one the release advertises and cannot
	// hand over as a track - burned into the picture, in other words - and a
	// copy that offers the same language as a real track is an upgrade over it.
	Soft []string
	// Probed records how the languages above were established. An upgrade
	// comparison needs to know, or a name that promises more than the file
	// carries beats a measurement.
	Probed probeState
}

// scanQuality reads a folder's quality: measured from the container streams for
// a local folder, parsed out of the file names in the remote index for a remote
// one. Which of the two it was is recorded in Probed, because only the local
// side can ever be measured and a comparison that does not know that lets a
// name overrule a measurement.
// ok is false when the remote listing could not be read whole: the caller keeps
// the row it has rather than storing a quality read off half the files.
func (s *Server) scanQuality(serverID int64, folder string) (FolderQuality, bool) {
	q := FolderQuality{}
	if serverID == 0 {
		// local: no remote_index. Read the real quality from the files via
		// ffprobe (filenames often lack the tokens); fall back to parsing the
		// filenames when ffprobe is unavailable or finds nothing.
		if abs, err := s.safeLocal(folder); err == nil {
			if pq, ok := s.probeQuality(abs); ok {
				pq.Probed = probeMeasured
				return pq, true
			}
			// ffprobe is missing, or no file in the folder would answer: the
			// names are all that is left, and the attempt is recorded so the
			// comparison does not keep waiting for a measurement that will not
			// come
			fq := s.localFilenameQuality(abs)
			fq.Probed = probeFailed
			return fq, true
		}
		return q, true
	}
	// remote: only the crawler's file listing exists, so every value below is a
	// guess read off a name. Probed stays probeNone.
	rows, err := s.DB.Query(`SELECT name FROM remote_index
		WHERE server_id = ?1 AND is_dir = 0 AND parent >= ?2 AND parent < ?2 || '0' AND (parent = ?2 OR parent >= ?2 || '/')`,
		serverID, folder)
	if err != nil {
		return q, false
	}
	defer rows.Close()
	var names []string
	dubSet, subSet := map[string]bool{}, map[string]bool{}
	for rows.Next() {
		var name string
		if rows.Scan(&name) != nil {
			continue
		}
		names = append(names, name)
		if r := rename.Resolution(name); r > q.ResRank {
			q.ResRank = r
		}
		dub, sub := rename.LangTags(name)
		for _, c := range rename.Codes(dub) {
			dubSet[canonCode(c)] = true
		}
		for _, c := range rename.Codes(sub) {
			subSet[canonCode(c)] = true
		}
	}
	if rows.Err() != nil {
		return q, false
	}
	// a subtitle file in the listing is the one selectable subtitle a remote
	// copy can prove without being opened, and it costs nothing to read
	soft, any := sidecarSubs(names)
	if any && len(soft) == 0 {
		soft[undLang] = true
	}
	// If LangProbeLoop has already opened this folder's representative file, its
	// tracks are on record and beat every guess above. Read from the cache only:
	// this runs on the sweep, which must not dial a server, and a folder nobody
	// has measured yet simply keeps its guess and is picked up later.
	if rep := s.representativeRemote(serverID, folder); rep != "" {
		if pd, ps, hit := s.cachedRemoteLang(serverID, rep); hit {
			measuredSoft := unionSets(ps, soft) // every stream and sidecar is a real track
			q.Dub = keysSorted(pd)
			q.Soft = keysSorted(measuredSoft)
			// what the names advertise on top of that is the burned-in half
			q.Sub = keysSorted(unionSets(subSet, measuredSoft))
			q.Probed = probeMeasured
			return q, true
		}
	}
	q.Dub = keysSorted(dubSet)
	q.Sub = keysSorted(unionSets(subSet, soft))
	q.Soft = keysSorted(soft)
	return q, true
}

// refreshVariant recomputes and stores a folder's quality variant along with the
// canonical unit (show_key, season, is_movie) it belongs to, so upgrade and
// incomplete comparisons can GROUP BY that unit across servers.
func (s *Server) refreshVariant(serverID int64, folder string) {
	q, ok := s.scanQuality(serverID, folder)
	if !ok {
		return // listing unreadable: the stored variant stays until the next pass
	}
	showKey, season, isMovie := s.folderUnit(serverID, folder)
	// libKind stays empty: a remote copy lives in no Plex library, so there is
	// no library whose kind it could inherit.
	s.storeVariant(serverID, folder, q, showKey, season, isMovie, s.seriesIDForFolder(serverID, folder), "")
}

// storeVariant is the ONE place a catalog_variants row is written, from the
// match sweep and from the Plex index alike.
//
// It exists because of the trap 027 records and 046 repeats: the row is written
// with INSERT OR REPLACE, so a column left out of the statement does not keep
// its value, it silently falls back to its default on the next sweep. With two
// copies of the column list that is one forgotten edit away; with one, adding a
// column is one edit.
//
// ponytail: the row records the library's KIND, not which library it was - so
// two libraries of the same type and kind ("Anime" and "Serien", "Filme" and
// "Filme 4K") still collapse into one unit and a sync follows whichever local
// copy bestCopy picked. Store the section key here if per-library separation
// ever needs to be exact.
func (s *Server) storeVariant(serverID int64, folder string, q FolderQuality, showKey string, season int, isMovie bool, seriesID int64, libKind string) {
	s.DB.Exec(`INSERT OR REPLACE INTO catalog_variants
		(server_id, folder, res_rank, dub_codes, sub_codes, soft_codes, computed_at, show_key, season, is_movie, series_id, probed, lib_kind)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		serverID, folder, q.ResRank, strings.Join(q.Dub, ","), strings.Join(q.Sub, ","),
		strings.Join(q.Soft, ","),
		time.Now().UTC().Format(time.RFC3339), showKey, season, boolInt(isMovie),
		seriesID, int(q.Probed), libKind)
}

// seriesIDForFolder resolves the canonical series behind a matched folder: the
// match names a provider hit, and linkSeries has already hung that hit on a
// series (same persistMatch call). 0 when the match has not been bundled yet -
// the sweep's relinkOrphans catches up, and show_key carries until then.
func (s *Server) seriesIDForFolder(serverID int64, folder string) int64 {
	var id int64
	s.DB.QueryRow(`SELECT sp.series_id FROM catalog_matches cm
		JOIN series_provider sp ON sp.source = cm.source AND sp.media_id = cm.media_id
		WHERE cm.server_id = ? AND cm.folder = ?`, serverID, folder).Scan(&id)
	return id
}

// folderUnit derives the canonical (show_key, season, is_movie) of a matched
// folder from its catalog_matches provider hit. The show_key is the shared
// cross-provider show identity so a local and a remote copy of the SAME season
// collide on it:
//   - anilist: the Fribb mapping gives the exact TVDB/TMDB id + season number
//     (authoritative, matches Plex's season index). Without a mapping, fall back
//     to the title fold key + a best-effort season from the media/folder name.
//   - tmdb:tv / tvdb: one id spans all seasons; the season is parsed from the
//     folder name (live-action folders carry "Season N").
//   - tmdb:movie: a movie, season 0.
func (s *Server) folderUnit(serverID int64, folder string) (showKey string, season int, isMovie bool) {
	var source string
	var mediaID int
	if s.DB.QueryRow(`SELECT source, media_id FROM catalog_matches WHERE server_id = ? AND folder = ?`,
		serverID, folder).Scan(&source, &mediaID); source == "" || mediaID == 0 {
		return "", 0, false
	}
	base := filepath.Base(folder)
	switch {
	case source == "anilist":
		media, _ := s.sourceMedia(source, mediaID)
		if a, ok := s.animeIDs(mediaID); ok {
			switch {
			case a.tvdbID != 0:
				return "tvdb:" + strconv.Itoa(a.tvdbID), unitSeason(a.tvdbSeason, media, base), false
			case a.tmdbID != 0 && a.tmdbKind == "movie" && !s.looksLikeSeries(serverID, folder, base):
				return "tmdb:" + strconv.Itoa(a.tmdbID), 0, true
			case a.tmdbID != 0:
				return "tmdb:" + strconv.Itoa(a.tmdbID), unitSeason(a.tmdbSeason, media, base), false
			case a.imdbID != "":
				return "imdb:" + a.imdbID, unitSeason(0, media, base), false
			}
		}
		// no Fribb mapping: best-effort fold key + season (won't line up with
		// Plex's tvdb key, so no false cross matches - just no suggestion)
		if media != nil {
			if media.Format == "MOVIE" && !s.looksLikeSeries(serverID, folder, base) {
				return "fold:" + match.FoldKey(match.StripMarkers(mediaTitle(media))), 0, true
			}
			return "fold:" + match.FoldKey(match.StripMarkers(mediaTitle(media))), unitSeason(0, media, base), false
		}
		return "", 0, false
	case source == "tmdb:movie":
		return "tmdb:" + strconv.Itoa(mediaID), 0, true
	case source == tvdbMovieSource:
		// keyed as Plex keys a film it knows by its TVDB id
		return "tvdb:" + strconv.Itoa(mediaID), 0, true
	case source == "tmdb:tv":
		return "tmdb:" + strconv.Itoa(mediaID), match.ParseName(base, "", "").Season, false
	case source == "tvdb":
		return "tvdb:" + strconv.Itoa(mediaID), match.ParseName(base, "", "").Season, false
	case source == "imdb":
		return "imdb:" + strconv.Itoa(mediaID), match.ParseName(base, "", "").Season, false
	}
	return "", 0, false
}

// looksLikeSeries reports whether a folder holds episodes, and is the veto on
// calling it a film. A provider's format describes the WORK, not this folder: a
// MOVIE hit sitting on a folder full of episodes is a mismatch, and believing it
// files a 24-episode show under "movies" with season 0, where no local season
// can ever meet it. itemKind is the same file-count signal the catalog listing
// classifies with, so both agree on what a folder is.
//
// Only the anilist paths ask: tmdb:movie already comes from scopeForItem, which
// derives the movie tag from that very file count, and re-deriving a season
// there would file a movie id under a tv show key.
func (s *Server) looksLikeSeries(serverID int64, folder, base string) bool {
	return s.itemKind(serverID, folder, base) == "series"
}

// unitSeason resolves an anime folder's season: the Fribb season when known
// (authoritative), else AniList's SeasonOf, else the folder name, defaulting to
// 1 so a base anime entry lines up with Plex's season-1 index.
//
// ponytail: default-to-1 is a heuristic for the no-Fribb path; the Fribb season
// is the real key. A show whose Plex season index disagrees just won't match.
func unitSeason(fribbSeason int, media *anilist.Media, base string) int {
	if fribbSeason > 0 {
		return fribbSeason
	}
	if media != nil {
		if s := match.SeasonOf(*media); s > 0 {
			return s
		}
	}
	if s := match.ParseName(base, "", "").Season; s > 0 {
		return s
	}
	return 1
}

func mediaTitle(m *anilist.Media) string {
	if m.Title.Romaji != "" {
		return m.Title.Romaji
	}
	return m.Title.English
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
