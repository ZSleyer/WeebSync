//go:build !linux

package main

import "os"

// noEcho: ponytail: only Linux (the image) hides the typed password; elsewhere
// it shows, pipe it in instead.
func noEcho(*os.File) (restore func()) { return func() {} }
