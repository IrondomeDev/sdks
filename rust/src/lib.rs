#![forbid(unsafe_code)]
//! Persistent, credential-isolated IronDome clients. Clone a client to share its
//! connection pool. No API call is automatically retried or cached by this SDK.

use reqwest::header::{HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tokio::sync::Semaphore;

const MAX_RESPONSE_BYTES: usize = 16_384;
const MAX_BULK_BYTES: usize = 65_536;
/// Default unified production API origin for stable account credentials.
pub const DEFAULT_BASE_URL: &str = "https://api.irondome.dev";
const CODES: &[&str] = &[
    "empty_body",
    "invalid_content_length",
    "invalid_body_length",
    "invalid_json",
    "authorization_required",
    "invalid_authorization",
    "invalid_api_key",
    "expired_api_key",
    "inactive_api_key",
    "revoked_api_key",
    "insufficient_scope",
    "not_found",
    "method_not_allowed",
    "content_length_required",
    "body_too_large",
    "invalid_email",
    "internal_error",
    "service_unavailable",
    "monthly_quota_exceeded",
    "empty_batch",
    "batch_too_large",
];

/// Safe errors never retain the underlying HTTP request, body, or credential.
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    Configuration,
    Validation,
    Protocol,
    Transport,
    Timeout,
    Busy,
    Api {
        status: u16,
        code: String,
        request_id: Option<String>,
        retry_after: Option<Duration>,
    },
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Api { status, code, .. } => {
                write!(f, "IronDome request failed (HTTP {status}, {code}).")
            }
            Self::Configuration => f.write_str("Invalid IronDome client configuration."),
            Self::Validation => f.write_str("Invalid IronDome request or body limit."),
            Self::Protocol => f.write_str("Invalid or oversized IronDome response."),
            Self::Transport => f.write_str("Secure request failed; delivery may be unknown."),
            Self::Timeout => f.write_str("Request deadline exceeded; delivery may be unknown."),
            Self::Busy => f.write_str("Client in-flight limit reached."),
        }
    }
}
impl std::error::Error for Error {}

/// Configure once at startup. All durations must be positive and at most one day.
#[derive(Clone)]
pub struct Options {
    /// Trusted API origin. Defaults to [`DEFAULT_BASE_URL`].
    pub base_url: String,
    pub timeout: Duration,
    pub connect_timeout: Duration,
    pub idle_timeout: Duration,
    pub max_idle_connections: usize,
    pub max_in_flight: usize,
    pub http1_only: bool,
    /// Additional trusted CA certificates in PEM format. Verification stays enabled.
    pub additional_root_certificates: Vec<Vec<u8>>,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_BASE_URL.to_owned(),
            timeout: Duration::from_secs(5),
            connect_timeout: Duration::from_secs(2),
            idle_timeout: Duration::from_secs(20),
            max_idle_connections: 8,
            max_in_flight: 64,
            http1_only: false,
            additional_root_certificates: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Gmail,
    Microsoft,
    Icloud,
    Proton,
    Yahoo,
    Custom,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    BlockedEmail,
    BlockedDomain,
    AllowedDomain,
    NotListed,
}

/// Syntax/list classification only. This does not verify mailbox existence.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CheckResult {
    pub provider: Provider,
    pub valid: bool,
    pub disposable: bool,
    pub reason: Reason,
    #[serde(skip)]
    pub request_id: Option<String>,
    #[serde(skip)]
    pub detector_version: Option<String>,
}
#[derive(Clone, Debug)]
pub struct HealthResult {
    pub request_id: Option<String>,
    pub detector_version: Option<String>,
}
#[derive(Clone, Debug)]
pub struct BulkItemError {
    pub code: &'static str,
    pub message: &'static str,
}
#[derive(Clone, Debug)]
pub enum BulkOutcome {
    Checked(CheckResult),
    Invalid(BulkItemError),
}
#[derive(Clone, Debug)]
pub struct BulkItem {
    pub index: usize,
    pub outcome: BulkOutcome,
}
#[derive(Clone, Debug)]
pub struct BulkResult {
    pub results: Vec<BulkItem>,
    pub checked: usize,
    pub failed: usize,
    pub request_id: Option<String>,
    pub detector_version: Option<String>,
}
struct Inner {
    http: reqwest::Client,
    authorization: HeaderValue,
    check_url: reqwest::Url,
    bulk_url: reqwest::Url,
    health_url: reqwest::Url,
    slots: Semaphore,
}
/// Clones share the same pool and admission limit. Drop all clones after use.
#[derive(Clone)]
pub struct Client(Arc<Inner>);
impl fmt::Debug for Client {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("irondome::Client(credentials=REDACTED)")
    }
}

