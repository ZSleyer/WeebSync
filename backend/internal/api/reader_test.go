package api

import (
	"archive/zip"
	"context"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/auth"
)

func TestUnpackComic(t *testing.T) {
	tmp := t.TempDir()
	arc := filepath.Join(tmp, "vol.cbr") // a zip under a rar name: the bytes decide
	f, _ := os.Create(arc)
	zw := zip.NewWriter(f)
	for _, n := range []string{"10.jpg", "2.jpg", "1.jpg", "../escape.jpg", "/abs.png", "__MACOSX/._1.jpg", "info.txt"} {
		w, _ := zw.Create(n)
		w.Write([]byte("x"))
	}
	zw.Close()
	f.Close()

	in, _ := os.Open(arc)
	defer in.Close()
	fi, _ := in.Stat()
	out := filepath.Join(tmp, "out")
	os.Mkdir(out, 0o700)
	if err := unpack(context.Background(), &playFile{ReadSeeker: in, size: fi.Size()}, out); err != nil {
		t.Fatal(err)
	}
	// names that pointed out of the folder land inside it
	got := comicPages(out)
	want := []string{"1.jpg", "2.jpg", "10.jpg", "abs.png", "escape.jpg"}
	if !slices.Equal(got, want) {
		t.Errorf("pages = %v, want %v", got, want)
	}
	if _, err := os.Stat(filepath.Join(tmp, "escape.jpg")); err == nil {
		t.Error("entry escaped the book folder")
	}

	s := testServer(t, &Server{})
	b := &book{key: "k", token: "tok", dir: out, kind: "comic", used: time.Now()}
	s.books.byKey, s.books.byToken = map[string]*book{"k": b}, map[string]*book{"tok": b}
	mux := http.NewServeMux()
	mux.Handle("GET /api/read/b/{token}/{entry...}", http.HandlerFunc(s.handleReadEntry))
	for path, code := range map[string]int{
		"/api/read/b/tok/2.jpg":        200,
		"/api/read/b/tok/..%2f..%2fx":  404,
		"/api/read/b/nope/2.jpg":       404,
		"/api/read/b/tok/__MACOSX/._1": 404,
	} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		if rec.Code != code {
			t.Errorf("%s: %d, want %d", path, rec.Code, code)
		}
		if code == 200 {
			if ct := rec.Header().Get("Content-Type"); ct != "image/jpeg" {
				t.Errorf("content type %q", ct)
			}
			if csp := rec.Header().Get("Content-Security-Policy"); !strings.HasPrefix(csp, "sandbox") {
				t.Errorf("entry not sandboxed: %q", csp)
			}
		}
	}
}

