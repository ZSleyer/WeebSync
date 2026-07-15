// WeebSync — sync/download anime (private legal copies) from S/FTP servers.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"

	"github.com/ch4d1/weebsync/internal/api"
	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
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

	oidcProvider, err := auth.NewOIDCFromEnv(context.Background())
	if err != nil {
		slog.Error("oidc init", "err", err)
		os.Exit(1)
	}

	srv := &api.Server{DB: database, OIDC: oidcProvider, DownloadRoot: downloadRoot}
	mux := http.NewServeMux()
	srv.Register(mux)
	mux.Handle("/", spaHandler(webDir))

	slog.Info("weebsync listening", "addr", addr, "downloads", downloadRoot)
	if err := http.ListenAndServe(addr, mux); err != nil {
		slog.Error("listen", "err", err)
		os.Exit(1)
	}
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
