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
	"slices"
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

	mounts, mountsKnown := readMounts()

	// the state dir: WEEBSYNC_DATA as set, else /config when something is
	// mounted there (linuxserver.io layout), else /data as before
	dir := get("WEEBSYNC_DATA")
	if dir == "" {
		dir = defaultDir
		if mountsKnown && slices.Contains(mounts, configDir) {
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
		roots := filepath.SplitList(get("WEEBSYNC_DOWNLOADS"))
		if len(roots) == 0 {
			roots = []string{filepath.Join(dir, "downloads")}
		}
		if !mountsKnown {
			fmt.Fprintln(os.Stderr, "entrypoint: /proc/self/mountinfo is unreadable, handing over only the top of", dir)
		}
		if err := chownTree(dir, roots, mounts, mountsKnown, uid, gid, os.Lchown); err != nil {
			return fmt.Errorf("data dir %s: %w (the container needs CHOWN and DAC_READ_SEARCH, see docs/configuration.md)", dir, err)
		}
		if err := drop(uid, gid); err != nil {
			return fmt.Errorf("drop to %d:%d: %w (the container needs SETUID and SETGID, see docs/configuration.md)", uid, gid, err)
		}
	} else if get("PUID") != "" || get("PGID") != "" {
		fmt.Fprintln(os.Stderr, "entrypoint: PUID/PGID ignored, the container does not start as root")
	}

	return syscall.Exec(app, append([]string{app}, args...), env)
}

// readMounts lists the mount points of this container. ok is false when
// the list cannot be read.
func readMounts() (mounts []string, ok bool) {
	b, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return nil, false
	}
	return parseMountinfo(string(b)), true
}

// parseMountinfo returns the mount points (5th field) of mountinfo text, with
// the octal escapes (\040 for a space) undone.
func parseMountinfo(info string) []string {
	var out []string
	for _, line := range strings.Split(info, "\n") {
		f := strings.Fields(line)
		if len(f) > 4 {
			out = append(out, unescapeMount(f[4]))
		}
	}
	return out
}

func unescapeMount(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+4 <= len(s) {
			if n, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// fileEnv resolves every FILE__NAME=/path to NAME=<content of path>. The file
// wins over a NAME that is also set directly.
func fileEnv(environ []string) ([]string, error) {
	fromFile := map[string]string{}
	for _, kv := range environ {
		k, v, _ := strings.Cut(kv, "=")
		name, ok := strings.CutPrefix(k, "FILE__")
		if !ok || name == "" {
			continue
		}
		b, err := os.ReadFile(v)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", k, err)
		}
		fromFile[name] = strings.TrimRight(string(b), "\r\n")
	}
	out := make([]string, 0, len(environ))
	for _, kv := range environ {
		k, _, _ := strings.Cut(kv, "=")
		if _, over := fromFile[k]; over {
			continue
		}
		if name, ok := strings.CutPrefix(k, "FILE__"); ok && name != "" {
			continue
		}
		out = append(out, kv)
	}
	for k, v := range fromFile {
		out = append(out, k+"="+v)
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
	if n == 0 {
		return 0, fmt.Errorf("%s=0 would run the app as root; use the id of an unprivileged user (or leave it unset for %d)", name, defaultID)
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

// chownTree gives dir and everything below it to uid:gid through chown. It
// changes only what differs, never follows symlinks (it chowns the link
// itself), never enters or touches a mount point below dir (a media volume,
// even one on the same file system) and does not descend into the download
// roots: those hold the media, only their top directory is handed over. When
// the mount list is unknown (mountsKnown false) it hands over dir alone.
func chownTree(dir string, skip, mounts []string, mountsKnown bool, uid, gid int, chown func(string, int, int) error) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	// the state dir may be given through a symlink; WalkDir does not follow
	// a symlink root
	dir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return err
	}
	set := func(paths []string) map[string]bool {
		m := map[string]bool{}
		for _, s := range paths {
			a, err := filepath.Abs(s)
			if err != nil {
				continue
			}
			if r, err := filepath.EvalSymlinks(a); err == nil {
				a = r
			}
			m[filepath.Clean(a)] = true
		}
		return m
	}
	skipped, mounted := set(skip), set(mounts)
	return filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if p != dir && mounted[p] {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if st, ok := info.Sys().(*syscall.Stat_t); ok && (int(st.Uid) != uid || int(st.Gid) != gid) {
			if err := chown(p, uid, gid); err != nil {
				return err
			}
		}
		if d.IsDir() && (!mountsKnown || (p != dir && skipped[p])) {
			return filepath.SkipDir
		}
		return nil
	})
}
