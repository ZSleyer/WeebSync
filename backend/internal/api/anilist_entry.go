package api

import (
	"context"
	"net/http"
	"slices"
	"strconv"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
)

// The linked user's own list entry for one title, for the series page:
// read whenever an account is linked, changed only with the list switch on.

// anilistEntryResponse is the user's entry for one media.
type anilistEntryResponse struct {
	// Linked: an AniList account is connected; everything else is empty
	// without one
	Linked bool `json:"linked"`
	// CanEdit: the user allowed WeebSync to change the list
	CanEdit bool `json:"canEdit"`
	// ScoreFormat is the scale the user rates in: POINT_100,
	// POINT_10_DECIMAL, POINT_10, POINT_5 or POINT_3
	ScoreFormat string `json:"scoreFormat,omitempty"`
	// Episodes the media has, 0 when unknown (still airing, say)
	Episodes int `json:"episodes,omitempty"`
	// Entry is null when the title is not on the list
	Entry *anilist.ListEntryDetail `json:"entry"`
}

// anilistEntryRequest changes an entry; absent fields stay as they are.
type anilistEntryRequest struct {
	Status   *string `json:"status,omitempty" enums:"CURRENT,PLANNING,COMPLETED,DROPPED,PAUSED,REPEATING"`
	Progress *int    `json:"progress,omitempty"`
	// ScoreRaw is the score on the 100-point scale, 0 to clear it
	ScoreRaw *int `json:"scoreRaw,omitempty"`
}

func mediaIDParam(w http.ResponseWriter, r *http.Request) (int, bool) {
	id, err := strconv.Atoi(r.PathValue("mediaId"))
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid media id")
		return 0, false
	}
	return id, true
}

// mediaEpisodes is the episode count of a media, from the cache when it
// holds it; 0 when unknown.
func (s *Server) mediaEpisodes(ctx context.Context, id int) int {
	if m, _ := s.Anilist.CachedMedia(id); m != nil {
		return m.Episodes
	}
	if m, err := s.Anilist.Media(ctx, id); err == nil && m != nil {
		return m.Episodes
	}
	return 0
}

// handleAnilistEntry reads the user's list entry for a media.
//
//	@Summary		AniList list entry
//	@Description	The linked user's AniList list entry for a media (status, progress, score on the 100-point scale plus the user's own score format), read with the user's token. linked=false without a connected account.
//	@Tags			Suggestions
//	@Produce		json
//	@Param			mediaId	path		int	true	"AniList media id"
//	@Success		200		{object}	anilistEntryResponse
//	@Failure		400		{object}	ErrorResponse
//	@Failure		502		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/anilist/entry/{mediaId} [get]
func (s *Server) handleAnilistEntry(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	mediaID, ok := mediaIDParam(w, r)
	if !ok {
		return
	}
	alID, token, err := s.anilistAccount(u.ID)
	if err != nil {
		writeJSON(w, http.StatusOK, anilistEntryResponse{})
		return
	}
	out, ok := s.anilistEntryOf(w, r.Context(), u.ID, alID, token, mediaID)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// anilistEntryOf reads the entry and everything around it; on failure it
// has answered the request.
func (s *Server) anilistEntryOf(w http.ResponseWriter, ctx context.Context, userID int64, alID int, token string, mediaID int) (anilistEntryResponse, bool) {
	out := anilistEntryResponse{Linked: true, CanEdit: s.anilistPerms(userID).List}
	format, err := s.Anilist.ScoreFormat(ctx, token, alID)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return out, false
	}
	out.ScoreFormat = format
	if out.Entry, err = s.Anilist.ListEntry(ctx, token, alID, mediaID); err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return out, false
	}
	out.Episodes = s.mediaEpisodes(ctx, mediaID)
	return out, true
}

