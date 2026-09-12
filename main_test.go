package main

import (
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Run the real application in a subprocess so each case gets fresh configuration.
func TestHTTPReadBufferServer(t *testing.T) {
	if os.Getenv("KOFFAN_HTTP_TEST_SERVER") != "1" {
		t.Skip("subprocess helper")
	}
	main()
}

func TestHTTPReadBufferSize(t *testing.T) {
	for _, tc := range []struct {
		name, setting      string
		accepted, rejected int
		invalid            bool
	}{
		{"default", "", 15000, 20000, false},
		{"larger", "65536", 60000, 70000, false},
		{"smaller", "4096", 2000, 8000, false},
		{"not a number", "abc", 15000, 20000, true},
		{"zero", "0", 15000, 20000, true},
		{"negative", "-1", 15000, 20000, true},
		{"overflow", "999999999999999999999999", 15000, 20000, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			address := listener.Addr().String()
			_, port, err := net.SplitHostPort(address)
			listener.Close()
			if err != nil {
				t.Fatal(err)
			}
			dir := t.TempDir()
			logPath := filepath.Join(dir, "server.log")
			logFile, err := os.Create(logPath)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { logFile.Close() })
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command(executable, "-test.run=^TestHTTPReadBufferServer$")
			cmd.Env = []string{
				"KOFFAN_HTTP_TEST_SERVER=1", "PORT=" + port,
				"DB_PATH=" + filepath.Join(dir, "shopping.db"), "DISABLE_AUTH=true",
			}
			if tc.setting != "" {
				cmd.Env = append(cmd.Env, "HTTP_READ_BUFFER_SIZE="+tc.setting)
			}
			cmd.Stdout, cmd.Stderr = logFile, logFile
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				cmd.Process.Kill()
				cmd.Wait()
				if t.Failed() {
					logs, _ := os.ReadFile(logPath)
					t.Logf("Server output:\n%s", logs)
				}
			})
			transport := &http.Transport{DisableKeepAlives: true}
			defer transport.CloseIdleConnections()
			client := &http.Client{Transport: transport, Timeout: 2 * time.Second}
			baseURL := "http://" + address
			ready := false
			for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
				response, err := client.Get(baseURL + "/login")
				if err == nil {
					response.Body.Close()
					ready = response.StatusCode == http.StatusOK
					if ready {
						break
					}
				}
				time.Sleep(20 * time.Millisecond)
			}
			if !ready {
				t.Fatal("server did not become ready")
			}
			for _, path := range []string{"/", "/login", "/static/sw.js"} {
				for _, check := range []struct{ size, status int }{
					{tc.accepted, http.StatusOK}, {tc.rejected, http.StatusRequestHeaderFieldsTooLarge},
				} {
					request, err := http.NewRequest(http.MethodGet, baseURL+path, nil)
					if err != nil {
						t.Fatal(err)
					}
					request.Header.Set("Cookie", "sso="+strings.Repeat("x", check.size))
					response, err := client.Do(request)
					if err != nil {
						t.Fatal(err)
					}
					io.Copy(io.Discard, response.Body)
					response.Body.Close()
					if response.StatusCode != check.status {
						t.Errorf("%s with %d cookie bytes: got %d, want %d", path, check.size, response.StatusCode, check.status)
					}
				}
			}
			if tc.invalid {
				logs, err := os.ReadFile(logPath)
				if err != nil {
					t.Fatal(err)
				}
				if !strings.Contains(string(logs), "Invalid HTTP_READ_BUFFER_SIZE") {
					t.Error("invalid configuration did not produce a warning")
				}
			}
		})
	}
}
