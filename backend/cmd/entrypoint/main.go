// Command entrypoint is the image's init: it starts /weebsync the way the
// linuxserver.io images start their apps, without a shell (the runtime image
// is distroless) and without an init system.
//
//   - FILE__NAME=/path sets NAME to the content of that file (Docker secrets).
//   - UMASK (octal) sets the umask of the app.
//   - The state dir is WEEBSYNC_DATA; unset, it is /config when a volume is
//     mounted there and /data (the layout of earlier images) otherwise.
//   - Started as root, it takes PUID/PGID (default 65532, the image's former
//     fixed user), fixes the ownership of the data dir, drops to that user and
//     executes the app. Only the data dir is touched, never the media mounts.
//   - Started as any other user (docker --user, compose user:) it changes
//     nothing and executes the app as that user, as the image always did.
package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

const (
	app        = "/weebsync"
	defaultID  = 65532
	defaultDir = "/data"
	configDir  = "/config"
)

func main() {
	if err := run(os.Args[1:], os.Environ()); err != nil {
		fmt.Fprintln(os.Stderr, "entrypoint:", err)
		os.Exit(1)
	}
}

func run(args, environ []string) error {
	env, err := fileEnv(environ)
	if err != nil {
		return err
	}
	get := func(k string) string {
		for _, kv := range env {
			if v, ok := strings.CutPrefix(kv, k+"="); ok {
				return v
			}
		}
		return ""
	}

	if s := get("UMASK"); s != "" {
		umask, err := parseUmask(s)
		if err != nil {
			return err
		}
		syscall.Umask(umask)
	}

	// the state dir: WEEBSYNC_DATA as set, else /config when something is
	// mounted there (linuxserver.io layout), else /data as before
	dir := get("WEEBSYNC_DATA")
	if dir == "" {
		dir = defaultDir
		if isMount(configDir) {
			dir = configDir
		}
		env = append(env, "WEEBSYNC_DATA="+dir)
	}

	if os.Geteuid() == 0 {
		uid, err := parseID("PUID", get("PUID"))
		if err != nil {
			return err
		}
		gid, err := parseID("PGID", get("PGID"))
		if err != nil {
			return err
		}
		if uid != 0 {
			roots := filepath.SplitList(get("WEEBSYNC_DOWNLOADS"))
			if len(roots) == 0 {
				roots = []string{filepath.Join(dir, "downloads")}
			}
			if err := chownTree(dir, roots, uid, gid); err != nil {
				return fmt.Errorf("data dir %s: %w (the container needs CHOWN and DAC_READ_SEARCH, see docs/configuration.md)", dir, err)
			}
			if err := drop(uid, gid); err != nil {
				return fmt.Errorf("drop to %d:%d: %w (the container needs SETUID and SETGID, see docs/configuration.md)", uid, gid, err)
			}
		}
	} else if get("PUID") != "" || get("PGID") != "" {
		fmt.Fprintln(os.Stderr, "entrypoint: PUID/PGID ignored, the container does not start as root")
	}

	return syscall.Exec(app, append([]string{app}, args...), env)
}

// isMount reports whether path is a mount point of this container.
func isMount(path string) bool {
	b, err := os.ReadFile("/proc/self/mountinfo")
	return err == nil && inMountinfo(string(b), path)
}

// inMountinfo looks for path as the mount point (5th field) in mountinfo text.
func inMountinfo(info, path string) bool {
	for _, line := range strings.Split(info, "\n") {
		f := strings.Fields(line)
		if len(f) > 4 && f[4] == path {
			return true
		}
	}
	return false
}

// fileEnv resolves every FILE__NAME=/path to NAME=<content of path>.
func fileEnv(environ []string) ([]string, error) {
	out := make([]string, 0, len(environ))
	for _, kv := range environ {
		k, v, _ := strings.Cut(kv, "=")
		name, ok := strings.CutPrefix(k, "FILE__")
		if !ok || name == "" {
			out = append(out, kv)
			continue
		}
		b, err := os.ReadFile(v)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", k, err)
		}
		out = append(out, name+"="+strings.TrimRight(string(b), "\r\n"))
	}
	return out, nil
}

func parseID(name, s string) (int, error) {
	if s == "" {
		return defaultID, nil
	}
	n, err := strconv.ParseUint(s, 10, 31)
	if err != nil {
		return 0, fmt.Errorf("%s=%q is not a numeric id", name, s)
	}
	return int(n), nil
}

func parseUmask(s string) (int, error) {
	n, err := strconv.ParseUint(s, 8, 32)
	if err != nil || n > 0o777 {
		return 0, fmt.Errorf("UMASK=%q is not an octal mask like 022", s)
	}
	return int(n), nil
}

// drop switches to uid:gid. The groups the container was started with
// (compose group_add, for the GPU render nodes) stay, gid joins them, root's
// group 0 goes.
func drop(uid, gid int) error {
	groups, err := syscall.Getgroups()
	if err != nil {
		return err
	}
	// root's own group must not follow into the unprivileged user
	keep := []int{gid}
	for _, g := range groups {
		if g != 0 && g != gid {
			keep = append(keep, g)
		}
	}
	if err := syscall.Setgroups(keep); err != nil {
		return err
	}
	if err := syscall.Setgid(gid); err != nil {
		return err
	}
	return syscall.Setuid(uid)
}

// chownTree gives dir and everything below it to uid:gid. It changes only what
// differs, never follows symlinks, never crosses into another file system (a
// media mount inside the data dir) and does not descend into the download
// roots: those hold the media, only their top directory is handed over.
func chownTree(dir string, skip []string, uid, gid int) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	// /config is a symlink to /data in the image; WalkDir does not follow a
	// symlink root
	dir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return err
	}
	skipped := map[string]bool{}
	for _, s := range skip {
		a, err := filepath.Abs(s)
		if err != nil {
			continue
		}
		if r, err := filepath.EvalSymlinks(a); err == nil {
			a = r
		}
		skipped[filepath.Clean(a)] = true
	}
	var dev uint64
	return filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		st, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			return nil
		}
		if p == dir {
			dev = uint64(st.Dev)
		} else if uint64(st.Dev) != dev {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if int(st.Uid) != uid || int(st.Gid) != gid {
			if err := os.Lchown(p, uid, gid); err != nil {
				return err
			}
		}
		if d.IsDir() && p != dir && skipped[p] {
			return filepath.SkipDir
		}
		return nil
	})
}