// handleAnilistEntrySave creates or changes the user's list entry.
//
//	@Summary		Save AniList list entry
//	@Description	Create or change the linked user's list entry for a media: status, progress (0 to the episode count when known) and score (0-100). Only the given fields change. Needs the list switch (403 otherwise).
//	@Tags			Suggestions
//	@Accept			json
//	@Produce		json
//	@Param			mediaId	path		int					true	"AniList media id"
//	@Param			body	body		anilistEntryRequest	true	"Fields to change"
//	@Success		200		{object}	anilistEntryResponse
//	@Failure		400		{object}	ErrorResponse
//	@Failure		403		{object}	ErrorResponse	"list changes turned off in the settings"
//	@Failure		502		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/anilist/entry/{mediaId} [put]
func (s *Server) handleAnilistEntrySave(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	mediaID, ok := mediaIDParam(w, r)
	if !ok {
		return
	}
	var in anilistEntryRequest
	if !readJSON(w, r, &in) {
		return
	}
	if in.Status == nil && in.Progress == nil && in.ScoreRaw == nil {
		writeErr(w, http.StatusBadRequest, "nothing to change")
		return
	}
	if in.Status != nil && !slices.Contains(anilist.ListStatuses, *in.Status) {
		writeErr(w, http.StatusBadRequest, "invalid status")
		return
	}
	if in.ScoreRaw != nil && (*in.ScoreRaw < 0 || *in.ScoreRaw > 100) {
		writeErr(w, http.StatusBadRequest, "score must be 0 to 100")
		return
	}
	alID, token, ok := s.anilistWriter(w, u.ID, writeList)
	if !ok {
		return
	}
	eps := s.mediaEpisodes(r.Context(), mediaID)
	if in.Progress != nil && (*in.Progress < 0 || (eps > 0 && *in.Progress > eps)) {
		writeErr(w, http.StatusBadRequest, "progress out of range")
		return
	}
	entry, err := s.Anilist.SaveListEntry(r.Context(), token, mediaID, anilist.EntryPatch{
		Status: in.Status, Progress: in.Progress, ScoreRaw: in.ScoreRaw,
	})
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	s.Anilist.InvalidateUserList(alID)
	if in.Status != nil {
		s.staleUserSuggestions(u.ID)
	} else {
		s.patchSuggestionProgress(u.ID, mediaID, entry.Progress)
	}
	format, _ := s.Anilist.ScoreFormat(r.Context(), token, alID)
	writeJSON(w, http.StatusOK, anilistEntryResponse{Linked: true, CanEdit: true, ScoreFormat: format, Episodes: eps, Entry: entry})
}

// handleAnilistEntryDelete removes the user's list entry.
//
//	@Summary		Remove AniList list entry
//	@Description	Remove a media from the linked user's list. Needs the list switch (403 otherwise). Removing a title that is not on the list is not an error.
//	@Tags			Suggestions
//	@Produce		json
//	@Param			mediaId	path		int	true	"AniList media id"
//	@Success		200		{object}	anilistEntryResponse
//	@Failure		400		{object}	ErrorResponse
//	@Failure		403		{object}	ErrorResponse	"list changes turned off in the settings"
//	@Failure		502		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/anilist/entry/{mediaId} [delete]
func (s *Server) handleAnilistEntryDelete(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	mediaID, ok := mediaIDParam(w, r)
	if !ok {
		return
	}
	alID, token, ok := s.anilistWriter(w, u.ID, writeList)
	if !ok {
		return
	}
	out, ok := s.anilistEntryOf(w, r.Context(), u.ID, alID, token, mediaID)
	if !ok {
		return
	}
	if out.Entry != nil {
		if err := s.Anilist.DeleteListEntry(r.Context(), token, out.Entry.ID); err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		s.Anilist.InvalidateUserList(alID)
		s.staleUserSuggestions(u.ID)
	}
	out.Entry = nil
	writeJSON(w, http.StatusOK, out)
}

// staleUserSuggestions ages the user's suggestions blob past its lifetime: the
// page keeps showing it and rebuilds it in the background, now without the
// title that left the list or changed its status.
func (s *Server) staleUserSuggestions(userID int64) {
	s.DB.Exec(`UPDATE anilist_cache SET fetched_at = '2000-01-01 00:00:00' WHERE key = ?`,
		"suggestions:"+strconv.FormatInt(userID, 10))
}
