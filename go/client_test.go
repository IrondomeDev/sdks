package irondome

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const success = `{"provider":"custom","valid":true,"disposable":false,"reason":"not_listed"}`

func fixture(t *testing.T, h2 bool) (*Client, *atomic.Int64, *atomic.Int64, *atomic.Int64) {
	t.Helper()
	var connections, checks, healthAuth atomic.Int64
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-ID", "safe-id")
		w.Header().Set("X-Detector-Base-Version", "release-1")
		if r.URL.Path == "/healthz" {
			if r.Header.Get("Authorization") != "" {
				healthAuth.Add(1)
			}
			fmt.Fprint(w, `{"status":"ok"}`)
			return
		}
		checks.Add(1)
		raw, _ := io.ReadAll(r.Body)
		if int64(len(raw)) != r.ContentLength || len(r.TransferEncoding) != 0 || r.Header.Get("Authorization") != "Bearer test-key" || r.Header.Get("Cookie") != "" {
			w.WriteHeader(400)
			return
		}
		if r.URL.Path == "/v1/check/bulk" {
			var input struct {
				Emails []string `json:"emails"`
			}
			if json.Unmarshal(raw, &input) != nil || len(input.Emails) < 1 || len(input.Emails) > 100 {
				w.WriteHeader(400)
				return
			}
			mode := strings.Split(input.Emails[0], "@")[0]
			switch mode {
			case "quota":
				w.WriteHeader(429)
				fmt.Fprint(w, `{"error":{"code":"monthly_quota_exceeded","message":"private"}}`)
				return
			case "redirect":
				w.Header().Set("Location", serverLocation(r))
				w.WriteHeader(307)
				return
			case "unavailable":
				w.WriteHeader(503)
				fmt.Fprint(w, `{"error":{"code":"service_unavailable"}}`)
				return
			case "oversized":
				fmt.Fprint(w, strings.Repeat("x", maxBulkBytes+1))
				return
			case "truncated":
				w.Header().Set("Content-Length", "100")
				fmt.Fprint(w, "{")
				return
			case "slow":
				time.Sleep(150 * time.Millisecond)
			}
			results := []map[string]any{}
			checked := 0
			for index, email := range input.Emails {
				item := map[string]any{"index": index}
				if strings.Contains(email, "@") {
					item["provider"] = "custom"
					item["valid"] = true
					item["disposable"] = false
					item["reason"] = "not_listed"
					checked++
				} else {
					item["error"] = map[string]string{"code": "invalid_email", "message": "private"}
				}
				results = append(results, item)
			}
			response := map[string]any{"results": results, "checked": checked, "failed": len(results) - checked}
			if mode == "padded" {
				response["padding"] = strings.Repeat("x", 20000)
			}
			json.NewEncoder(w).Encode(response)
			return
		}
		var input map[string]string
		if json.Unmarshal(raw, &input) != nil || len(input) != 1 {
			w.WriteHeader(400)
			return
		}
		switch strings.Split(input["email"], "@")[0] {
		case "redirect":
			w.Header().Set("Location", serverLocation(r))
			w.WriteHeader(307)
		case "unavailable":
			w.Header().Set("Retry-After", "5")
			w.WriteHeader(503)
			fmt.Fprint(w, `{"error":{"code":"service_unavailable","message":"private"}}`)
		case "slow":
			time.Sleep(150 * time.Millisecond)
			fmt.Fprint(w, success)
		case "slow-body":
			fmt.Fprint(w, "{")
			w.(http.Flusher).Flush()
			time.Sleep(150 * time.Millisecond)
			fmt.Fprint(w, success[1:])
		case "oversized":
			fmt.Fprint(w, strings.Repeat("x", maxResponseBytes+1))
		case "truncated":
			w.Header().Set("Content-Length", "100")
			fmt.Fprint(w, "{")
		case "cookie":
			w.Header().Set("Set-Cookie", "private=secret")
			fmt.Fprint(w, success)
		default:
			fmt.Fprint(w, success)
		}
	}))
	server.EnableHTTP2 = h2
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			connections.Add(1)
		}
	}
	server.StartTLS()
	t.Cleanup(server.Close)
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	client, err := New("test-key", server.URL, Options{RootCAs: roots, HTTP1Only: !h2})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	return client, &connections, &checks, &healthAuth
}
func serverLocation(r *http.Request) string { return "https://" + r.Host + "/should-not-follow" }
func errorKind(t *testing.T, err error, kind Kind) *Error {
	t.Helper()
	var sdk *Error
	if !errors.As(err, &sdk) || sdk.Kind != kind {
		t.Fatalf("expected %s, got %v", kind, err)
	}
	return sdk
}
func TestConnectionReuse(t *testing.T) {
	for _, h2 := range []bool{false, true} {
		t.Run(fmt.Sprint(h2), func(t *testing.T) {
			c, connections, _, healthAuth := fixture(t, h2)
			if _, err := c.Warmup(context.Background()); err != nil {
				t.Fatal(err)
			}
			for range 3 {
				r, err := c.Check(context.Background(), "é@example.com")
				if err != nil || r.RequestID != "safe-id" {
					t.Fatalf("%v %v", r, err)
				}
			}
			if connections.Load() != 1 || healthAuth.Load() != 0 {
				t.Fatalf("connections=%d healthAuth=%d", connections.Load(), healthAuth.Load())
			}
			if strings.Contains(fmt.Sprintf("%v %+v %#v", c, c, c), "test-key") {
				t.Fatal("credential leaked")
			}
		})
	}
}
func TestNoReplayAndNoCookies(t *testing.T) {
	c, _, checks, _ := fixture(t, false)
	for _, mode := range []string{"redirect", "unavailable", "truncated"} {
		before := checks.Load()
		_, err := c.Check(context.Background(), mode+"@example.com")
		if err == nil || checks.Load() != before+1 {
			t.Fatalf("unexpected replay: %s", mode)
		}
		if strings.Contains(err.Error(), "private") {
			t.Fatal("private body exposed")
		}
		if mode == "unavailable" {
			e := errorKind(t, err, API)
			if e.Code != "service_unavailable" || e.RetryAfter == nil || *e.RetryAfter != 5*time.Second {
				t.Fatal(e)
			}
		}
	}
	if _, err := c.Check(context.Background(), "cookie@example.com"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Check(context.Background(), "normal@example.com"); err != nil {
		t.Fatal(err)
	}
}
func TestDeadlineAndCancellation(t *testing.T) {
	c, _, _, _ := fixture(t, false)
	for _, mode := range []string{"slow", "slow-body"} {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
		_, err := c.Check(ctx, mode+"@example.com")
		cancel()
		errorKind(t, err, Timeout)
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatal("deadline identity lost")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := c.Check(ctx, "normal@example.com")
	errorKind(t, err, Canceled)
	_, err = c.Check(context.Background(), "oversized@example.com")
	errorKind(t, err, Protocol)
	c.Close()
	_, err = c.Warmup(context.Background())
	errorKind(t, err, Closed)
}
func TestConcurrentAndBounded(t *testing.T) {
	c, _, _, _ := fixture(t, true)
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.Check(context.Background(), "normal@example.com"); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	for range cap(c.slots) {
		c.slots <- struct{}{}
	}
	_, err := c.Check(context.Background(), "normal@example.com")
	errorKind(t, err, Busy)
	for range cap(c.slots) {
		<-c.slots
	}
}
func TestTLSAndEnvironment(t *testing.T) {
	c, _, _, _ := fixture(t, false)
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	if _, err := c.Warmup(context.Background()); err != nil {
		t.Fatal(err)
	}
	untrusted, err := New("test-key", c.origin, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer untrusted.Close()
	_, err = untrusted.Warmup(context.Background())
	errorKind(t, err, Transport)
	wrongHost, err := New("test-key", c.origin, Options{RootCAs: c.transport.TLSClientConfig.RootCAs})
	if err != nil {
		t.Fatal(err)
	}
	defer wrongHost.Close()
	// Keep traffic on loopback while requiring a hostname absent from the certificate.
	wrongHost.transport.TLSClientConfig.ServerName = "wrong.invalid"
	_, err = wrongHost.Warmup(context.Background())
	errorKind(t, err, Transport)
	if c.transport.TLSClientConfig.InsecureSkipVerify || c.transport.TLSClientConfig.MinVersion != tls.VersionTLS12 {
		t.Fatal("insecure TLS")
	}
}
func TestValidation(t *testing.T) {
	for _, origin := range []string{"http://localhost", "https://host/x", "https://host/x/..", "https://user:pass@host", "https://host?x", "https://host#x", "https://host:0", "https://host:65536", " https://host", "https://host\\evil"} {
		_, err := New("test-key", origin, Options{})
		errorKind(t, err, Configuration)
	}
	for _, key := range []string{"", "x\r\ny", "x y", "é", strings.Repeat("x", 4097)} {
		_, err := New(key, "https://example.com", Options{})
		errorKind(t, err, Configuration)
	}
	for _, email := range []string{strings.Repeat("a", 1013), "\xff", strings.Repeat("é", 507)} {
		_, err := encodeEmail(email)
		errorKind(t, err, Validation)
	}
	if body, err := encodeEmail(strings.Repeat("a", 1012)); err != nil || len(body) != 1024 {
		t.Fatal("byte boundary")
	}
	for _, options := range []Options{{Timeout: -1}, {MaxConnections: -1}, {MaxInFlight: 65537}, {MaxConnections: 1, MaxIdleConnections: 2}} {
		_, err := New("test-key", "https://example.com", options)
		errorKind(t, err, Configuration)
	}
}
func TestSchemaAndRetryAfter(t *testing.T) {
	for _, raw := range []string{`{}`, `null`, `[]`, strings.Replace(success, `true`, `"true"`, 1), strings.Replace(success, `false`, `null`, 1), strings.Replace(success, `not_listed`, `blocked_domain`, 1), strings.Replace(success, `custom`, `unknown`, 1)} {
		_, err := parseCheck([]byte(raw), http.Header{})
		errorKind(t, err, Protocol)
	}
	if retryAfter("not a date") != nil || *retryAfter("99999999") != 24*time.Hour || *retryAfter("000000") != 0 {
		t.Fatal("invalid Retry-After")
	}
}

func TestBulkRoundTripAndReuse(t *testing.T) {
	for _, h2 := range []bool{false, true} {
		t.Run(fmt.Sprint(h2), func(t *testing.T) {
			c, connections, _, healthAuth := fixture(t, h2)
			if _, err := c.Warmup(context.Background()); err != nil {
				t.Fatal(err)
			}
			result, err := c.CheckBulk(context.Background(), []string{"a@example.com", "broken", "a@example.com", ""})
			if err != nil || result.Checked != 2 || result.Failed != 2 || result.Results[1].Error.Code != "invalid_email" || result.Results[0].Result == nil {
				t.Fatalf("bulk result: %v, %v", result, err)
			}
			if strings.Contains(fmt.Sprint(result), "private") || connections.Load() != 1 || healthAuth.Load() != 0 {
				t.Fatal("privacy or connection reuse failed")
			}
			for index, item := range result.Results {
				if item.Index != index {
					t.Fatal("incorrect result position")
				}
			}
			if _, err := c.Check(context.Background(), "a@example.com"); err != nil {
				t.Fatal(err)
			}
			emails := make([]string, 100)
			for i := range emails {
				emails[i] = "a@example.com"
			}
			result, err = c.CheckBulk(context.Background(), emails)
			if err != nil || result.Checked != 100 {
				t.Fatalf("boundary: %v", err)
			}
			result, err = c.CheckBulk(context.Background(), []string{"broken", ""})
			if err != nil || result.Checked != 0 || result.Failed != 2 {
				t.Fatal("invalid items")
			}
			if _, err = c.CheckBulk(context.Background(), []string{"padded@example.com"}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestBulkValidationAndSchemas(t *testing.T) {
	for _, emails := range [][]string{nil, {}, make([]string, 101), {"\xff"}, {strings.Repeat("x", 65523)}, {strings.Repeat("é", 32762)}} {
		_, err := encodeBulk(emails)
		errorKind(t, err, Validation)
	}
	if body, err := encodeBulk([]string{strings.Repeat("x", 65521)}); err != nil || len(body) != 65536 {
		t.Fatal("exact body bound")
	}
	for _, raw := range []string{
		`{"results":[],"checked":1,"failed":0}`,
		`{"results":[{"index":true}],"checked":0,"failed":1}`,
		`{"results":[{"index":null,"error":{"code":"invalid_email"}}],"checked":0,"failed":1}`,
		`{"results":[{"index":0,"error":{"code":"private"}}],"checked":0,"failed":1}`,
		`{"results":[{"index":0,"valid":true,"error":{"code":"invalid_email"}}],"checked":0,"failed":1}`,
		`{"results":[{"index":0,"error":{"code":"invalid_email"}}],"checked":1,"failed":0}`,
	} {
		_, err := parseBulk([]byte(raw), nil, 1)
		errorKind(t, err, Protocol)
	}
}

func TestBulkNoReplayAndDeadline(t *testing.T) {
	c, _, checks, _ := fixture(t, false)
	for _, mode := range []string{"quota", "redirect", "unavailable", "truncated"} {
		before := checks.Load()
		_, err := c.CheckBulk(context.Background(), []string{mode + "@example.com"})
		if err == nil || checks.Load() != before+1 {
			t.Fatal("bulk request replayed")
		}
		if mode == "quota" {
			sdk := errorKind(t, err, API)
			if sdk.Code != "monthly_quota_exceeded" || sdk.StatusCode != 429 {
				t.Fatal("quota error")
			}
		}
	}
	_, err := c.CheckBulk(context.Background(), []string{"oversized@example.com"})
	errorKind(t, err, Protocol)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err = c.CheckBulk(ctx, []string{"slow@example.com"})
	errorKind(t, err, Timeout)
	canceled, stop := context.WithCancel(context.Background())
	stop()
	_, err = c.CheckBulk(canceled, []string{"a@example.com"})
	errorKind(t, err, Canceled)
}
