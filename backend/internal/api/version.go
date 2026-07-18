package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/netguard"
	"github.com/ch4d1/weebsync/internal/version"
)

type versionInfo struct {
	Version         string `json:"version"`
	Channel         string `json:"channel"` // "stable" | "dev"
	Commit          string `json:"commit"`
	Repo            string `json:"repo"`
	UpdateCheck     bool   `json:"updateCheck"`     // instance setting: is the check enabled
	UpdateAvailable bool   `json:"updateAvailable"` // a newer image exists upstream
	Latest          string `json:"latest"`          // latest tag (stable) or short sha (dev)
	URL             string `json:"url"`             // where to see/get the update
}

// handleVersion returns build metadata and, if enabled, a cached best-effort
// check against GitHub for whether a newer main-image exists.
//
// @Summary      Build and update info
// @Description  Returns build metadata and, when the update check is enabled, a cached best-effort comparison against the upstream repo.
// @Tags         Version
// @Produce      json
// @Success      200  {object}  versionInfo
// @Failure      401  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/version [get]
func (s *Server) handleVersion(w http.ResponseWriter, r *http.Request) {
	info := versionInfo{
		Version:     version.Version,
		Channel:     version.Channel,
		Commit:      version.Commit,
		Repo:        version.Repo,
		UpdateCheck: db.Setting(s.DB, "update_check") != "0", // default on
	}
	if info.UpdateCheck && info.Repo != "" {
		s.fillUpdate(&info)
	}
	writeJSON(w, http.StatusOK, info)
}

// fillUpdate compares the running build against the upstream repo. Stable tracks
// the latest release tag; dev tracks the tip of main. Best-effort: any error
// leaves updateAvailable false. Result cached 6h in the shared KV cache.
func (s *Server) fillUpdate(info *versionInfo) {
	cacheKey := "update:" + info.Channel + ":" + info.Repo
	if payload, ok := s.cacheGet(cacheKey, 6*time.Hour); ok {
		var cached struct {
			Latest, URL string
			Available   bool
		}
		if json.Unmarshal([]byte(payload), &cached) == nil {
			info.Latest, info.URL, info.UpdateAvailable = cached.Latest, cached.URL, cached.Available
			return
		}
	}

	client := netguard.Client(5 * time.Second)
	if info.Channel == "stable" {
		var rel struct {
			TagName string `json:"tag_name"`
			HTMLURL string `json:"html_url"`
		}
		if fetchJSON(client, "https://api.github.com/repos/"+info.Repo+"/releases/latest", &rel) == nil && rel.TagName != "" {
			info.Latest = rel.TagName
			info.URL = rel.HTMLURL
			info.UpdateAvailable = rel.TagName != info.Version
		}
	} else {
		var commit struct {
			SHA string `json:"sha"`
		}
		if fetchJSON(client, "https://api.github.com/repos/"+info.Repo+"/commits/main", &commit) == nil && commit.SHA != "" {
			short := commit.SHA
			if len(short) > 7 {
				short = short[:7]
			}
			info.Latest = short
			info.URL = "https://github.com/" + info.Repo + "/commits/main"
			info.UpdateAvailable = info.Commit != "" && commit.SHA != info.Commit
		}
	}

	payload, _ := json.Marshal(struct {
		Latest, URL string
		Available   bool
	}{info.Latest, info.URL, info.UpdateAvailable})
	s.cacheSet(cacheKey, string(payload))
}

func fetchJSON(c *http.Client, url string, v any) error {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("github: %s", resp.Status)
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

// updateCheckResponse echoes the update-check toggle state.
type updateCheckResponse struct {
	UpdateCheck bool `json:"updateCheck"`
}

// handleUpdateCheckToggle enables/disables the upstream update check (admin).
//
// @Summary      Toggle upstream update check
// @Description  Enables or disables the upstream update check (admin only).
// @Tags         Version
// @Accept       json
// @Produce      json
// @Param        request  body      object  true  "enabled flag"
// @Success      200  {object}  updateCheckResponse
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      415  {object}  ErrorResponse
// @Security     CookieAuth
// @Router       /api/version/update-check [post]
func (s *Server) handleUpdateCheckToggle(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Enabled bool `json:"enabled"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	db.SetSetting(s.DB, "update_check", map[bool]string{true: "1", false: "0"}[in.Enabled])
	writeJSON(w, http.StatusOK, updateCheckResponse{UpdateCheck: in.Enabled})
}
