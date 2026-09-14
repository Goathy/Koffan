package handlers

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
)

func TestLoginRateLimitConfiguration(t *testing.T) {
	initTestDatabase(t)
	t.Setenv("APP_PASSWORD", "test-password")
	t.Setenv("LOGIN_WINDOW_MINUTES", "15")
	t.Setenv("LOGIN_LOCKOUT_MINUTES", "30")
	originalLimiter := loginLimiter
	t.Cleanup(func() { loginLimiter = originalLimiter })

	for _, tc := range []struct {
		name        string
		maxAttempts string
		limit       int
	}{
		{name: "default", maxAttempts: "", limit: 5},
		{name: "custom", maxAttempts: "2", limit: 2},
		{name: "invalid uses default", maxAttempts: "invalid", limit: 5},
		{name: "disabled", maxAttempts: "0", limit: 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("LOGIN_MAX_ATTEMPTS", tc.maxAttempts)
			InitLoginRateLimiter()
			if tc.limit == 0 && loginLimiter != nil {
				t.Fatal("disabled limiter must not allocate attempt tracking or start cleanup")
			}

			app := fiber.New()
			app.Post("/login", LoginRateLimitMiddleware, Login)
			login := func(password, wantLocation string) *http.Response {
				t.Helper()
				form := url.Values{"password": {password}}
				req := httptest.NewRequest(http.MethodPost, "/login", strings.NewReader(form.Encode()))
				req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
				resp, err := app.Test(req)
				if err != nil {
					t.Fatalf("login request: %v", err)
				}
				resp.Body.Close()
				if resp.StatusCode != http.StatusFound || resp.Header.Get("Location") != wantLocation {
					t.Fatalf("login returned %d %q, want 302 %q", resp.StatusCode, resp.Header.Get("Location"), wantLocation)
				}
				return resp
			}

			for attempt := 1; attempt <= 10; attempt++ {
				location := "/login?error=1"
				if tc.limit > 0 && attempt > tc.limit {
					location = "/login?error=rate_limited"
				}
				resp := login("wrong-password", location)
				if len(resp.Cookies()) != 0 {
					t.Fatal("failed login must not create a session")
				}
			}

			if tc.limit > 0 {
				login("test-password", "/login?error=rate_limited")
			} else {
				resp := login("test-password", "/")
				for _, cookie := range resp.Cookies() {
					if cookie.Name == SessionCookieName && cookie.Value != "" {
						return
					}
				}
				t.Fatal("successful login must create a session with rate limiting disabled")
			}
		})
	}
}
