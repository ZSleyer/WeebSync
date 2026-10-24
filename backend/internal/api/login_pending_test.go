package api

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ch4d1/weebsync/internal/dbtest"
	"github.com/ch4d1/weebsync/internal/secret"
	"github.com/ch4d1/weebsync/internal/totp"
)

func TestLoginPendingIsConsumedOnce(t *testing.T) {
	d := dbtest.Open(t)
	if _, err := d.Exec(`INSERT INTO users (id, email, password_hash) VALUES (1, 'a@example.com', '')`); err != nil {
		t.Fatal(err)
	}
	s := testServer(t, &Server{DB: d})
	token, err := s.newLoginPending(1, false)
	if err != nil {
		t.Fatal(err)
	}
	if !s.consumeLoginPending(token, 1) {
		t.Fatal("valid pending login was rejected")
	}
	if s.consumeLoginPending(token, 1) {
		t.Fatal("pending login was consumed twice")
	}
}

func TestLoginPendingDropsAfterMaxFailures(t *testing.T) {
	d := dbtest.Open(t)
	if _, err := d.Exec(`INSERT INTO users (id, email, password_hash) VALUES (1, 'a@example.com', '')`); err != nil {
		t.Fatal(err)
	}
	s := testServer(t, &Server{DB: d})
	token, err := s.newLoginPending(1, false)
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= loginPendingMaxAttempts; i++ {
		if _, ok := s.reserveLoginPending(token); !ok {
			t.Fatalf("attempt %d refused within the budget", i)
		}
		if _, ok := s.peekLoginPending(token); !ok {
			t.Fatalf("token dropped after %d attempts", i)
		}
	}
	if _, ok := s.reserveLoginPending(token); ok {
		t.Fatal("an attempt past the budget was handed out")
	}
	if _, ok := s.peekLoginPending(token); ok {
		t.Fatal("token survived the attempt budget")
	}
	if s.consumeLoginPending(token, 1) {
		t.Fatal("dropped token was consumed")
	}
}

// Attempts used to be counted after the check: every one of a burst of
// parallel guesses passed the budget before the first was counted. Spent
// first, the budget holds however many arrive at once - per pending token
// and per account.
func TestLoginPendingReservesAtomically(t *testing.T) {
	d := dbtest.Open(t)
	if _, err := d.Exec(`INSERT INTO users (id, email, password_hash) VALUES (1, 'a@example.com', '')`); err != nil {
		t.Fatal(err)
	}
	s := testServer(t, &Server{DB: d})
	token, err := s.newLoginPending(1, false)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	granted := 0
	var wg sync.WaitGroup
	for range 40 {
		wg.Go(func() {
			if _, ok := s.reserveLoginPending(token); ok {
				mu.Lock()
				granted++
				mu.Unlock()
			}
		})
	}
	wg.Wait()
	if granted != loginPendingMaxAttempts {
		t.Fatalf("%d attempts handed out in parallel, want %d", granted, loginPendingMaxAttempts)
	}
}

func TestLoginTotpParallelGuessesStayWithinTheBudget(t *testing.T) {
	mux, s, token, _ := totpFixture(t)
	// the per-address limit apart: the guesses come from many addresses
	s.authLimiter.trusted = func(string) bool { return true }
	const guesses = 40
	var wg sync.WaitGroup
	bodies := make([]string, guesses)
	for i := range guesses {
		wg.Go(func() { bodies[i] = postTotp(mux, token, "000000").Body.String() })
	}
	wg.Wait()
	// "invalid code" is a guess that got checked
	checked := 0
	for _, b := range bodies {
		if strings.Contains(b, "invalid code") {
			checked++
		}
	}
	if checked != loginPendingMaxAttempts {
		t.Fatalf("%d of %d parallel codes were checked, want %d", checked, guesses, loginPendingMaxAttempts)
	}
}

// The same for the account's bucket: parallel wrong passwords against one
// account from many addresses get no more checks than the bucket holds.
func TestLoginParallelGuessesStayWithinTheAccountBudget(t *testing.T) {
	mux, s, _, _, _, userID := setupUsersTest(t)
	setPassword(t, s, userID, "longenough123")
	s.authLimiter.trusted = func(string) bool { return true }
	const guesses = 30
	var wg sync.WaitGroup
	codes := make([]int, guesses)
	for i := range guesses {
		wg.Go(func() {
			codes[i] = doReq(mux, "POST", "/api/auth/login", fmt.Sprintf(`{"email":"user@example.com","password":"guess-%d-guess"}`, i), nil).Code
		})
	}
	wg.Wait()
	checked := 0
	for _, c := range codes {
		if c == http.StatusUnauthorized {
			checked++
		}
	}
	// the bucket holds 10 (api.go); it refills at 0.2/min
	if checked == 0 || checked > 10 {
		t.Fatalf("%d of %d parallel passwords were checked, want at most 10: %v", checked, guesses, codes)
	}
}

// totpFixture: a confirmed TOTP user with a fresh pending login, wired to the
// real mux so the handler path (limiter, JSON, session) is exercised.
func totpFixture(t *testing.T) (*http.ServeMux, *Server, string, string) {
	t.Helper()
	if err := secret.Init(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	d := dbtest.Open(t)
	if _, err := d.Exec(`INSERT INTO users (id, email, password_hash, email_verified) VALUES (1, 'a@example.com', 'x', 1)`); err != nil {
		t.Fatal(err)
	}
	sec, _, err := totp.New("test", "a@example.com")
	if err != nil {
		t.Fatal(err)
	}
	enc, err := secret.Encrypt(sec)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`INSERT INTO user_totp (user_id, secret_enc, confirmed_at) VALUES (1, ?, datetime('now'))`, enc); err != nil {
		t.Fatal(err)
	}
	s := testServer(t, &Server{DB: d})
	mux := http.NewServeMux()
	s.Register(mux)
	token, err := s.newLoginPending(1, false)
	if err != nil {
		t.Fatal(err)
	}
	return mux, s, token, sec
}

