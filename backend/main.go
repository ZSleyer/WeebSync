// WeebSync - sync/download anime (private legal copies) from S/FTP servers.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/ch4d1/weebsync/internal/anilist"
	"github.com/ch4d1/weebsync/internal/api"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
	"github.com/ch4d1/weebsync/internal/mailer"
	"github.com/ch4d1/weebsync/internal/push"
	"github.com/ch4d1/weebsync/internal/remote/pool"
	"github.com/ch4d1/weebsync/internal/secret"
	"github.com/ch4d1/weebsync/internal/tmdb"
	"github.com/ch4d1/weebsync/internal/transfer"
	"github.com/ch4d1/weebsync/internal/tvdb"
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// @title WeebSync API
// @version 1.0
// @description Self-hosted S/FTP anime and media sync: servers, catalog, downloads, watches, suggestions and auth. The interactive docs are served only by local dev builds.
// @BasePath /
//
// @securityDefinitions.apikey CookieAuth
// @in cookie
// @name weebsync_session
//
// @securityDefinitions.apikey BearerAuth
// @in header
// @name Authorization
func main() {
	addr := env("WEEBSYNC_ADDR", ":8080")

	// docker HEALTHCHECK entrypoint: distroless has no shell/curl, so the
	// binary probes itself.
	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		os.Exit(healthcheck(addr))
	}

	dataDir := env("WEEBSYNC_DATA", "./data")
	// WEEBSYNC_DOWNLOADS is a ":"-separated allowlist of local roots (arbitrary
	// media mounts, e.g. "/media:/config"). The first is the primary download
	// dir; a target path may live under any of them.
	localRoots := filepath.SplitList(env("WEEBSYNC_DOWNLOADS", filepath.Join(dataDir, "downloads")))
	downloadRoot := localRoots[0]
	webDir := env("WEEBSYNC_WEB", "./web")

	for _, dir := range append([]string{dataDir}, localRoots...) {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			slog.Error("mkdir", "dir", dir, "err", err)
			os.Exit(1)
		}
	}

	// env override or auto-generated key file; fail fast on unreadable key
	if err := secret.Init(dataDir); err != nil {
		slog.Error("secret init", "err", err)
		os.Exit(1)
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
		LocalRoots:   localRoots,
		Anilist:      anilist.New(database),
		Tmdb:         tmdb.New(database),
		Tvdb:         tvdb.New(database),
		Push:         pushSvc,
		Mail:         mailer.New(database),
		Conns:        pool.New(),
	}
	srv.Transfers = transfer.NewManager(database, srv.DialServer, downloadRoot)
	srv.Transfers.Roots = localRoots
	srv.Transfers.OnFinished = srv.NotifyDownloadFinished
	srv.Anilist.TokenSource = srv.AnilistToken // linked-account bearer for API calls

	rootCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go srv.WatchLoop(rootCtx)
	go srv.IndexLoop(rootCtx)
	mux := http.NewServeMux()
	srv.Register(mux)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := database.PingContext(r.Context()); err != nil {
			http.Error(w, "db: "+err.Error(), http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte("ok"))
	})
	mux.Handle("/", spaHandler(webDir))

	httpSrv := &http.Server{
		Addr:    addr,
		Handler: harden(mux),
		// request contexts inherit rootCtx: on SIGTERM the SSE streams
		// (/api/events) end immediately, so Shutdown below returns fast
		BaseContext: func(net.Listener) context.Context { return rootCtx },
		// Slowloris protection. No WriteTimeout: /api/events is a long-lived
		// SSE stream that a write deadline would sever.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	slog.Info("weebsync listening", "addr", addr, "downloads", downloadRoot)
	go func() {
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("listen", "err", err)
			os.Exit(1)
		}
	}()

	<-rootCtx.Done()
	slog.Info("shutting down")
	// docker's default grace is 10s before SIGKILL; stay under it
	shutCtx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(shutCtx); err != nil {
		httpSrv.Close()
	}
	srv.Transfers.Shutdown(shutCtx) // requeue active downloads, wait for workers
	srv.Conns.Close()               // tear down pooled SSH/FTP connections
	slog.Info("shutdown complete")
}

// healthcheck probes the local /healthz endpoint; exit code for HEALTHCHECK.
func healthcheck(addr string) int {
	if _, port, err := net.SplitHostPort(addr); err == nil {
		addr = "127.0.0.1:" + port
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://" + addr + "/healthz")
	if err != nil {
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

// harden sets security headers on every response. CSRF is covered by the
// application/json requirement in readJSON (a cross-site form can't set that
// content-type without a CORS preflight the server never allows) plus the
// SameSite=Lax session cookie (not sent on cross-site POST). An Origin==Host
// check was intentionally dropped: it breaks legitimate proxied setups (dev
// Vite proxy, reverse proxies that rewrite Host but not Origin).
func harden(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		// self for scripts/styles; external cover/banner images (AniList, TMDB)
		// need https+data; SSE/fetch stay same-origin. frame-src names the one
		// origin the detail dialog embeds (the trailer player) - without it the
		// iframe falls back to default-src and is blocked.
		h.Set("Content-Security-Policy",
			"default-src 'self'; img-src 'self' https: data:; "+
				"style-src 'self' 'unsafe-inline'; connect-src 'self'; "+
				"frame-src https://www.youtube-nocookie.com; "+
				"frame-ancestors 'none'; base-uri 'self'")
		if auth.IsHTTPS(r) {
			h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}

// spaHandler serves the built frontend; unknown paths fall back to index.html
// so client-side routing works.
func spaHandler(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// unknown API routes must not fall back to the SPA index (that would
		// answer 200 HTML for a missing endpoint); 404 them instead.
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		path := filepath.Join(dir, filepath.Clean("/"+r.URL.Path))
		if info, err := os.Stat(path); err != nil || info.IsDir() {
			http.ServeFile(w, r, filepath.Join(dir, "index.html"))
			return
		}
		// the bundles are content-hashed and may be cached forever, but these
		// two keep their name across releases - a stale service worker means
		// push notifications silently stop working
		switch r.URL.Path {
		case "/sw.js", "/manifest.webmanifest":
			w.Header().Set("Cache-Control", "no-cache")
		}
		fs.ServeHTTP(w, r)
	})
}
