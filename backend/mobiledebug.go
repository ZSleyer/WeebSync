//go:build mobiledebug

package main

// A debugging aid for phones, built only with `-tags mobiledebug`: the
// default build, every CI image and every release leave this file out.
// It adds a script to the app's page that shows and reports the viewport
// numbers of the device, and takes screenshots picked on the phone - both
// land in <data>/mobile-debug/ for reading on the development machine.

import (
	_ "embed"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

//go:embed mobiledebug/diag.js
var mobileDebugScript []byte

func mobileDebug(mux *http.ServeMux, dataDir, webDir string, web http.Handler) http.Handler {
	dir := filepath.Join(dataDir, "mobile-debug")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		slog.Error("mobile debug", "err", err)
		return web
	}
	slog.Warn("MOBILE DEBUG BUILD: diagnostics overlay and screenshot uploads are on - never deploy this binary", "dir", dir)

	mux.HandleFunc("GET /mobile-debug.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(mobileDebugScript)
	})
	mux.HandleFunc("POST /mobile-debug/report", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(io.LimitReader(r.Body, 16<<10))
		f, err := os.OpenFile(filepath.Join(dir, "reports.txt"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			http.Error(w, "report not stored", http.StatusInternalServerError)
			return
		}
		defer f.Close()
		fmt.Fprintf(f, "=== %s\n%s\n\n", time.Now().Format("15:04:05"), body)
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /mobile-debug/upload", func(w http.ResponseWriter, r *http.Request) {
		ext := ".png"
		if strings.Contains(r.Header.Get("Content-Type"), "jpeg") {
			ext = ".jpg"
		}
		name := filepath.Join(dir, "shot-"+time.Now().Format("150405.000")+ext)
		f, err := os.Create(name)
		if err != nil {
			http.Error(w, "upload not stored", http.StatusInternalServerError)
			return
		}
		n, err := io.Copy(f, io.LimitReader(r.Body, 30<<20))
		f.Close()
		if err != nil {
			http.Error(w, "upload failed", http.StatusBadRequest)
			return
		}
		slog.Info("mobile debug upload", "file", name, "bytes", n)
		w.WriteHeader(http.StatusNoContent)
	})

	// the app's page with the script in it, wherever the SPA would answer
	// with index.html
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if r.Method != http.MethodGet || strings.HasPrefix(p, "/assets/") || strings.HasPrefix(p, "/api/") {
			web.ServeHTTP(w, r)
			return
		}
		if info, err := os.Stat(filepath.Join(webDir, filepath.Clean("/"+p))); p != "/" && p != "/index.html" && err == nil && !info.IsDir() {
			web.ServeHTTP(w, r)
			return
		}
		page, err := os.ReadFile(filepath.Join(webDir, "index.html"))
		if err != nil {
			web.ServeHTTP(w, r)
			return
		}
		page = []byte(strings.Replace(string(page), "</head>", `<script src="/mobile-debug.js" defer></script></head>`, 1))
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(page)
	})
}