impl Client {
    /// Construct without network I/O. `Options::base_url` is trusted server
    /// configuration, not an incoming request parameter. TLS verification stays enabled.
    pub fn new(api_key: &str, options: Options) -> Result<Self, Error> {
        let origin = validate_origin(&options.base_url)?;
        if api_key.is_empty()
            || api_key.len() > 4096
            || !api_key.bytes().all(|b| (33..=126).contains(&b))
        {
            return Err(Error::Configuration);
        }
        for duration in [
            options.timeout,
            options.connect_timeout,
            options.idle_timeout,
        ] {
            if duration.is_zero() || duration > Duration::from_secs(86400) {
                return Err(Error::Configuration);
            }
        }
        if !(1..=65536).contains(&options.max_in_flight)
            || !(1..=options.max_in_flight).contains(&options.max_idle_connections)
        {
            return Err(Error::Configuration);
        }
        let mut authorization = HeaderValue::from_str(&format!("Bearer {api_key}"))
            .map_err(|_| Error::Configuration)?;
        authorization.set_sensitive(true);
        let mut builder = reqwest::Client::builder()
            .https_only(true)
            .tls_backend_rustls()
            .tls_version_min(reqwest::tls::Version::TLS_1_2)
            .tls_sslkeylogfile(false)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .referer(false)
            .no_proxy()
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd()
            .timeout(options.timeout)
            .connect_timeout(options.connect_timeout)
            .pool_idle_timeout(options.idle_timeout)
            .pool_max_idle_per_host(options.max_idle_connections)
            .tcp_nodelay(true)
            .tcp_keepalive(Duration::from_secs(30));
        if options.http1_only {
            builder = builder.http1_only();
        }
        if !options.additional_root_certificates.is_empty() {
            let certs = options
                .additional_root_certificates
                .iter()
                .map(|pem| reqwest::Certificate::from_pem(pem).map_err(|_| Error::Configuration))
                .collect::<Result<Vec<_>, _>>()?;
            builder = builder.tls_certs_merge(certs);
        }
        Ok(Self(Arc::new(Inner {
            http: builder.build().map_err(|_| Error::Configuration)?,
            authorization,
            check_url: origin.join("/v1/check").map_err(|_| Error::Configuration)?,
            bulk_url: origin
                .join("/v1/check/bulk")
                .map_err(|_| Error::Configuration)?,
            health_url: origin.join("/healthz").map_err(|_| Error::Configuration)?,
            slots: Semaphore::new(options.max_in_flight),
        })))
    }

    pub async fn check(&self, email: &str) -> Result<CheckResult, Error> {
        let body = encode_email(email)?;
        let (raw, headers) = self.request(Some(body), false).await?;
        parse_check(&raw, &headers)
    }

    /// Check 1â€“100 emails in one POST. Invalid items consume no check units.
    /// A timed-out POST can already have completed; it is never retried here.
    pub async fn check_bulk<S: AsRef<str>>(&self, emails: &[S]) -> Result<BulkResult, Error> {
        let body = encode_bulk(emails)?;
        let (raw, headers) = self.request(Some(body), true).await?;
        parse_bulk(&raw, &headers, emails.len())
    }

