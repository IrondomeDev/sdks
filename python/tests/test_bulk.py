import asyncio
import json

import httpx
import pytest

from irondome import Client, AsyncClient, APIError, ProtocolError, ValidationError, TimeoutError, TransportError
from irondome.client import _bulk_body, _parse


def test_bulk_sync_pool_order_and_limits(options):
    with Client("test-key", **options) as client:
        health = client.warmup()
        result = client.check_bulk(["person@example.com", "broken", "person@example.com", ""])
        assert result.checked == result.failed == 2
        assert [item.index for item in result.results] == [0, 1, 2, 3]
        assert result.results[0].result.valid
        assert result.results[1].error.code == "invalid_email"
        assert "private" not in repr(result)
        assert health.request_id.split("-")[0] == result.request_id.split("-")[0]
        assert client.check_bulk(["person@example.com"] * 100).checked == 100
        assert client.check_bulk(["broken", ""]).checked == 0
        assert client.check_bulk(["padded@example.com"]).checked == 1


async def test_bulk_async_concurrency_and_cancel(options):
    async with AsyncClient("test-key", **options) as client:
        results = await asyncio.gather(*(client.check_bulk(["person@example.com", "broken"]) for _ in range(8)))
        assert all(result.checked == result.failed == 1 for result in results)
        task = asyncio.create_task(client.check_bulk(["slow@example.com"]))
        await asyncio.sleep(0.03)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert (await client.check_bulk(["person@example.com"])).checked == 1


@pytest.mark.parametrize("emails", [None, "a", [], ["a"] * 101, [2], ["\ud800"], ["x" * 65523], ["é" * 32762]])
def test_bulk_input_validation(emails):
    with pytest.raises(ValidationError):
        _bulk_body(emails)
    assert len(_bulk_body(["x" * 65521])) == 65536


@pytest.mark.parametrize("mode", ["quota", "redirect", "unavailable", "truncated"])
def test_bulk_no_replay(options, tls_server, mode):
    with Client("test-key", **options) as client:
        before = tls_server[0].checks_seen
        with pytest.raises((APIError, TransportError)) as caught:
            client.check_bulk([mode + "@example.com"])
        assert tls_server[0].checks_seen == before + 1
        if mode == "quota":
            assert isinstance(caught.value, APIError)
            assert caught.value.status_code == 429 and caught.value.code == "monthly_quota_exceeded"
            assert "private" not in str(caught.value)


@pytest.mark.parametrize("mode", ["bulk-invalid-index", "bulk-invalid-count", "bulk-invalid-error", "oversized", "chunked-oversized"])
def test_bulk_protocol_rejections(options, mode):
    with Client("test-key", **options) as client, pytest.raises(ProtocolError):
        client.check_bulk([mode + "@example.com"])


async def test_bulk_async_errors_and_deadline(options):
    async with AsyncClient("test-key", **options) as client:
        with pytest.raises(APIError) as caught:
            await client.check_bulk(["quota@example.com"])
        assert caught.value.code == "monthly_quota_exceeded"
        with pytest.raises(TimeoutError):
            await client.check_bulk(["slow@example.com"], timeout=0.03)
        with pytest.raises(ProtocolError):
            await client.check_bulk(["oversized@example.com"])


@pytest.mark.parametrize("value", [
    {"results": [], "checked": 1, "failed": 0},
    {"results": [{"index": True}], "checked": 0, "failed": 1},
    {"results": [{"index": 0, "error": {"code": "invalid_email"}}], "checked": True, "failed": 0},
    {"results": [{"index": 0, "error": {"code": "private"}}], "checked": 0, "failed": 1},
    {"results": [{"index": 0, "valid": True, "error": {"code": "invalid_email"}}], "checked": 0, "failed": 1},
])
def test_bulk_parser_rejects_ambiguity(value):
    with pytest.raises(ProtocolError):
        _parse(200, httpx.Headers({"content-type": "application/json"}), json.dumps(value).encode(), False, 1)
