package transfer

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// LocalPath is a path opened beneath one configured media root. Filesystem
// operations must use Root and Name; Abs is only for display and persistence.
type LocalPath struct {
	Root *os.Root
	Name string
	Abs  string
}

func (p *LocalPath) Close() error { return p.Root.Close() }

// OpenLocal selects the longest matching configured root. os.Root supplies the
// actual boundary: relative in-root symlinks work, absolute and escaping links
// fail at the filesystem operation.
func OpenLocal(roots []string, name string) (*LocalPath, error) {
	root, rel, abs, err := resolveLocal(roots, name)
	if err != nil {
		return nil, err
	}
	r, err := os.OpenRoot(root)
	if err != nil {
		return nil, err
	}
	return &LocalPath{Root: r, Name: rel, Abs: abs}, nil
}

func resolveLocal(roots []string, name string) (root, rel, abs string, err error) {
	if len(roots) == 0 {
		return "", "", "", errors.New("no local roots configured")
	}

	clean := filepath.Clean(name)
	if !filepath.IsAbs(clean) {
		// legacy relative spelling: either a root-less form of an absolute
		// root ("mnt/nas/x" for /mnt/nas) or a path under the primary root
		rootless := filepath.Clean(string(filepath.Separator) + clean)
		matched := false
		for _, candidate := range roots {
			if r, rerr := filepath.Rel(filepath.Clean(candidate), rootless); rerr == nil && filepath.IsLocal(r) {
				matched = true
				break
			}
		}
		if matched {
			clean = rootless
		} else {
			if !filepath.IsLocal(clean) {
				return "", "", "", errors.New("path outside allowed roots")
			}
			clean = filepath.Join(filepath.Clean(roots[0]), clean)
		}
	}
	// absolute now: the longest matching root wins so nested roots resolve to
	// the same handle regardless of how the caller spelled the path
	for _, candidate := range roots {
		candidate = filepath.Clean(candidate)
		r, err := filepath.Rel(candidate, clean)
		if err == nil && filepath.IsLocal(r) && (root == "" || len(candidate) > len(root)) {
			root, rel = candidate, r
		}
	}
	if root == "" {
		rel = strings.TrimPrefix(clean, string(filepath.Separator))
		if rel == "" {
			rel = "."
		}
		root = filepath.Clean(roots[0])
	}
	return root, rel, filepath.Join(root, rel), nil
}