    /// Optional unauthenticated GET. Call ahead of independent startup work,
    /// never as an automatic prerequisite to every check.
    pub async fn warmup(&self) -> Result<HealthResult, Error> {
        let (raw, headers) = self.request(None, false).await?;
        #[derive(Deserialize)]
        struct Health {
            status: String,
        }
        let data: Health = serde_json::from_slice(&raw).map_err(|_| Error::Protocol)?;
        if data.status != "ok" {
            return Err(Error::Protocol);
        }
        Ok(HealthResult {
            request_id: metadata(&headers, "x-request-id"),
            detector_version: metadata(&headers, "x-detector-base-version"),
        })
    }

    async fn request(
        &self,
        body: Option<Vec<u8>>,
        bulk: bool,
    ) -> Result<(Vec<u8>, HeaderMap), Error> {
        let _permit = self.0.slots.try_acquire().map_err(|_| Error::Busy)?;
        let limit = if bulk {
            MAX_BULK_BYTES
        } else {
            MAX_RESPONSE_BYTES
        };
        let request = match body {
            Some(body) => self
                .0
                .http
                .post(if bulk {
                    self.0.bulk_url.clone()
                } else {
                    self.0.check_url.clone()
                })
                .header("authorization", self.0.authorization.clone())
                .header("content-type", "application/json")
                .header("content-length", body.len())
                .body(body),
            None => self.0.http.get(self.0.health_url.clone()),
        };
        let mut response = request
            .header("accept", "application/json")
            .header("accept-encoding", "identity")
            .header("cache-control", "no-store")
            .send()
            .await
            .map_err(transport_error)?;
        let headers = response.headers().clone();
        let status = response.status().as_u16();
        if response.content_length().is_some_and(|n| n > limit as u64)
            || headers
                .get("content-encoding")
                .is_some_and(|v| v.as_bytes() != b"identity")
        {
            return Err(Error::Protocol);
        }
        let mut raw = Vec::with_capacity(256);
        while let Some(chunk) = response.chunk().await.map_err(transport_error)? {
            if raw.len() + chunk.len() > limit {
                return Err(Error::Protocol);
            }
            raw.extend_from_slice(&chunk);
        }
        let is_json = headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                v.split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .eq_ignore_ascii_case("application/json")
            });
        if status != 200 {
            let mut code = "http_error".to_owned();
            if is_json {
                if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&raw) {
                    if let Some(candidate) = value
                        .get("error")
                        .and_then(|v| v.get("code"))
                        .and_then(|v| v.as_str())
                    {
                        if CODES.contains(&candidate) {
                            code = candidate.to_owned();
                        }
                    }
                }
            }
            return Err(Error::Api {
                status,
                code,
                request_id: metadata(&headers, "x-request-id"),
                retry_after: retry_after(headers.get("retry-after").and_then(|v| v.to_str().ok())),
            });
        }
        if !is_json {
            return Err(Error::Protocol);
        }
        Ok((raw, headers))
    }
}

