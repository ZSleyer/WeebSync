//go:build linux

package main

import (
	"os"

	"golang.org/x/sys/unix"
)

// noEcho stops the terminal from showing what is typed and returns what puts
// it back. Not a terminal after all: nothing to do.
func noEcho(f *os.File) (restore func()) {
	fd := int(f.Fd())
	t, err := unix.IoctlGetTermios(fd, unix.TCGETS)
	if err != nil {
		return func() {}
	}
	old := *t
	t.Lflag &^= unix.ECHO
	if unix.IoctlSetTermios(fd, unix.TCSETS, t) != nil {
		return func() {}
	}
	return func() { unix.IoctlSetTermios(fd, unix.TCSETS, &old) }
}