// Each unpack in progress may write gigabytes, and the shelf only bounds the
// finished ones: fifty parallel opens of fifty paths used to unpack fifty
// books at once. Now a user unpacks one book at a time, and no more than the
// slots run across all users; a request waiting for a slot leaves when it
// ends.
func TestReadOpenBoundsUnpacks(t *testing.T) {
	mux, s, adminC, userC, _, _ := setupUsersTest(t)
	res, err := s.DB.Exec(`INSERT INTO users (email) VALUES ('third@example.com')`)
	if err != nil {
		t.Fatal(err)
	}
	thirdID, _ := res.LastInsertId()
	rec := httptest.NewRecorder()
	if err := auth.CreateSession(s.DB, rec, httptest.NewRequest("GET", "/", nil), thirdID, true); err != nil {
		t.Fatal(err)
	}
	thirdC := rec.Result().Cookies()[0]

	var mu sync.Mutex
	active, peak, runs := 0, 0, 0
	entered := make(chan struct{}, 8)
	release := make(chan struct{})
	defer func(f func(*Server, context.Context, playSource) (*book, error)) { bookUnpack = f }(bookUnpack)
	bookUnpack = func(_ *Server, _ context.Context, src playSource) (*book, error) {
		mu.Lock()
		active++
		runs++
		peak = max(peak, active)
		mu.Unlock()
		entered <- struct{}{}
		<-release
		mu.Lock()
		active--
		mu.Unlock()
		return &book{dir: t.TempDir(), kind: "comic", token: src.path, pages: []string{"1.jpg"}, used: time.Now()}, nil
	}
	open := func(path string, c *http.Cookie, ctx context.Context) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/api/read/open?path="+path, nil).WithContext(ctx)
		req.AddCookie(c)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}
	var wg sync.WaitGroup
	codes := make([]int, 2)
	wg.Go(func() { codes[0] = open("/a.cbz", userC, context.Background()).Code })
	<-entered
	// the same user's next book is refused while the first unpacks
	if rec := open("/b.cbz", userC, context.Background()); rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("second parallel book of one user: %d %s", rec.Code, rec.Body)
	}
	wg.Go(func() { codes[1] = open("/c.cbz", adminC, context.Background()).Code })
	<-entered
	// both slots are taken: a third user waits, and leaves with its request
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int)
	go func() { done <- open("/d.cbz", thirdC, ctx).Code }()
	cancel()
	if code := <-done; code == http.StatusOK {
		t.Fatal("a request past the slots unpacked anyway")
	}
	close(release)
	wg.Wait()
	if codes[0] != http.StatusOK || codes[1] != http.StatusOK {
		t.Fatalf("books within the limits: %v", codes)
	}
	if peak != 2 || runs != 2 {
		t.Fatalf("peak %d runs %d, want 2 and 2", peak, runs)
	}
	// the user's slot is free again once the unpack is done
	if rec := open("/b.cbz", userC, context.Background()); rec.Code != http.StatusOK {
		t.Fatalf("next book after the first finished: %d %s", rec.Code, rec.Body)
	}
}

// net/http recovers a panicking handler and serves on. A panic in the unpack
// must not keep the global slot, the user's turn or the book's opening entry,
// or a few of them would refuse every later book.
func TestReadOpenSurvivesAPanickingUnpack(t *testing.T) {
	s := testServer(t, &Server{})
	defer func(f func(*Server, context.Context, playSource) (*book, error)) { bookUnpack = f }(bookUnpack)
	bookUnpack = func(*Server, context.Context, playSource) (*book, error) { panic("broken archive") }
	open := func(path string) (b *book, err error, panicked bool) {
		defer func() {
			if recover() != nil {
				panicked = true
			}
		}()
		b, err = s.openBook(context.Background(), playSource{userID: 1, path: path})
		return b, err, false
	}
	// as many panics as there are slots: leaked, they would block every book
	for i := range cap(bookUnpackSlots) {
		if _, err, panicked := open("/" + strconv.Itoa(i) + ".cbz"); !panicked {
			t.Fatalf("unpack %d did not run: %v", i, err)
		}
	}
	if n := len(bookUnpackSlots); n != 0 {
		t.Fatalf("%d slots still held after the panics", n)
	}
	s.books.mu.Lock()
	turns, opening := s.books.unpacking[1], len(s.books.opening)
	s.books.mu.Unlock()
	if turns != 0 || opening != 0 {
		t.Fatalf("after the panics: user turns %d, opening entries %d", turns, opening)
	}
	bookUnpack = func(_ *Server, _ context.Context, src playSource) (*book, error) {
		return &book{dir: t.TempDir(), kind: "comic", token: "tok", pages: []string{"1.jpg"}, used: time.Now()}, nil
	}
	if b, err, _ := open("/a.cbz"); err != nil || b == nil {
		t.Fatalf("book after the panics: %v", err)
	}
}