fn validate_origin(value: &str) -> Result<reqwest::Url, Error> {
    let (scheme, authority) = value.split_once("://").ok_or(Error::Configuration)?;
    let authority = authority.strip_suffix('/').unwrap_or(authority);
    if !scheme.eq_ignore_ascii_case("https")
        || authority.is_empty()
        || authority
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "/\\?#@".contains(c))
    {
        return Err(Error::Configuration);
    }
    let url = reqwest::Url::parse(value).map_err(|_| Error::Configuration)?;
    if url.host_str().is_none()
        || url.port() == Some(0)
        || matches!(
            url.host_str().map(|host| host.trim_end_matches('.')),
            Some("free.irondome.dev" | "irondome-free.edgecompute.app")
        )
    {
        return Err(Error::Configuration);
    }
    Ok(url)
}
fn encode_email(email: &str) -> Result<Vec<u8>, Error> {
    if email.len() > 1024 {
        return Err(Error::Validation);
    }
    #[derive(Serialize)]
    struct Input<'a> {
        email: &'a str,
    }
    let body = serde_json::to_vec(&Input { email }).map_err(|_| Error::Validation)?;
    if body.len() > 1024 {
        return Err(Error::Validation);
    }
    Ok(body)
}
fn parse_check(raw: &[u8], headers: &HeaderMap) -> Result<CheckResult, Error> {
    let mut result: CheckResult = serde_json::from_slice(raw).map_err(|_| Error::Protocol)?;
    if !result.valid
        || result.disposable
            != matches!(result.reason, Reason::BlockedEmail | Reason::BlockedDomain)
    {
        return Err(Error::Protocol);
    }
    result.request_id = metadata(headers, "x-request-id");
    result.detector_version = metadata(headers, "x-detector-base-version");
    Ok(result)
}
fn encode_bulk<S: AsRef<str>>(emails: &[S]) -> Result<Vec<u8>, Error> {
    if !(1..=100).contains(&emails.len()) {
        return Err(Error::Validation);
    }
    let mut bytes = 0usize;
    for email in emails {
        bytes = bytes
            .checked_add(email.as_ref().len())
            .ok_or(Error::Validation)?;
        if bytes > MAX_BULK_BYTES {
            return Err(Error::Validation);
        }
    }
    #[derive(Serialize)]
    struct Input<'a> {
        emails: Vec<&'a str>,
    }
    let body = serde_json::to_vec(&Input {
        emails: emails.iter().map(AsRef::as_ref).collect(),
    })
    .map_err(|_| Error::Validation)?;
    if body.len() > MAX_BULK_BYTES {
        return Err(Error::Validation);
    }
    Ok(body)
}
fn parse_bulk(raw: &[u8], headers: &HeaderMap, count: usize) -> Result<BulkResult, Error> {
    #[derive(Deserialize)]
    struct Wire {
        results: Vec<serde_json::Value>,
        checked: usize,
        failed: usize,
    }
    let wire: Wire = serde_json::from_slice(raw).map_err(|_| Error::Protocol)?;
    if wire.results.len() != count || wire.checked > count || wire.failed != count - wire.checked {
        return Err(Error::Protocol);
    }
    let mut results = Vec::with_capacity(count);
    let mut checked = 0;
    for (index, value) in wire.results.into_iter().enumerate() {
        let object = value.as_object().ok_or(Error::Protocol)?;
        if object.get("index").and_then(serde_json::Value::as_u64) != Some(index as u64) {
            return Err(Error::Protocol);
        }
        let outcome = if let Some(error) = object.get("error") {
            if error.get("code").and_then(serde_json::Value::as_str) != Some("invalid_email")
                || ["provider", "valid", "disposable", "reason"]
                    .iter()
                    .any(|key| object.contains_key(*key))
            {
                return Err(Error::Protocol);
            }
            BulkOutcome::Invalid(BulkItemError {
                code: "invalid_email",
                message: "Provide a syntactically valid email address.",
            })
        } else {
            let result: CheckResult = serde_json::from_value(value).map_err(|_| Error::Protocol)?;
            if !result.valid
                || result.disposable
                    != matches!(result.reason, Reason::BlockedEmail | Reason::BlockedDomain)
            {
                return Err(Error::Protocol);
            }
            checked += 1;
            BulkOutcome::Checked(result)
        };
        results.push(BulkItem { index, outcome });
    }
    if checked != wire.checked {
        return Err(Error::Protocol);
    }
    Ok(BulkResult {
        results,
        checked,
        failed: wire.failed,
        request_id: metadata(headers, "x-request-id"),
        detector_version: metadata(headers, "x-detector-base-version"),
    })
}
fn metadata(headers: &HeaderMap, name: &str) -> Option<String> {
    let value = headers.get(name)?.to_str().ok()?;
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
    {
        return None;
    }
    Some(value.to_owned())
}
fn retry_after(value: Option<&str>) -> Option<Duration> {
    let value = value?;
    if value.is_empty() || value.len() > 128 {
        return None;
    }
    let seconds = if value.bytes().all(|b| b.is_ascii_digit()) {
        let digits = value.trim_start_matches('0');
        if digits.is_empty() {
            0
        } else {
            digits.parse::<u64>().unwrap_or(u64::MAX).min(86400)
        }
    } else {
        let date = httpdate::parse_http_date(value).ok()?;
        let delta = date.duration_since(SystemTime::now()).unwrap_or_default();
        delta
            .as_secs()
            .saturating_add(u64::from(delta.subsec_nanos() > 0))
            .min(86400)
    };
    Some(Duration::from_secs(seconds))
}
fn transport_error(error: reqwest::Error) -> Error {
    if error.is_timeout() {
        Error::Timeout
    } else {
        Error::Transport
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn origin_and_byte_limits() {
        for value in [
            "http://host",
            "https://u:p@host",
            "https://host/x/..",
            "https://host?",
            "https://host#",
            "https://host:0",
            "https://host\\x",
        ] {
            assert!(validate_origin(value).is_err());
        }
        for value in [
            "https://free.irondome.dev",
            "https://irondome-free.edgecompute.app",
            "https://FREE.irondome.dev./",
            "https://irondome-free.edgecompute.app./",
        ] {
            assert!(validate_origin(value).is_err());
        }
        assert!(validate_origin("https://example.com/").is_ok());
        assert_eq!(encode_email(&"a".repeat(1012)).unwrap().len(), 1024);
        assert!(encode_email(&"a".repeat(1013)).is_err());
        assert!(encode_email(&"Ã©".repeat(507)).is_err());
    }
    #[test]
    fn strict_schema() {
        for raw in [
            r#"{}"#,
            r#"null"#,
            r#"{"provider":"custom","valid":true,"disposable":false,"reason":"blocked_domain"}"#,
            r#"{"provider":"custom","valid":"true","disposable":false,"reason":"not_listed"}"#,
        ] {
            assert!(parse_check(raw.as_bytes(), &HeaderMap::new()).is_err());
        }
        assert_eq!(retry_after(Some("000000")), Some(Duration::ZERO));
        assert_eq!(
            retry_after(Some("999999999999999999999")),
            Some(Duration::from_secs(86400))
        );
        assert_eq!(retry_after(Some("private")), None);
    }
    #[test]
    fn bulk_body_limits() {
        assert!(encode_bulk::<&str>(&[]).is_err());
        assert!(encode_bulk(&["x"; 101]).is_err());
        assert_eq!(encode_bulk(&["x".repeat(65521)]).unwrap().len(), 65536);
        assert!(encode_bulk(&["x".repeat(65523)]).is_err());
        assert!(encode_bulk(&["Ã©".repeat(32762)]).is_err());
        assert!(encode_bulk(&["a@example.com"; 100]).is_ok());
    }
    #[test]
    fn bulk_order_counts_and_safe_errors() {
        let raw=br#"{"results":[{"index":0,"provider":"custom","valid":true,"disposable":false,"reason":"not_listed"},{"index":1,"error":{"code":"invalid_email","message":"private"}}],"checked":1,"failed":1}"#;
        let result = parse_bulk(raw, &HeaderMap::new(), 2).unwrap();
        assert_eq!(result.checked, 1);
        assert_eq!(result.failed, 1);
        assert!(matches!(result.results[0].outcome, BulkOutcome::Checked(_)));
        assert!(matches!(result.results[1].outcome, BulkOutcome::Invalid(_)));
        assert!(!format!("{result:?}").contains("private"));
        for raw in [
            r#"{"results":[],"checked":1,"failed":0}"#,
            r#"{"results":[{"index":true}],"checked":0,"failed":1}"#,
            r#"{"results":[{"index":null,"error":{"code":"invalid_email"}}],"checked":0,"failed":1}"#,
            r#"{"results":[{"index":0,"error":{"code":"private"}}],"checked":0,"failed":1}"#,
            r#"{"results":[{"index":0,"valid":true,"error":{"code":"invalid_email"}}],"checked":0,"failed":1}"#,
            r#"{"results":[{"index":0,"error":{"code":"invalid_email"}}],"checked":1,"failed":0}"#,
        ] {
            assert!(parse_bulk(raw.as_bytes(), &HeaderMap::new(), 1).is_err());
        }
    }
}
