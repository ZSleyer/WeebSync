package api

import (
	"fmt"
	"math/rand/v2"
	"net/http"

	"github.com/ch4d1/weebsync/internal/auth"
)

// The Today page opens on a manga page cut from AniList banners: the wide
// 1900x400 strips AniList keeps beside the poster. They come from the
// cached media records (anilist_cache keeps the whole Media, bannerImage
// included), so drawing a page never asks AniList for anything.

// maxBanners is how many panels a page has at most.
const maxBanners = 5

// matchBannerPool bounds the catalog tier: a random handful is drawn in SQL,
// so a library of thousands of matched folders never loads whole.
const matchBannerPool = 40

// defaultBannerIDs are the titles a bare install draws its page from, before
// any auto-sync or catalog match exists (AniList ids).
var defaultBannerIDs = []int{21, 235, 143270, 101280, 178533, 161645, 178869, 21355}

// todayBanner is one panel's picture.
type todayBanner struct {
	// Source is the metadata source of the title, for opening its card
	Source string `json:"source"`
	ID     int    `json:"id"`
	// URL is AniList's banner, full width
	URL string `json:"url"`
	// Title names the panel for a screen reader; never drawn on the banner
	Title string `json:"title"`
	// Tier says where the title came from: one of the caller's auto-syncs,
	// a matched catalog folder, or the default set
	Tier string `json:"tier" enums:"watch,match,default"`
}

// todayBannersResponse is a random draw of banners for the Today page.
type todayBannersResponse struct {
	Banners []todayBanner `json:"banners"`
	// Watches is how many auto-syncs the caller has; with none the page
	// offers to create the first
	Watches int `json:"watches"`
}

// pickBanners draws up to n banners: the first tier first, then the next, a
// title never twice. Each tier is shuffled with rnd, so every visit gets a
// different page while the order of the tiers holds.
func pickBanners(tiers [][]todayBanner, n int, rnd *rand.Rand) []todayBanner {
	out := []todayBanner{}
	seen := map[string]bool{}
	for _, tier := range tiers {
		list := append([]todayBanner(nil), tier...)
		rnd.Shuffle(len(list), func(i, j int) { list[i], list[j] = list[j], list[i] })
		for _, b := range list {
			if len(out) >= n {
				return out
			}
			k := fmt.Sprintf("%s|%d", b.Source, b.ID)
			if b.URL == "" || seen[k] {
				continue
			}
			seen[k] = true
			out = append(out, b)
		}
	}
	return out
}

// cachedBanner reads a title's banner from the media cache; "" when the title
// is not cached or has none.
func (s *Server) cachedBanner(source string, id int, tier string) todayBanner {
	b := todayBanner{Source: source, ID: id, Tier: tier}
	if s.Anilist == nil {
		return b
	}
	if m, _ := s.Anilist.CachedMedia(id); m != nil {
		b.URL, b.Title = m.BannerImage, mediaTitle(m)
	}
	return b
}

// handleTodayBanners draws the Today page's banners.
//
//	@Summary		Today banners
//	@Description	A random draw of at most five AniList banners for the Today page: the caller's auto-syncs first, then matched catalog folders, then a default set. Only cached media is read; a default title not cached yet is fetched in the background and shows up on a later visit. An empty list means no picture is reachable.
//	@Tags			Downloads
//	@Produce		json
//	@Success		200	{object}	todayBannersResponse
//	@Failure		401	{object}	ErrorResponse
//	@Failure		500	{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/today/banners [get]
func (s *Server) handleTodayBanners(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	resp := todayBannersResponse{}
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM watches WHERE user_id = ?`, u.ID).Scan(&resp.Watches); err != nil {
		dbErr(w)
		return
	}
	// titles as source and id, read as banners of one tier
	tier := func(name, q string, args ...any) ([]todayBanner, error) {
		rows, err := s.DB.Query(q, args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var refs []providerRef
		for rows.Next() {
			var p providerRef
			if err := rows.Scan(&p.Source, &p.MediaID); err != nil {
				return nil, err
			}
			refs = append(refs, p)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
		rows.Close()
		out := make([]todayBanner, 0, len(refs))
		for _, p := range refs {
			out = append(out, s.cachedBanner(p.Source, p.MediaID, name))
		}
		return out, nil
	}
	// a watch's title is the catalog match of its folder (see watchMedia)
	watches, err := tier("watch", `SELECT DISTINCT c.source, c.media_id FROM watches w
		JOIN catalog_matches c ON c.server_id = w.server_id AND c.folder = w.remote_path
		WHERE w.user_id = ? AND c.media_id != 0 AND c.source IN ('anilist', 'anilist:manga')`, u.ID)
	if err != nil {
		dbErr(w)
		return
	}
	// the caller's own servers and the local library
	matches, err := tier("match", `SELECT DISTINCT c.source, c.media_id FROM catalog_matches c
		WHERE c.media_id != 0 AND c.source = 'anilist'
		  AND (c.server_id = 0 OR c.server_id IN (SELECT id FROM servers WHERE user_id = ?))
		ORDER BY random() LIMIT ?`, u.ID, matchBannerPool)
	if err != nil {
		dbErr(w)
		return
	}
	defaults := make([]todayBanner, 0, len(defaultBannerIDs))
	for _, id := range defaultBannerIDs {
		defaults = append(defaults, s.cachedBanner("anilist", id, "default"))
	}
	// a default title the cache lacks is fetched for the next visit; the
	// page never waits on AniList
	for _, b := range defaults {
		if b.Title == "" && s.Anilist != nil {
			s.queueMediaFetch(b.ID)
		}
	}
	resp.Banners = pickBanners([][]todayBanner{watches, matches, defaults}, maxBanners, rand.New(rand.NewPCG(rand.Uint64(), rand.Uint64())))
	writeJSON(w, http.StatusOK, resp)
}
