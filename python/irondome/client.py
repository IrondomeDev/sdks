"""Secure connection reuse without transparent replay of billable checks."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from http.cookiejar import CookieJar, DefaultCookiePolicy
import json
import math
import re
import ssl
import threading
import time
from typing import Any, Literal
from urllib.parse import urlsplit

import httpx

DEFAULT_BASE_URL = "https://api.irondome.dev"
MAX_RESPONSE_BYTES = 16_384
MAX_BULK_BYTES = 65_536
Provider = Literal["gmail", "microsoft", "icloud", "proton", "yahoo", "custom"]
Reason = Literal["blocked_email", "blocked_domain", "allowed_domain", "not_listed"]
_PROVIDERS = frozenset(("gmail", "microsoft", "icloud", "proton", "yahoo", "custom"))
_REASONS = frozenset(("blocked_email", "blocked_domain", "allowed_domain", "not_listed"))
_CODES = frozenset(("empty_body invalid_content_length invalid_body_length invalid_json "
    "authorization_required invalid_authorization invalid_api_key expired_api_key inactive_api_key "
    "revoked_api_key insufficient_scope not_found method_not_allowed content_length_required "
    "body_too_large invalid_email internal_error service_unavailable monthly_quota_exceeded empty_batch batch_too_large").split())


class IronDomeError(Exception):
    """Base class for errors containing no submitted email or bearer credential."""


class ConfigurationError(IronDomeError):
    pass


class ValidationError(IronDomeError):
    pass


class ProtocolError(IronDomeError):
    pass


class TransportError(IronDomeError):
    pass


class TimeoutError(TransportError):
    pass


class BusyError(IronDomeError):
    pass


class ClosedError(IronDomeError):
    pass


class APIError(IronDomeError):
    def __init__(self, status_code: int, code: str, request_id: str | None,
                 retry_after_seconds: int | None) -> None:
        super().__init__(f"IronDome request failed (HTTP {status_code}, {code}).")
        self.status_code = status_code
        self.code = code
        self.request_id = request_id
        self.retry_after_seconds = retry_after_seconds


@dataclass(frozen=True, slots=True)
class CheckResult:
    provider: Provider
    valid: bool
    disposable: bool
    reason: Reason
    request_id: str | None = None
    detector_version: str | None = None


@dataclass(frozen=True, slots=True)
class HealthResult:
    status: Literal["ok"] = "ok"
    request_id: str | None = None
    detector_version: str | None = None


@dataclass(frozen=True, slots=True)
class BulkItemError:
    code: Literal["invalid_email"] = "invalid_email"
    message: str = "Provide a syntactically valid email address."


@dataclass(frozen=True, slots=True)
class BulkItem:
    index: int
    result: CheckResult | None = None
    error: BulkItemError | None = None


@dataclass(frozen=True, slots=True)
class BulkResult:
    results: tuple[BulkItem, ...]
    checked: int
    failed: int
    request_id: str | None = None
    detector_version: str | None = None


def _positive(value: float, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or value <= 0:
        raise ConfigurationError(f"{name} must be a positive finite number.")
    return float(value)


def _count(value: int, name: str) -> int:
    if type(value) is not int or not 1 <= value <= 65_536:
        raise ConfigurationError(f"{name} must be an integer between 1 and 65536.")
    return value


def _origin(value: str) -> str:
    valid = False
    try:
        if isinstance(value, str) and re.fullmatch(r"https://[^/?#\\\s]+/?", value, re.IGNORECASE):
            parsed = urlsplit(value)
            valid = (bool(parsed.hostname) and parsed.username is None and parsed.password is None
                     and parsed.hostname.rstrip(".") not in ("free.irondome.dev", "irondome-free.edgecompute.app"))
            if parsed.port is not None and not 1 <= parsed.port <= 65535:
                valid = False
    except ValueError:
        valid = False
    if not valid:
        raise ConfigurationError("base_url must be a trusted HTTPS origin; legacy free endpoints are unsupported.")
    return value.rstrip("/")


def _body(email: str) -> bytes:
    if not isinstance(email, str) or len(email) > 1024:
        raise ValidationError("email must be a string fitting in a 1024-byte JSON body.")
    body = None
    try:
        body = json.dumps({"email": email}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    except UnicodeError:
        pass
    if body is None:
        raise ValidationError("email must contain valid Unicode.")
    if len(body) > 1024:
        raise ValidationError("Request body exceeds 1024 bytes.")
    return body


def _metadata(value: str | None) -> str | None:
    return value if value and re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", value) else None


def _bulk_body(emails: list[str] | tuple[str, ...]) -> bytes:
    if not isinstance(emails, (list, tuple)) or not 1 <= len(emails) <= 100:
        raise ValidationError("Provide between 1 and 100 email strings.")
    chars = 0
    for email in emails:
        if not isinstance(email, str):
            raise ValidationError("Bulk entries must be strings.")
        chars += len(email)
        if chars > MAX_BULK_BYTES:
            raise ValidationError("Bulk request exceeds its input limit.")
    body = None
    try:
        body = json.dumps({"emails": emails}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    except UnicodeError:
        pass
    if body is None:
        raise ValidationError("Emails must contain valid Unicode.")
    if len(body) > MAX_BULK_BYTES:
        raise ValidationError("Bulk request body exceeds 65536 bytes.")
    return body


def _retry_after(value: str | None) -> int | None:
    if not value or len(value) > 128:
        return None
    try:
        if re.fullmatch(r"[0-9]+", value):
            return min(86400, int(value))
        date = parsedate_to_datetime(value)
        if date.tzinfo is None:
            return None
        return min(86400, max(0, math.ceil((date - datetime.now(timezone.utc)).total_seconds())))
    except (ValueError, TypeError, OverflowError):
        return None


def _parse(status: int, headers: httpx.Headers, raw: bytes, health: bool,
           bulk_count: int = 0) -> CheckResult | HealthResult | BulkResult:
    if len(raw) > (MAX_BULK_BYTES if bulk_count else MAX_RESPONSE_BYTES):
        raise ProtocolError("Response exceeds its byte limit.")
    request_id = _metadata(headers.get("x-request-id"))
    version = _metadata(headers.get("x-detector-base-version"))
    data: Any = None
    try:
        if headers.get("content-type", "").split(";", 1)[0].strip().lower() == "application/json":
            data = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeError, RecursionError):
        pass
    if status != 200:
        detail = data.get("error") if isinstance(data, dict) else None
        code = detail.get("code") if isinstance(detail, dict) else None
        if not isinstance(code, str) or code not in _CODES:
            code = "http_error"
        raise APIError(status, code, request_id, _retry_after(headers.get("retry-after")))
    if not isinstance(data, dict):
        raise ProtocolError("Expected a UTF-8 JSON object.")
    if health:
        if data.get("status") != "ok":
            raise ProtocolError("Invalid health response.")
        return HealthResult(request_id=request_id, detector_version=version)
    if bulk_count:
        items = data.get("results")
        checked, failed = data.get("checked"), data.get("failed")
        if (not isinstance(items, list) or len(items) != bulk_count or
            type(checked) is not int or type(failed) is not int or
            checked < 0 or failed < 0 or checked + failed != bulk_count):
            raise ProtocolError("Invalid bulk response.")
        results = []
        successes = 0
        for index, item in enumerate(items):
            if not isinstance(item, dict) or type(item.get("index")) is not int or item["index"] != index:
                raise ProtocolError("Invalid bulk result index.")
            if "error" in item:
                detail = item["error"]
                if (not isinstance(detail, dict) or detail.get("code") != "invalid_email" or
                    any(key in item for key in ("provider", "valid", "disposable", "reason"))):
                    raise ProtocolError("Invalid bulk item error.")
                results.append(BulkItem(index, error=BulkItemError()))
            else:
                results.append(BulkItem(index, result=_check_data(item)))
                successes += 1
        if successes != checked:
            raise ProtocolError("Invalid bulk result counts.")
        return BulkResult(tuple(results), checked, failed, request_id, version)
    return _check_data(data, request_id, version)


def _check_data(data: dict[str, Any], request_id: str | None = None,
                version: str | None = None) -> CheckResult:
    provider, reason = data.get("provider"), data.get("reason")
    if (not isinstance(provider, str) or provider not in _PROVIDERS or
        not isinstance(reason, str) or reason not in _REASONS or data.get("valid") is not True or
        type(data.get("disposable")) is not bool or
        data["disposable"] != (reason in ("blocked_email", "blocked_domain"))):
        raise ProtocolError("Invalid check response.")
    return CheckResult(provider, True, data["disposable"], reason, request_id, version)


def _check_headers(response: httpx.Response, limit: int = MAX_RESPONSE_BYTES) -> None:
    length = response.headers.get("content-length", "")
    if re.fullmatch(r"[0-9]+", length) and (len(length) > 10 or int(length) > limit):
        raise ProtocolError("Response exceeds its byte limit.")
    if response.headers.get("content-encoding", "identity").lower() != "identity":
        raise ProtocolError("Unexpected response content encoding.")


class _NoCookies(DefaultCookiePolicy):
    def set_ok(self, cookie: Any, request: Any) -> bool:
        return False

    def return_ok(self, cookie: Any, request: Any) -> bool:
        return False


class _Base:
    def __init__(self, api_key: str, *, base_url: str = DEFAULT_BASE_URL, timeout: float = 5.0,
                 connect_timeout: float = 2.0, pool_timeout: float = 1.0,
                 max_connections: int = 32, max_keepalive_connections: int = 8,
                 keepalive_expiry: float = 20.0, max_in_flight: int = 64,
                 http2: bool = True, ssl_context: ssl.SSLContext | None = None) -> None:
        self._origin = _origin(base_url)
        if not isinstance(api_key, str) or not re.fullmatch(r"[\x21-\x7e]{1,4096}", api_key):
            raise ConfigurationError("api_key must contain 1 to 4096 printable ASCII characters without spaces.")
        self._authorization = "Bearer " + api_key
        self._timeout = _positive(timeout, "timeout")
        self._connect_timeout = _positive(connect_timeout, "connect_timeout")
        self._pool_timeout = _positive(pool_timeout, "pool_timeout")
        maximum = _count(max_connections, "max_connections")
        idle = _count(max_keepalive_connections, "max_keepalive_connections")
        if idle > maximum:
            raise ConfigurationError("max_keepalive_connections cannot exceed max_connections.")
        if type(http2) is not bool:
            raise ConfigurationError("http2 must be a boolean.")
        limits = httpx.Limits(max_connections=maximum, max_keepalive_connections=idle,
                              keepalive_expiry=_positive(keepalive_expiry, "keepalive_expiry"))
        self._slots = threading.BoundedSemaphore(_count(max_in_flight, "max_in_flight"))
        self._state_lock = threading.Lock()
        self._closed = False
        context = ssl_context
        if context is None:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            context.load_default_certs()
        if (not isinstance(context, ssl.SSLContext) or not context.check_hostname or
            context.verify_mode != ssl.CERT_REQUIRED or
            (context.minimum_version != ssl.TLSVersion.MAXIMUM_SUPPORTED and
             context.minimum_version < ssl.TLSVersion.TLSv1_2)):
            raise ConfigurationError("ssl_context must verify certificates and hostnames and require TLS 1.2 or newer.")
        self._transport_options = dict(verify=context, limits=limits, http2=http2, retries=0, trust_env=False)

    def __repr__(self) -> str:
        return f"{type(self).__name__}(credentials=REDACTED)"

    def _enter(self) -> None:
        with self._state_lock:
            if self._closed:
                raise ClosedError("Client is closed.")
            if not self._slots.acquire(blocking=False):
                raise BusyError("Client in-flight limit reached.")

    def _mark_closed(self) -> bool:
        with self._state_lock:
            if self._closed:
                return False
            self._closed = True
            return True

    def _headers(self, health: bool) -> dict[str, str]:
        headers = {"accept": "application/json", "accept-encoding": "identity", "cache-control": "no-store"}
        if not health:
            headers.update({"authorization": self._authorization, "content-type": "application/json"})
        return headers

    def _phase_timeout(self, timeout: float) -> httpx.Timeout:
        return httpx.Timeout(timeout, connect=min(self._connect_timeout, timeout), pool=min(self._pool_timeout, timeout))


class Client(_Base):
    """Thread-shareable client. Close only after all application calls finish."""
    def __init__(self, api_key: str, **options: Any) -> None:
        super().__init__(api_key, **options)
        self._http = httpx.Client(transport=httpx.HTTPTransport(**self._transport_options),
            trust_env=False, follow_redirects=False, cookies=CookieJar(policy=_NoCookies()))
        del self._transport_options

    def check(self, email: str, *, timeout: float | None = None) -> CheckResult:
        result = self._request(False, _body(email), timeout)
        assert isinstance(result, CheckResult)
        return result

    def warmup(self, *, timeout: float | None = None) -> HealthResult:
        result = self._request(True, None, timeout)
        assert isinstance(result, HealthResult)
        return result

    def check_bulk(self, emails: list[str] | tuple[str, ...], *, timeout: float | None = None) -> BulkResult:
        result = self._request(False, _bulk_body(emails), timeout, len(emails))
        assert isinstance(result, BulkResult)
        return result

    def _request(self, health: bool, body: bytes | None, timeout: float | None,
                 bulk_count: int = 0) -> CheckResult | HealthResult | BulkResult:
        budget = self._timeout if timeout is None else _positive(timeout, "timeout")
        limit = MAX_BULK_BYTES if bulk_count else MAX_RESPONSE_BYTES
        self._enter()
        failure = None
        try:
            deadline = time.monotonic() + budget
            try:
                with self._http.stream("GET" if health else "POST", self._origin + ("/healthz" if health else "/v1/check/bulk" if bulk_count else "/v1/check"),
                    content=body, headers=self._headers(health), timeout=self._phase_timeout(budget)) as response:
                    _check_headers(response, limit)
                    raw = bytearray()
                    # Do not request fixed-size chunks: each network read must reach the budget check.
                    for chunk in response.iter_raw():
                        if time.monotonic() >= deadline:
                            raise TimeoutError("Request budget exceeded.")
                        if len(raw) + len(chunk) > limit:
                            raise ProtocolError("Response exceeds its byte limit.")
                        raw.extend(chunk)
                    if time.monotonic() >= deadline:
                        raise TimeoutError("Request budget exceeded.")
                    return _parse(response.status_code, response.headers, bytes(raw), health, bulk_count)
            except httpx.TimeoutException:
                failure = TimeoutError("Request phase timed out; delivery may be unknown.")
            except httpx.HTTPError:
                failure = TransportError("Secure request failed. Delivery may be unknown; no SDK retry was made.")
        finally:
            self._slots.release()
        # Raise outside the handler so raw transport exceptions are not retained as context.
        raise failure from None

    def close(self) -> None:
        if self._mark_closed():
            self._http.close()

    def __enter__(self) -> Client:
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()


class AsyncClient(_Base):
    """Share within one asyncio event loop. Do not reuse across asyncio.run calls."""
    def __init__(self, api_key: str, **options: Any) -> None:
        super().__init__(api_key, **options)
        self._http = httpx.AsyncClient(transport=httpx.AsyncHTTPTransport(**self._transport_options),
            trust_env=False, follow_redirects=False, cookies=CookieJar(policy=_NoCookies()))
        del self._transport_options

    async def check(self, email: str, *, timeout: float | None = None) -> CheckResult:
        result = await self._request(False, _body(email), timeout)
        assert isinstance(result, CheckResult)
        return result

    async def warmup(self, *, timeout: float | None = None) -> HealthResult:
        result = await self._request(True, None, timeout)
        assert isinstance(result, HealthResult)
        return result

    async def check_bulk(self, emails: list[str] | tuple[str, ...], *, timeout: float | None = None) -> BulkResult:
        result = await self._request(False, _bulk_body(emails), timeout, len(emails))
        assert isinstance(result, BulkResult)
        return result

    async def _request(self, health: bool, body: bytes | None, timeout: float | None,
                       bulk_count: int = 0) -> CheckResult | HealthResult | BulkResult:
        budget = self._timeout if timeout is None else _positive(timeout, "timeout")
        limit = MAX_BULK_BYTES if bulk_count else MAX_RESPONSE_BYTES
        self._enter()
        failure = None
        try:
            try:
                async with asyncio.timeout(budget):
                    async with self._http.stream("GET" if health else "POST", self._origin + ("/healthz" if health else "/v1/check/bulk" if bulk_count else "/v1/check"),
                        content=body, headers=self._headers(health), timeout=self._phase_timeout(budget)) as response:
                        _check_headers(response, limit)
                        raw = bytearray()
                        async for chunk in response.aiter_raw():
                            if len(raw) + len(chunk) > limit:
                                raise ProtocolError("Response exceeds its byte limit.")
                            raw.extend(chunk)
                        return _parse(response.status_code, response.headers, bytes(raw), health, bulk_count)
            except (httpx.TimeoutException, asyncio.TimeoutError):
                failure = TimeoutError("Request deadline exceeded; delivery may be unknown.")
            except httpx.HTTPError:
                failure = TransportError("Secure request failed. Delivery may be unknown; no SDK retry was made.")
        finally:
            self._slots.release()
        raise failure from None

    async def aclose(self) -> None:
        if self._mark_closed():
            await self._http.aclose()

    async def __aenter__(self) -> AsyncClient:
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.aclose()