// An unpack leaves bookMinFree on the disk: an archive that would write past
// it stops with errBookDisk (507), however far below the per-book cap it is.
func TestUnpackStopsAtDiskBudget(t *testing.T) {
	defer func(f func(string) (uint64, error)) { bookDiskFree = f }(bookDiskFree)
	// 10 bytes of room per slot above the reserve
	bookDiskFree = func(string) (uint64, error) { return bookMinFree + uint64(10*cap(bookUnpackSlots)), nil }
	tmp := t.TempDir()
	for name, size := range map[string]int{"small.cbz": 8, "big.cbz": 50} {
		arc := filepath.Join(tmp, name)
		f, _ := os.Create(arc)
		zw := zip.NewWriter(f)
		w, _ := zw.Create("1.jpg")
		w.Write(make([]byte, size))
		zw.Close()
		f.Close()
		in, _ := os.Open(arc)
		fi, _ := in.Stat()
		out := filepath.Join(tmp, name+".out")
		os.Mkdir(out, 0o700)
		err := unpack(context.Background(), &playFile{ReadSeeker: in, size: fi.Size()}, out)
		in.Close()
		if name == "small.cbz" && err != nil {
			t.Errorf("%s within the room: %v", name, err)
		}
		if name == "big.cbz" && !errors.Is(err, errBookDisk) {
			t.Errorf("%s past the room: %v, want errBookDisk", name, err)
		}
	}
	// and the reader says so
	mux, _, _, userC, _, _ := setupUsersTest(t)
	defer func(f func(*Server, context.Context, playSource) (*book, error)) { bookUnpack = f }(bookUnpack)
	bookUnpack = func(*Server, context.Context, playSource) (*book, error) { return nil, errBookDisk }
	if rec := doReq(mux, "GET", "/api/read/open?path=/big.cbz", "", userC); rec.Code != http.StatusInsufficientStorage {
		t.Errorf("open past the disk budget: %d %s", rec.Code, rec.Body)
	}
}

// a RAR5 archive holding ch/2.png and ch/10.png, made with `rar a -ma5`
const rar5Fixture = "526172211a0701003392b5e50a0105060005010180800012fce1102602030b8100048100a4830243beb7e88000010863682f322e706e670a0313c2f1cb6a6e3d072161f61754de2702030b8100048100a48302f9efbe718000010963682f31302e706e670a0313c2f1cb6a6e3d0721622e2e57871a02030b000100ed83018000010263680a0313c2f1cb6a6e3d07211d77565103050400"

func TestUnpackRar(t *testing.T) {
	tmp := t.TempDir()
	raw, _ := hex.DecodeString(rar5Fixture)
	arc := filepath.Join(tmp, "vol.cbz") // a rar under a zip name
	os.WriteFile(arc, raw, 0o600)
	in, _ := os.Open(arc)
	defer in.Close()
	out := filepath.Join(tmp, "out")
	os.Mkdir(out, 0o700)
	if err := unpack(context.Background(), &playFile{ReadSeeker: in, size: int64(len(raw))}, out); err != nil {
		t.Fatal(err)
	}
	if got, want := comicPages(out), []string{"ch/2.png", "ch/10.png"}; !slices.Equal(got, want) {
		t.Errorf("pages = %v, want %v", got, want)
	}
}

func TestNaturalCompare(t *testing.T) {
	l := []string{"p10.png", "P2.png", "p1.png", "a/p3.png", "p01b.png"}
	slices.SortFunc(l, naturalCompare)
	want := []string{"a/p3.png", "p1.png", "p01b.png", "P2.png", "p10.png"}
	if !slices.Equal(l, want) {
		t.Errorf("got %v, want %v", l, want)
	}
	// letters, not bytes: two accented ones are not alike for sharing a
	// lead byte, and the case of one does not count
	l = []string{"Öa.png", "Äb.png", "éd.png", "Éc.png"}
	slices.SortFunc(l, naturalCompare)
	want = []string{"Äb.png", "Éc.png", "éd.png", "Öa.png"}
	if !slices.Equal(l, want) {
		t.Errorf("got %v, want %v", l, want)
	}
}
