package main

import (
	"bufio"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/ch4d1/weebsync/internal/auth"
	"github.com/ch4d1/weebsync/internal/db"
)

// resetPassword is `weebsync reset-password <email>`: the way back in when
// nobody can sign in any more, run where the data directory is. The new
// password comes from stdin, not an argument, which the process list and the
// shell history would keep. The account's sessions end with it.
func resetPassword(dataDir string, args []string, stdin *os.File, out io.Writer) int {
	if len(args) != 1 {
		fmt.Fprintln(out, "usage: weebsync reset-password <email>   (the new password is read from stdin)")
		return 2
	}
	email := strings.ToLower(strings.TrimSpace(args[0]))
	path := filepath.Join(dataDir, "weebsync.db")
	if _, err := os.Stat(path); err != nil {
		fmt.Fprintf(out, "no database at %s (set WEEBSYNC_DATA): %v\n", path, err)
		return 1
	}
	database, err := db.Open(path)
	if err != nil {
		fmt.Fprintln(out, "open database:", err)
		return 1
	}
	defer database.Close()
	var id int64
	if err := database.QueryRow(`SELECT id FROM users WHERE email = ?`, email).Scan(&id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			fmt.Fprintln(out, "no account with that email")
		} else {
			fmt.Fprintln(out, "read account:", err)
		}
		return 1
	}
	pw, err := readNewPassword(stdin, out)
	if err != nil {
		fmt.Fprintln(out, err)
		return 1
	}
	if err := auth.SetPassword(database, id, pw, ""); err != nil {
		fmt.Fprintln(out, "set password:", err)
		return 1
	}
	fmt.Fprintf(out, "password set for %s, its sessions have ended\n", email)
	return 0
}

// readNewPassword reads the password from a terminal twice without echoing
// it, or once from a pipe.
func readNewPassword(in *os.File, out io.Writer) (string, error) {
	r := bufio.NewReader(in)
	line := func() (string, error) {
		s, err := r.ReadString('\n')
		if err != nil && (err != io.EOF || s == "") {
			return "", errors.New("no password on stdin")
		}
		return strings.TrimRight(s, "\r\n"), nil
	}
	if st, err := in.Stat(); err != nil || st.Mode()&os.ModeCharDevice == 0 {
		return line()
	}
	restore := noEcho(in)
	defer restore()
	fmt.Fprint(out, "New password: ")
	pw, err := line()
	fmt.Fprintln(out)
	if err != nil {
		return "", err
	}
	fmt.Fprint(out, "Again: ")
	again, err := line()
	fmt.Fprintln(out)
	if err != nil {
		return "", err
	}
	if pw != again {
		return "", errors.New("the two passwords differ")
	}
	return pw, nil
}