func postTotp(mux *http.ServeMux, token, code string) *httptest.ResponseRecorder {
	return doReq(mux, "POST", "/api/auth/login/totp", fmt.Sprintf(`{"token":%q,"code":%q}`, token, code), nil)
}

func TestLoginTotpLocksTokenAfterWrongCodes(t *testing.T) {
	mux, s, token, sec := totpFixture(t)
	for i := 0; i < loginPendingMaxAttempts; i++ {
		if rec := postTotp(mux, token, "000000"); rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "invalid code") {
			t.Fatalf("attempt %d: %d %s", i+1, rec.Code, rec.Body.String())
		}
	}
	s.authLimiter.resetAll() // the per-IP limiter would answer 429 before the handler
	code, err := totp.Code(sec, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if rec := postTotp(mux, token, code); rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "expired login") {
		t.Fatalf("valid code after lockout: %d %s", rec.Code, rec.Body.String())
	}
}

func TestRecoveryCodeRedeemsOnce(t *testing.T) {
	d := dbtest.Open(t)
	if _, err := d.Exec(`INSERT INTO users (id, email, password_hash) VALUES (1, 'a@example.com', '')`); err != nil {
		t.Fatal(err)
	}
	s := testServer(t, &Server{DB: d})
	codes, err := s.confirmTotp(1)
	if err != nil || len(codes) != 10 {
		t.Fatalf("codes=%d err=%v", len(codes), err)
	}
	if !s.useRecoveryCode(1, codes[0]) {
		t.Fatal("fresh code rejected")
	}
	if s.useRecoveryCode(1, codes[0]) {
		t.Fatal("code redeemed twice")
	}
	if !s.useRecoveryCode(1, codes[1]) || s.useRecoveryCode(1, "nope") {
		t.Fatal("second code or garbage misjudged")
	}
}

func TestLoginTotpAcceptsRecoveryCodeOnce(t *testing.T) {
	mux, s, token, _ := totpFixture(t)
	codes, err := s.confirmTotp(1)
	if err != nil {
		t.Fatal(err)
	}
	rec := postTotp(mux, token, codes[0])
	if rec.Code != http.StatusOK || len(rec.Result().Cookies()) == 0 {
		t.Fatalf("recovery login: %d %s", rec.Code, rec.Body.String())
	}
	if _, ok := s.peekLoginPending(token); ok {
		t.Fatal("pending token survived a successful login")
	}
	token, _ = s.newLoginPending(1, false)
	if rec := postTotp(mux, token, codes[0]); rec.Code != http.StatusUnauthorized {
		t.Fatalf("used recovery code accepted again: %d", rec.Code)
	}
}

func TestTotpCodeNormalization(t *testing.T) {
	for in, want := range map[string]string{
		"146493":     "146493",
		"146 493":    "146493",
		" 146-493\n": "146493",
	} {
		if got := normalizeTotpCode(in); got != want {
			t.Errorf("normalizeTotpCode(%q) = %q, want %q", in, got, want)
		}
	}
	for in, want := range map[string]string{
		"abcde-fghjk":   "abcde-fghjk",
		"ABCDE-FGHJK":   "abcde-fghjk",
		"abcdefghjk":    "abcde-fghjk",
		" Abcde fghjk ": "abcde-fghjk",
	} {
		if got := normalizeRecoveryCode(in); got != want {
			t.Errorf("normalizeRecoveryCode(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLoginTotpAcceptsFormattedCodes(t *testing.T) {
	mux, s, token, sec := totpFixture(t)
	code, err := totp.Code(sec, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if rec := postTotp(mux, token, code[:3]+" "+code[3:]); rec.Code != http.StatusOK {
		t.Fatalf("code with a space: %d %s", rec.Code, rec.Body.String())
	}
	codes, err := s.confirmTotp(1)
	if err != nil {
		t.Fatal(err)
	}
	token, _ = s.newLoginPending(1, false)
	typed := strings.ToUpper(strings.ReplaceAll(codes[0], "-", ""))
	if rec := postTotp(mux, token, typed); rec.Code != http.StatusOK {
		t.Fatalf("upper-case recovery code without dash: %d %s", rec.Code, rec.Body.String())
	}
}

// A code stays valid for three steps. Once a code of a later step got the
// account in, an earlier one that is still in the window must not: whoever
// read code A over the owner's shoulder could otherwise use it after the
// owner signed in again with code B.
func TestLoginTotpRefusesReplayOfAnOlderStep(t *testing.T) {
	mux, s, _, sec := totpFixture(t)
	now := time.Now()
	codeA, err := totp.Code(sec, now)
	if err != nil {
		t.Fatal(err)
	}
	codeB, _ := totp.Code(sec, now.Add(30*time.Second))
	if codeA == codeB {
		t.Skip("two steps share a code")
	}
	login := func(code string) int {
		t.Helper()
		s.authLimiter.resetAll()
		token, err := s.newLoginPending(1, false)
		if err != nil {
			t.Fatal(err)
		}
		return postTotp(mux, token, code).Code
	}
	if c := login(codeA); c != http.StatusOK {
		t.Fatalf("code A: %d", c)
	}
	if c := login(codeA); c != http.StatusUnauthorized {
		t.Fatalf("code A again: %d", c)
	}
	if c := login(codeB); c != http.StatusOK {
		t.Fatalf("code B of the next step: %d", c)
	}
	if c := login(codeA); c != http.StatusUnauthorized {
		t.Fatalf("code A replayed after code B: %d", c)
	}
}
