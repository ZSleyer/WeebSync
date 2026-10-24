package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/netguard"
	"github.com/ch4d1/weebsync/internal/version"
)

type versionInfo struct {
	Version         string `json:"version"`
	Channel         string `json:"channel"` // "stable" | "rc" | "nightly" | "dev"
	Commit          string `json:"commit"`
	Repo            string `json:"repo"`
	UpdateCheck     bool   `json:"updateCheck"`     // instance setting: is the check enabled
	UpdateAvailable bool   `json:"updateAvailable"` // a newer image exists upstream
	Latest          string `json:"latest"`          // latest tag (stable) or short sha of the newest build (nightly, dev)
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

// fillUpdate compares the running build against what upstream has published
// for its channel: stable the latest release, rc the newest release or
// candidate, nightly and dev the commit of the
// newest workflow run that built their image. Not the tip of main - a nightly
// is built once a day and a dev image only once the push's CI is green, so
// main's tip announced builds that did not exist (a nightly instance was
// "outdated" all day long). Best-effort: any error leaves updateAvailable
// false. Result cached 6h in the shared KV cache.
func (s *Server) fillUpdate(info *versionInfo) {
	// the build is part of the key: the answer "a newer build is out" belongs
	// to the binary that asked. Without it the row the old binary wrote in
	// the minutes before a deploy outlived the deploy, and the new build
	// reported itself outdated for up to six hours
	cacheKey := "update:" + info.Channel + ":" + info.Repo + ":" + info.Version + ":" + info.Commit
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
	if info.Channel == "stable" || info.Channel == "rc" {
		type release struct {
			TagName string `json:"tag_name"`
			HTMLURL string `json:"html_url"`
		}
		var rel release
		var err error
		err = fetchJSON(client, "https://api.github.com/repos/"+info.Repo+"/releases/latest", &rel)
		// releases/latest skips pre-releases: a candidate compared against it
		// saw the previous month's release as its update. Unless that is the
		// release this candidate leads to, a candidate looks at the newest
		// release of any kind. Not the list alone: it is ordered by the
		// commit's date, and the final release shares its last candidate's
		// commit, so either could come first
		if info.Channel == "rc" && (err != nil || !strings.HasPrefix(info.Version, rel.TagName+"-rc")) {
			var rels []release
			rel = release{}
			if err = fetchJSON(client, "https://api.github.com/repos/"+info.Repo+"/releases?per_page=1", &rels); err == nil && len(rels) > 0 {
				rel = rels[0]
			}
		}
		if err == nil && rel.TagName != "" {
			info.Latest = rel.TagName
			info.URL = rel.HTMLURL
			info.UpdateAvailable = rel.TagName != info.Version
		}
	} else if wf := buildWorkflow(info.Channel); wf != "" && info.Commit != "" {
		var runs struct {
			Runs []struct {
				HeadSHA string `json:"head_sha"`
			} `json:"workflow_runs"`
		}
		if fetchJSON(client, "https://api.github.com/repos/"+info.Repo+"/actions/workflows/"+wf, &runs) == nil &&
			len(runs.Runs) > 0 && runs.Runs[0].HeadSHA != "" {
			sha := runs.Runs[0].HeadSHA
			info.Latest = sha[:min(7, len(sha))]
			// what changed between the running build and the new one
			info.URL = "https://github.com/" + info.Repo + "/compare/" + info.Commit + "..." + sha
			info.UpdateAvailable = sha != info.Commit
		}
	}

	payload, _ := json.Marshal(struct {
		Latest, URL string
		Available   bool
	}{info.Latest, info.URL, info.UpdateAvailable})
	s.cacheSet(cacheKey, string(payload))
}

// buildWorkflow is the runs query for the newest successful build of a
// channel's image: ci.yml publishes :dev from a green push to main,
// nightly.yml publishes :nightly. "" for a channel without one.
func buildWorkflow(channel string) string {
	switch channel {
	case "dev":
		return "ci.yml/runs?branch=main&event=push&status=success&per_page=1"
	case "nightly":
		return "nightly.yml/runs?branch=main&status=success&per_page=1"
	}
	return ""
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
	return json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(v)
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
	if err := db.SetSetting(s.DB, "update_check", map[bool]string{true: "1", false: "0"}[in.Enabled]); err != nil {
		dbErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, updateCheckResponse{UpdateCheck: in.Enabled})
}
