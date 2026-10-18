// Package irondome provides a concurrent, pooled client for the IronDome API.
package irondome

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// DefaultBaseURL is the unified origin for both free and paid credentials.
const DefaultBaseURL = "https://api.irondome.dev"

const maxResponseBytes = 16384
const maxBulkBytes = 65536

// Kind identifies a failure without retaining a request, credential, or response body.
type Kind string

const (
	Configuration Kind = "configuration"
	Validation    Kind = "validation"
	Protocol      Kind = "protocol"
	Transport     Kind = "transport"
	Timeout       Kind = "timeout"
	Canceled      Kind = "canceled"
	Busy          Kind = "busy"
	Closed        Kind = "closed"
	API           Kind = "api"
)

// Error contains only bounded, allowlisted diagnostic metadata. Delivery can be
// unknown after a timeout or transport failure; Check is never retried by the SDK.
type Error struct {
	Kind       Kind
	StatusCode int
	Code       string
	RequestID  string
	RetryAfter *time.Duration
}

func (e *Error) Error() string {
	if e.Kind == API {
		return fmt.Sprintf("IronDome request failed (HTTP %d, %s).", e.StatusCode, e.Code)
	}
	return "IronDome " + string(e.Kind) + " failure."
}
func (e *Error) Unwrap() error {
	if e.Kind == Timeout {
		return context.DeadlineExceeded
	}
	if e.Kind == Canceled {
		return context.Canceled
	}
	return nil
}

// Options configures a client. Zero values select defaults. RootCAs replaces the
// system trust roots when non-nil and is cloned at construction.
type Options struct {
	// BaseURL overrides the production origin for trusted staging or local TLS tests.
	BaseURL            string
	Timeout            time.Duration
	ConnectTimeout     time.Duration
	IdleTimeout        time.Duration
	MaxConnections     int
	MaxIdleConnections int
	MaxInFlight        int
	HTTP1Only          bool
	RootCAs            *x509.CertPool
}

// CheckResult describes syntax and list classification, not mailbox existence.
type CheckResult struct {
	Provider        string `json:"provider"`
	Valid           bool   `json:"valid"`
	Disposable      bool   `json:"disposable"`
	Reason          string `json:"reason"`
	RequestID       string `json:"-"`
	DetectorVersion string `json:"-"`
}
type HealthResult struct{ RequestID, DetectorVersion string }

// BulkItem contains exactly one of Result and Error, preserving the input index.
type BulkItem struct {
	Index  int
	Result *CheckResult
	Error  *BulkItemError
}
type BulkItemError struct{ Code, Message string }
type BulkResult struct {
	Results                    []BulkItem
	Checked, Failed            int
	RequestID, DetectorVersion string
}

// Client is safe for concurrent use. Reuse it rather than constructing per check.
type Client struct {
	origin, authorization string
	http                  *http.Client
	transport             *http.Transport
	slots                 chan struct{}
	mu                    sync.Mutex
	closed                bool
}

func (c *Client) String() string   { return "irondome.Client(credentials=REDACTED)" }
func (c *Client) GoString() string { return c.String() }

var originPattern = regexp.MustCompile(`(?i)^https://[^/?#\\\s]+/?$`)
var metadataPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
var digitsPattern = regexp.MustCompile(`^[0-9]+$`)
var errorCodes = strings.Fields("empty_body invalid_content_length invalid_body_length invalid_json authorization_required invalid_authorization invalid_api_key expired_api_key inactive_api_key revoked_api_key insufficient_scope not_found method_not_allowed content_length_required body_too_large invalid_email internal_error service_unavailable monthly_quota_exceeded empty_batch batch_too_large")

