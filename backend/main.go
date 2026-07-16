// WeebSync — sync/download anime (private legal copies) from S/FTP servers.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/api"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/mailer"
	"github.com/ch4d1/weebsync/internal/push"
	"github.com/ch4d1/weebsync/internal/tmdb"
	"github.com/ch4d1/weebsync/internal/transfer"
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	addr := env("WEEBSYNC_ADDR", ":8080")
	dataDir := env("WEEBSYNC_DATA", "./data")
	downloadRoot := env("WEEBSYNC_DOWNLOADS", filepath.Join(dataDir, "downloads"))
	webDir := env("WEEBSYNC_WEB", "./web")

	for _, dir := range []string{dataDir, downloadRoot} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			slog.Error("mkdir", "dir", dir, "err", err)
			os.Exit(1)
		}
	}

	database, err := db.Open(filepath.Join(dataDir, "weebsync.db"))
	if err != nil {
		slog.Error("db open", "err", err)
		os.Exit(1)
	}
	defer database.Close()

	pushSvc, err := push.New(database)
	if err != nil {
		slog.Error("push init", "err", err)
		os.Exit(1)
	}

	srv := &api.Server{
		DB:           database,
		OIDC:         auth.NewManager(context.Background(), database),
		DownloadRoot: downloadRoot,
		Anilist:      anilist.New(database),
		Tmdb:         tmdb.New(database),
		Push:         pushSvc,
		Mail:         mailer.New(database),
	}
	srv.Transfers = transfer.NewManager(database, srv.DialServer, downloadRoot)
	srv.Transfers.OnFinished = func(d *transfer.Download) {
		name := path.Base(d.RemotePath)
		if d.Status == "done" {
			pushSvc.Notify(d.UserID, "Download fertig", name)
			srv.EmailNotify(d.UserID, "download_done", "Download fertig", name+" wurde heruntergeladen.")
		} else {
			pushSvc.Notify(d.UserID, "Download fehlgeschlagen", name+": "+d.Error)
			srv.EmailNotify(d.UserID, "download_failed", "Download fehlgeschlagen", name+": "+d.Error)
		}
	}
	srv.Anilist.TokenSource = srv.AnilistToken // linked-account bearer for API calls
	go srv.WatchLoop(context.Background())
	go srv.IndexLoop(context.Background())
	mux := http.NewServeMux()
	srv.Register(mux)
	mux.Handle("/", spaHandler(webDir))

	httpSrv := &http.Server{
		Addr:    addr,
		Handler: harden(mux),
		// Slowloris protection. No WriteTimeout: /api/events is a long-lived
		// SSE stream that a write deadline would sever.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	slog.Info("weebsync listening", "addr", addr, "downloads", downloadRoot)
	if err := httpSrv.ListenAndServe(); err != nil {
		slog.Error("listen", "err", err)
		os.Exit(1)
	}
}

// harden sets security headers on every response and rejects cross-origin
// state-changing requests (defense in depth beyond the SameSite=Lax cookie).
func harden(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		// self for scripts/styles; external cover/banner images (AniList, TMDB)
		// need https+data; SSE/fetch stay same-origin.
		h.Set("Content-Security-Policy",
			"default-src 'self'; img-src 'self' https: data:; "+
				"style-src 'self' 'unsafe-inline'; connect-src 'self'; "+
				"frame-ancestors 'none'; base-uri 'self'")
		if auth.IsHTTPS(r) {
			h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		switch r.Method {
		case http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch:
			if o := r.Header.Get("Origin"); o != "" {
				if u, err := url.Parse(o); err != nil || u.Host != r.Host {
					http.Error(w, `{"error":"cross-origin request blocked"}`, http.StatusForbidden)
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

// spaHandler serves the built frontend; unknown paths fall back to index.html
// so client-side routing works.
func spaHandler(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := filepath.Join(dir, filepath.Clean("/"+r.URL.Path))
		if info, err := os.Stat(path); err != nil || info.IsDir() {
			http.ServeFile(w, r, filepath.Join(dir, "index.html"))
			return
		}
		fs.ServeHTTP(w, r)
	})
}
