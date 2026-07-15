// Command ftpindex walks a remote SFTP/FTP server read-only over a single
// connection and writes a flat JSON index of the directory structure.
// Password is taken from the FTPINDEX_PASS environment variable only.
//
// Usage:
//
//	FTPINDEX_PASS=... go run ./cmd/ftpindex -host example.com -port 2222 -user alice -root / -out index.json
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/ch4d1/weebsync/internal/remote"
)

type indexEntry struct {
	Path string `json:"path"`
	Dir  bool   `json:"dir,omitempty"`
	Size int64  `json:"size,omitempty"`
}

type index struct {
	GeneratedAt time.Time    `json:"generatedAt"`
	Root        string       `json:"root"`
	Entries     []indexEntry `json:"entries"`
}

func main() {
	host := flag.String("host", "", "server host (required)")
	port := flag.Int("port", 22, "server port")
	user := flag.String("user", "", "username (required)")
	proto := flag.String("proto", "sftp", "protocol: sftp | ftps | ftp")
	root := flag.String("root", "/", "directory to index")
	out := flag.String("out", "index.json", "output file")
	depth := flag.Int("depth", 10, "max recursion depth")
	maxEntries := flag.Int("max", 200000, "max total entries")
	pace := flag.Duration("pace", 150*time.Millisecond, "pause between directory listings")
	flag.Parse()

	pass := os.Getenv("FTPINDEX_PASS")
	if *host == "" || *user == "" || pass == "" {
		fmt.Fprintln(os.Stderr, "required: -host, -user and env FTPINDEX_PASS")
		flag.Usage()
		os.Exit(2)
	}

	// exactly ONE connection, reused for the whole sequential walk
	client, err := remote.Dial(remote.Config{
		Protocol: *proto, Host: *host, Port: *port, Username: *user, Password: pass,
		OnHostKey: func(string) {}, // TOFU, key not persisted for a one-shot tool
	})
	if err != nil {
		log.Fatalf("dial: %v", err)
	}
	defer client.Close()

	idx := index{GeneratedAt: time.Now().UTC(), Root: *root}
	var walk func(path string, d int) error
	walk = func(path string, d int) error {
		if d > *depth || len(idx.Entries) >= *maxEntries {
			return nil
		}
		entries, err := client.List(path)
		if err != nil {
			log.Printf("list %s: %v (skipped)", path, err)
			return nil
		}
		time.Sleep(*pace)
		for _, e := range entries {
			if len(idx.Entries) >= *maxEntries {
				log.Printf("entry limit %d reached, truncating", *maxEntries)
				return nil
			}
			idx.Entries = append(idx.Entries, indexEntry{Path: e.Path, Dir: e.IsDir, Size: e.Size})
			if e.IsDir {
				if err := walk(e.Path, d+1); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := walk(*root, 0); err != nil {
		log.Fatalf("walk: %v", err)
	}

	f, err := os.Create(*out)
	if err != nil {
		log.Fatalf("create %s: %v", *out, err)
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	enc.SetIndent("", " ")
	if err := enc.Encode(idx); err != nil {
		log.Fatalf("write index: %v", err)
	}
	log.Printf("indexed %d entries under %s -> %s", len(idx.Entries), *root, *out)
}
