//go:build !mobiledebug

package main

import "net/http"

// Without -tags mobiledebug - every image and release - the page is served
// as it is (see mobiledebug.go).
func mobileDebug(_ *http.ServeMux, _, _ string, web http.Handler) http.Handler { return web }
