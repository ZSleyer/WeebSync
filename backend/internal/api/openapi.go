package api

import (
	"encoding/json"
	"io/fs"
	"net/http"

	"github.com/ch4d1/weebsync/docs"
	"github.com/ch4d1/weebsync/internal/version"
)

// handleOpenAPISpec serves the embedded OpenAPI 3.1 spec with the running
// build's version patched into info.version. Registered only on dev builds.
func (s *Server) handleOpenAPISpec(w http.ResponseWriter, r *http.Request) {
	var spec map[string]any
	if err := json.Unmarshal(docs.SwaggerJSON, &spec); err != nil {
		writeErr(w, http.StatusInternalServerError, "spec unavailable")
		return
	}
	if info, ok := spec["info"].(map[string]any); ok {
		info["version"] = version.Version
	}
	writeJSON(w, http.StatusOK, spec)
}

// swaggerUIHandler serves the vendored Swagger UI assets under /api/docs/.
func swaggerUIHandler() http.Handler {
	sub, _ := fs.Sub(docs.SwaggerUI, "swaggerui")
	return http.StripPrefix("/api/docs/", http.FileServer(http.FS(sub)))
}

// devDocsEnabled reports whether the interactive API docs should be served -
// builds made on a developer's machine only, never anything shipped.
//
// The test is the absence of build metadata, not the channel name: CI publishes
// a per-push :dev image the add-on follows, so "dev" no longer implies "runs on
// a laptop". Only a local `go run`/`go build` leaves Commit empty, because
// every pipeline passes it through -ldflags.
func devDocsEnabled() bool { return version.Commit == "" }
