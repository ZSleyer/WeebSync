package api

import (
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/auth"
)

// handleAnilistThread serves one AniList forum thread for the in-app reader:
// the opening post and one page of comments, replies flattened one level.
// A user who allowed replies and likes reads it with their own token, so
// the likes say which ones are theirs; everyone else reads anonymously.
//
//	@Summary		AniList thread
//	@Description	Opening post and one page (25 top-level comments) of an AniList forum thread. Bodies are AniList markdown, capped in size; replies are flattened under their top-level comment, at most three levels deep. isLiked is set only for a user who allowed replies and likes.
//	@Tags			Suggestions
//	@Produce		json
//	@Param			id		path		int	true	"AniList thread id"
//	@Param			page	query		int	false	"Comment page, 1-based (default 1)"
//	@Success		200		{object}	anilist.ThreadPage
//	@Failure		400		{object}	ErrorResponse
//	@Failure		502		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/anilist/threads/{id} [get]
func (s *Server) handleAnilistThread(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.PathValue("id"))
	if id <= 0 {
		writeErr(w, http.StatusBadRequest, "id required")
		return
	}
	page := 1
	if v := r.URL.Query().Get("page"); v != "" {
		p, err := strconv.Atoi(v)
		if err != nil || p < 1 || p > 1000 {
			writeErr(w, http.StatusBadRequest, "invalid page")
			return
		}
		page = p
	}
	var token string
	var viewer int
	if u := auth.UserFrom(r.Context()); u != nil && s.anilistPerms(u.ID).Social {
		if alID, tok, err := s.anilistAccount(u.ID); err == nil {
			viewer, token = alID, tok
		}
	}
	var tp *anilist.ThreadPage
	tp, err := s.Anilist.ThreadAs(r.Context(), token, viewer, id, page)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, tp)
}

// socialAllowed spends one of the user's forum writes: a few a minute, so a
// stuck button or a script cannot flood AniList under the user's name.
func (s *Server) socialAllowed(w http.ResponseWriter, userID int64) bool {
	if ok, wait := s.socialLimiter.take("user:" + strconv.FormatInt(userID, 10)); !ok {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		writeErr(w, http.StatusTooManyRequests, "too many replies and likes, wait a moment")
		return false
	}
	return true
}

// anilistReplyRequest is a reply to a thread or to one of its comments.
type anilistReplyRequest struct {
	Comment string `json:"comment"`
	// ParentCommentID answers that comment; absent answers the thread
	ParentCommentID int `json:"parentCommentId,omitempty"`
}

// anilistReplyResponse names the new comment.
type anilistReplyResponse struct {
	ID int `json:"id"`
}

// handleAnilistReply posts a reply in a thread as the linked user.
//
//	@Summary		Reply in an AniList thread
//	@Description	Post a comment in a forum thread, or under one of its comments, as the linked user. Needs the replies-and-likes switch (403 otherwise); at most 10000 characters; a few per minute (429 beyond).
//	@Tags			Suggestions
//	@Accept			json
//	@Produce		json
//	@Param			id		path		int					true	"AniList thread id"
//	@Param			body	body		anilistReplyRequest	true	"The reply"
//	@Success		200		{object}	anilistReplyResponse
//	@Failure		400		{object}	ErrorResponse
//	@Failure		403		{object}	ErrorResponse	"replies and likes turned off in the settings"
//	@Failure		429		{object}	ErrorResponse
//	@Failure		502		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/anilist/threads/{id}/comments [post]
func (s *Server) handleAnilistReply(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id, _ := strconv.Atoi(r.PathValue("id"))
	if id <= 0 {
		writeErr(w, http.StatusBadRequest, "id required")
		return
	}
	var in anilistReplyRequest
	if !readJSON(w, r, &in) {
		return
	}
	// the text is the user's: it goes to AniList and nowhere else, never
	// into a log line or an error message
	text := strings.TrimSpace(in.Comment)
	if text == "" {
		writeErr(w, http.StatusBadRequest, "the reply is empty")
		return
	}
	if utf8.RuneCountInString(text) > anilist.ThreadCommentMax {
		writeErr(w, http.StatusBadRequest, "the reply is too long")
		return
	}
	if in.ParentCommentID < 0 {
		writeErr(w, http.StatusBadRequest, "invalid parent comment")
		return
	}
	_, token, ok := s.anilistWriter(w, u.ID, writeSocial)
	if !ok || !s.socialAllowed(w, u.ID) {
		return
	}
	cid, err := s.Anilist.SaveThreadComment(r.Context(), token, id, in.ParentCommentID, text)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	s.Anilist.InvalidateThread(id)
	writeJSON(w, http.StatusOK, anilistReplyResponse{ID: cid})
}

// anilistLikeRequest likes or unlikes a thread or a comment.
type anilistLikeRequest struct {
	ID   int    `json:"id"`
	Type string `json:"type" enums:"THREAD,THREAD_COMMENT"`
	// ThreadID is the thread a liked comment belongs to, so its cached pages
	// are dropped; the thread's own id for type THREAD
	ThreadID int `json:"threadId,omitempty"`
}

// anilistLikeResponse is the like's new state.
type anilistLikeResponse struct {
	Liked bool `json:"liked"`
	Likes int  `json:"likes"`
}

// handleAnilistLike toggles a like as the linked user.
//
//	@Summary		Like on AniList
//	@Description	Toggle the linked user's like on a forum thread or comment and return the new state. Needs the replies-and-likes switch (403 otherwise); rate-limited per user (429).
//	@Tags			Suggestions
//	@Accept			json
//	@Produce		json
//	@Param			body	body		anilistLikeRequest	true	"What to like"
//	@Success		200		{object}	anilistLikeResponse
//	@Failure		400		{object}	ErrorResponse
//	@Failure		403		{object}	ErrorResponse	"replies and likes turned off in the settings"
//	@Failure		429		{object}	ErrorResponse
//	@Failure		502		{object}	ErrorResponse
//	@Security		CookieAuth
//	@Router			/api/anilist/likes [post]
func (s *Server) handleAnilistLike(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var in anilistLikeRequest
	if !readJSON(w, r, &in) {
		return
	}
	if in.ID <= 0 || (in.Type != "THREAD" && in.Type != "THREAD_COMMENT") {
		writeErr(w, http.StatusBadRequest, "id and type THREAD or THREAD_COMMENT required")
		return
	}
	_, token, ok := s.anilistWriter(w, u.ID, writeSocial)
	if !ok || !s.socialAllowed(w, u.ID) {
		return
	}
	liked, likes, err := s.Anilist.ToggleLike(r.Context(), token, in.ID, in.Type)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	thread := in.ThreadID
	if in.Type == "THREAD" {
		thread = in.ID
	}
	if thread > 0 {
		s.Anilist.InvalidateThread(thread)
	}
	writeJSON(w, http.StatusOK, anilistLikeResponse{Liked: liked, Likes: likes})
}
