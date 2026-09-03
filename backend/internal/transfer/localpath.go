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
		rootless := filepath.Clean(string(filepath.Separator) + clean)
		for _, candidate := range roots {
			candidate = filepath.Clean(candidate)
			r, rerr := filepath.Rel(candidate, rootless)
			if rerr == nil && filepath.IsLocal(r) && (root == "" || len(candidate) > len(root)) {
				root, rel, clean = candidate, r, rootless
			}
		}
	}
	if filepath.IsAbs(clean) {
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
	} else if root == "" {
		rel = filepath.Clean(strings.TrimPrefix(name, string(filepath.Separator)))
		if !filepath.IsLocal(rel) {
			return "", "", "", errors.New("path outside allowed roots")
		}
		root = filepath.Clean(roots[0])
	}
	if rel == "" {
		rel = "."
	}
	return root, rel, filepath.Join(root, rel), nil
}