// New creates a client without network I/O, defaulting to the unified production origin.
func New(apiKey string, options Options) (*Client, error) {
	baseURL := options.BaseURL
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	u, err := url.Parse(baseURL)
	if err != nil || !originPattern.MatchString(baseURL) || u.Hostname() == "" || u.User != nil || strings.Contains(baseURL, "@") {
		return nil, &Error{Kind: Configuration}
	}
	if host := strings.ToLower(strings.TrimSuffix(u.Hostname(), ".")); host == "free.irondome.dev" || host == "irondome-free.edgecompute.app" {
		return nil, &Error{Kind: Configuration}
	}
	if p := u.Port(); p != "" {
		n, e := strconv.Atoi(p)
		if e != nil || n < 1 || n > 65535 {
			return nil, &Error{Kind: Configuration}
		}
	}
	if len(apiKey) == 0 || len(apiKey) > 4096 {
		return nil, &Error{Kind: Configuration}
	}
	for _, b := range []byte(apiKey) {
		if b < 33 || b > 126 {
			return nil, &Error{Kind: Configuration}
		}
	}
	if options.Timeout < 0 || options.ConnectTimeout < 0 || options.IdleTimeout < 0 {
		return nil, &Error{Kind: Configuration}
	}
	if options.Timeout == 0 {
		options.Timeout = 5 * time.Second
	}
	if options.ConnectTimeout == 0 {
		options.ConnectTimeout = 2 * time.Second
	}
	if options.IdleTimeout == 0 {
		options.IdleTimeout = 20 * time.Second
	}
	if options.MaxConnections == 0 {
		options.MaxConnections = 32
	}
	if options.MaxIdleConnections == 0 {
		options.MaxIdleConnections = min(8, options.MaxConnections)
	}
	if options.MaxInFlight == 0 {
		options.MaxInFlight = 64
	}
	for _, n := range []int{options.MaxConnections, options.MaxIdleConnections, options.MaxInFlight} {
		if n < 1 || n > 65536 {
			return nil, &Error{Kind: Configuration}
		}
	}
	if options.MaxIdleConnections > options.MaxConnections {
		return nil, &Error{Kind: Configuration}
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12, ClientSessionCache: tls.NewLRUClientSessionCache(64)}
	if options.RootCAs != nil {
		tlsConfig.RootCAs = options.RootCAs.Clone()
	}
	transport := &http.Transport{
		Proxy:           nil,
		DialContext:     (&net.Dialer{Timeout: options.ConnectTimeout, KeepAlive: 30 * time.Second}).DialContext,
		TLSClientConfig: tlsConfig, ForceAttemptHTTP2: !options.HTTP1Only,
		MaxIdleConns: options.MaxIdleConnections, MaxIdleConnsPerHost: options.MaxIdleConnections,
		MaxConnsPerHost: options.MaxConnections, IdleConnTimeout: options.IdleTimeout,
		TLSHandshakeTimeout: options.ConnectTimeout, MaxResponseHeaderBytes: 16384, DisableCompression: true,
	}
	if options.HTTP1Only {
		transport.TLSNextProto = make(map[string]func(string, *tls.Conn) http.RoundTripper)
	}
	u.Scheme = "https"
	return &Client{origin: strings.TrimRight(u.String(), "/"), authorization: "Bearer " + apiKey, transport: transport,
		slots: make(chan struct{}, options.MaxInFlight), http: &http.Client{Transport: transport, Timeout: options.Timeout,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

// Close releases idle connections and prevents new calls. In-flight calls finish
// under their contexts. Call after application work, not at each Lambda return.
func (c *Client) Close() {
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
	c.transport.CloseIdleConnections()
}

func encodeEmail(email string) ([]byte, error) {
	if !utf8.ValidString(email) || len(email) > 1024 {
		return nil, &Error{Kind: Validation}
	}
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if encoder.Encode(struct {
		Email string `json:"email"`
	}{email}) != nil {
		return nil, &Error{Kind: Validation}
	}
	body := bytes.TrimSuffix(buf.Bytes(), []byte{'\n'})
	if len(body) > 1024 {
		return nil, &Error{Kind: Validation}
	}
	return body, nil
}

func (c *Client) Check(ctx context.Context, email string) (CheckResult, error) {
	body, err := encodeEmail(email)
	if err != nil {
		return CheckResult{}, err
	}
	raw, headers, err := c.request(ctx, false, body, false)
	if err != nil {
		return CheckResult{}, err
	}
	return parseCheck(raw, headers)
}

// Warmup establishes reusable transport state with an unauthenticated health GET.
// It does not warm authorization or detector state and is not an implicit Check step.
func (c *Client) Warmup(ctx context.Context) (HealthResult, error) {
	raw, headers, err := c.request(ctx, true, nil, false)
	if err != nil {
		return HealthResult{}, err
	}
	var value struct {
		Status string `json:"status"`
	}
	if json.Unmarshal(raw, &value) != nil || value.Status != "ok" {
		return HealthResult{}, &Error{Kind: Protocol}
	}
	return HealthResult{metadata(headers.Get("X-Request-ID")), metadata(headers.Get("X-Detector-Base-Version"))}, nil
}

// CheckBulk checks 1–100 strings with one HTTP request. It never retries a POST.
func (c *Client) CheckBulk(ctx context.Context, emails []string) (BulkResult, error) {
	body, err := encodeBulk(emails)
	if err != nil {
		return BulkResult{}, err
	}
	raw, headers, err := c.request(ctx, false, body, true)
	if err != nil {
		return BulkResult{}, err
	}
	return parseBulk(raw, headers, len(emails))
}

func encodeBulk(emails []string) ([]byte, error) {
	if len(emails) < 1 || len(emails) > 100 {
		return nil, &Error{Kind: Validation}
	}
	bytesCount := 0
	for _, email := range emails {
		if !utf8.ValidString(email) || len(email) > maxBulkBytes-bytesCount {
			return nil, &Error{Kind: Validation}
		}
		bytesCount += len(email)
	}
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if encoder.Encode(struct {
		Emails []string `json:"emails"`
	}{emails}) != nil {
		return nil, &Error{Kind: Validation}
	}
	body := bytes.TrimSuffix(buf.Bytes(), []byte{'\n'})
	if len(body) > maxBulkBytes {
		return nil, &Error{Kind: Validation}
	}
	return body, nil
}

func parseBulk(raw []byte, headers http.Header, count int) (BulkResult, error) {
	var wire struct {
		Results []json.RawMessage `json:"results"`
		Checked *int              `json:"checked"`
		Failed  *int              `json:"failed"`
	}
	if json.Unmarshal(raw, &wire) != nil || len(wire.Results) != count || wire.Checked == nil || wire.Failed == nil ||
		*wire.Checked < 0 || *wire.Failed < 0 || *wire.Checked > count || *wire.Failed != count-*wire.Checked {
		return BulkResult{}, &Error{Kind: Protocol}
	}
	result := BulkResult{Results: make([]BulkItem, 0, count), RequestID: metadata(headers.Get("X-Request-ID")), DetectorVersion: metadata(headers.Get("X-Detector-Base-Version"))}
	for index, encoded := range wire.Results {
		var item map[string]json.RawMessage
		var position int
		if json.Unmarshal(encoded, &item) != nil || item == nil || item["index"] == nil || string(item["index"]) == "null" || json.Unmarshal(item["index"], &position) != nil || position != index {
			return BulkResult{}, &Error{Kind: Protocol}
		}
		if detail, exists := item["error"]; exists {
			var failure struct {
				Code string `json:"code"`
			}
			if json.Unmarshal(detail, &failure) != nil || failure.Code != "invalid_email" {
				return BulkResult{}, &Error{Kind: Protocol}
			}
			for _, field := range []string{"provider", "valid", "disposable", "reason"} {
				if _, exists := item[field]; exists {
					return BulkResult{}, &Error{Kind: Protocol}
				}
			}
			result.Results = append(result.Results, BulkItem{Index: index, Error: &BulkItemError{Code: "invalid_email", Message: "Provide a syntactically valid email address."}})
			result.Failed++
		} else {
			check, err := parseCheck(encoded, nil)
			if err != nil {
				return BulkResult{}, err
			}
			result.Results = append(result.Results, BulkItem{Index: index, Result: &check})
			result.Checked++
		}
	}
	if result.Checked != *wire.Checked {
		return BulkResult{}, &Error{Kind: Protocol}
	}
	return result, nil
}

func (c *Client) request(ctx context.Context, health bool, body []byte, bulk bool) ([]byte, http.Header, error) {
	if ctx == nil {
		return nil, nil, &Error{Kind: Configuration}
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, nil, &Error{Kind: Closed}
	}
	select {
	case c.slots <- struct{}{}:
	default:
		c.mu.Unlock()
		return nil, nil, &Error{Kind: Busy}
	}
	c.mu.Unlock()
	defer func() { <-c.slots }()
	method, path := "POST", "/v1/check"
	limit := maxResponseBytes
	if bulk {
		path = "/v1/check/bulk"
		limit = maxBulkBytes
	}
	if health {
		method, path = "GET", "/healthz"
	}
	req, err := http.NewRequestWithContext(ctx, method, c.origin+path, bytes.NewReader(body))
	if err != nil {
		return nil, nil, &Error{Kind: Configuration}
	}
	// No replay body or idempotency marker for the billable POST.
	req.GetBody = nil
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Encoding", "identity")
	req.Header.Set("Cache-Control", "no-store")
	if !health {
		req.Header.Set("Authorization", c.authorization)
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, nil, transportError(err)
	}
	defer res.Body.Close()
	if res.ContentLength > int64(limit) || (res.Header.Get("Content-Encoding") != "" && !strings.EqualFold(res.Header.Get("Content-Encoding"), "identity")) {
		return nil, nil, &Error{Kind: Protocol}
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, int64(limit+1)))
	if err != nil {
		return nil, nil, transportError(err)
	}
	if len(raw) > limit {
		return nil, nil, &Error{Kind: Protocol}
	}
	isJSON := strings.EqualFold(strings.TrimSpace(strings.Split(res.Header.Get("Content-Type"), ";")[0]), "application/json") && utf8.Valid(raw)
	if res.StatusCode != http.StatusOK {
		code := "http_error"
		var value struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if isJSON && json.Unmarshal(raw, &value) == nil && contains(errorCodes, value.Error.Code) {
			code = value.Error.Code
		}
		return nil, nil, &Error{Kind: API, StatusCode: res.StatusCode, Code: code, RequestID: metadata(res.Header.Get("X-Request-ID")), RetryAfter: retryAfter(res.Header.Get("Retry-After"))}
	}
	if !isJSON {
		return nil, nil, &Error{Kind: Protocol}
	}
	return raw, res.Header, nil
}

func transportError(err error) error {
	if errors.Is(err, context.Canceled) {
		return &Error{Kind: Canceled}
	}
	var timeout net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &timeout) && timeout.Timeout()) {
		return &Error{Kind: Timeout}
	}
	return &Error{Kind: Transport}
}
func contains(values []string, value string) bool {
	for _, candidate := range values {
		if value == candidate {
			return true
		}
	}
	return false
}
func metadata(value string) string {
	if metadataPattern.MatchString(value) {
		return value
	}
	return ""
}
func retryAfter(value string) *time.Duration {
	if len(value) == 0 || len(value) > 128 {
		return nil
	}
	var seconds float64
	if digitsPattern.MatchString(value) {
		value = strings.TrimLeft(value, "0")
		if len(value) > 5 {
			seconds = 86400
		} else {
			seconds, _ = strconv.ParseFloat(value, 64)
		}
	} else {
		date, err := http.ParseTime(value)
		if err != nil {
			return nil
		}
		seconds = math.Ceil(time.Until(date).Seconds())
	}
	duration := time.Duration(min(86400, max(0, seconds))) * time.Second
	return &duration
}
func parseCheck(raw []byte, headers http.Header) (CheckResult, error) {
	var wire struct {
		Provider   string `json:"provider"`
		Valid      *bool  `json:"valid"`
		Disposable *bool  `json:"disposable"`
		Reason     string `json:"reason"`
	}
	if json.Unmarshal(raw, &wire) != nil || wire.Valid == nil || !*wire.Valid || wire.Disposable == nil ||
		!contains([]string{"gmail", "microsoft", "icloud", "proton", "yahoo", "custom"}, wire.Provider) ||
		!contains([]string{"blocked_email", "blocked_domain", "allowed_domain", "not_listed"}, wire.Reason) ||
		*wire.Disposable != (wire.Reason == "blocked_email" || wire.Reason == "blocked_domain") {
		return CheckResult{}, &Error{Kind: Protocol}
	}
	return CheckResult{wire.Provider, true, *wire.Disposable, wire.Reason, metadata(headers.Get("X-Request-ID")), metadata(headers.Get("X-Detector-Base-Version"))}, nil
}
