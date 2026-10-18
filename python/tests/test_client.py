import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import ssl

import httpx
import pytest

from irondome import (Client, AsyncClient, APIError, ConfigurationError, ValidationError,
    ProtocolError, TimeoutError, TransportError, BusyError, ClosedError)
from irondome.client import _parse, _body, _retry_after


def test_sync_reuses_verified_tls_and_does_not_authenticate_health(options, tls_server):
    with Client("test-key", **options) as client:
        health = client.warmup()
        first = client.check("person@example.com")
        second = client.check("é@example.com")
        assert health.request_id.split("-")[0] == first.request_id.split("-")[0] == second.request_id.split("-")[0]
        assert first.valid and not first.disposable
        assert first.detector_version == "test-release"
        assert not tls_server[0].health_authorized
        assert "test-key" not in repr(client)
    with pytest.raises(ClosedError):
        client.warmup()


async def test_async_reuse_and_concurrency(options):
    async with AsyncClient("test-key", **options) as client:
        health = await client.warmup()
        first = await client.check("person@example.com")
        assert health.request_id.split("-")[0] == first.request_id.split("-")[0]
        results = await asyncio.gather(*(client.check("person@example.com") for _ in range(8)))
        assert all(result.reason == "not_listed" for result in results)
    with pytest.raises(ClosedError):
        await client.warmup()


@pytest.mark.parametrize("mode", ["redirect", "unavailable", "truncated"])
def test_no_replay_after_delivery(options, tls_server, mode):
    with Client("test-key", **options) as client:
        before = tls_server[0].checks_seen
        with pytest.raises((APIError, TransportError)):
            client.check(mode + "@example.com")
        assert tls_server[0].checks_seen == before + 1


async def test_async_no_retry_and_safe_errors(options, tls_server):
    async with AsyncClient("test-key", **options) as client:
        before = tls_server[0].checks_seen
        with pytest.raises(APIError) as result:
            await client.check("unavailable@example.com")
        assert tls_server[0].checks_seen == before + 1
        assert result.value.status_code == 503
        assert result.value.code == "service_unavailable"
        assert result.value.retry_after_seconds == 5
        assert "private" not in str(result.value)
        with pytest.raises(TransportError) as result:
            await client.check("truncated@example.com")
        assert result.value.__context__ is None


def test_cookies_and_proxy_environment_are_not_used(options, tls_server, monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:1")
    with Client("test-key", **options) as client:
        client.check("cookie@example.com")
        client.check("person@example.com")
        assert not tls_server[0].cookies_seen
        assert not list(client._http.cookies.jar)


@pytest.mark.parametrize("mode", ["malformed", "invalid-schema", "oversized", "chunked-oversized"])
def test_bounded_and_validated_responses(options, mode):
    with Client("test-key", **options) as client, pytest.raises(ProtocolError):
        client.check(mode + "@example.com")


@pytest.mark.parametrize("mode", ["slow", "slow-body"])
def test_sync_phase_timeouts(options, mode):
    with Client("test-key", **options) as client, pytest.raises(TimeoutError):
        client.check(mode + "@example.com", timeout=0.03)


@pytest.mark.parametrize("mode", ["slow", "slow-body"])
async def test_async_deadlines(options, mode):
    async with AsyncClient("test-key", **options) as client:
        with pytest.raises(TimeoutError):
            await client.check(mode + "@example.com", timeout=0.03)


async def test_async_cancellation_releases_capacity(options):
    async with AsyncClient("test-key", max_in_flight=1, **options) as client:
        task = asyncio.create_task(client.check("slow@example.com"))
        await asyncio.sleep(0.01)
        with pytest.raises(BusyError):
            await client.warmup()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert (await client.warmup()).status == "ok"


def test_sync_thread_sharing(options):
    with Client("test-key", **options) as client, ThreadPoolExecutor(max_workers=4) as pool:
        assert all(result.valid for result in pool.map(client.check, ["person@example.com"] * 12))


@pytest.mark.parametrize("bad", ["http://example.com", "https://u:p@example.com", "https://example.com/path",
    "https://example.com?", "https://example.com#", " https://example.com", "https://example.com\\evil", "https://example.com:99999"])
def test_origin_validation(bad):
    with pytest.raises(ConfigurationError):
        Client("test-key", base_url=bad)


@pytest.mark.parametrize("bad", ["", "has space", "x\r\ny", "é", "x" * 4097])
def test_credential_validation(bad):
    with pytest.raises(ConfigurationError):
        Client(bad, base_url="https://example.test")


@pytest.mark.parametrize("bad", [0, -1, float("inf"), float("nan"), True])
def test_timeout_validation(bad):
    with pytest.raises(ConfigurationError):
        Client("test-key", base_url="https://example.test", timeout=bad)


def test_ssl_checks_cannot_be_disabled(options):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    with pytest.raises(ConfigurationError):
        Client("test-key", base_url=options["base_url"], ssl_context=context)
    with Client("test-key", base_url=options["base_url"]) as client, pytest.raises(TransportError) as error:
        client.warmup()
    assert error.value.__context__ is None
    with Client("test-key", **{**options, "base_url": options["base_url"].replace("127.0.0.1", "localhost")}) as client:
        with pytest.raises(TransportError):
            client.warmup()


@pytest.mark.parametrize("bad", [None, 123, "x" * 1013, "é" * 507, "\ud800"])
def test_body_limit_and_unicode(bad):
    with pytest.raises(ValidationError):
        _body(bad)
    assert len(_body("x" * 1012)) == 1024


@pytest.mark.parametrize("change", [{"valid": 1}, {"valid": False}, {"disposable": "false"},
    {"provider": []}, {"reason": {}}, {"disposable": False, "reason": "blocked_email"}])
def test_schema_rejects_unsafe_coercions(change):
    value = {"provider": "custom", "valid": True, "disposable": False, "reason": "not_listed", **change}
    with pytest.raises(ProtocolError):
        _parse(200, httpx.Headers({"content-type": "application/json"}), json.dumps(value).encode(), False)


def test_retry_after_and_non_json_errors():
    assert _retry_after("5") == 5
    assert _retry_after("999999") == 86400
    assert _retry_after("broken") is None
    assert _retry_after("Wed, 21 Oct 2015 07:28:00 GMT") == 0
    with pytest.raises(APIError) as result:
        _parse(502, httpx.Headers(), b"private", False)
    assert result.value.code == "http_error"
    assert "private" not in str(result.value)
