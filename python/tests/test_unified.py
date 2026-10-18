import pytest
from irondome import Client, AsyncClient, ConfigurationError, DEFAULT_BASE_URL


def test_unified_default_accepts_opaque_keys_without_network():
    assert DEFAULT_BASE_URL == "https://api.irondome.dev"
    for key in ("dome_free_v1.synthetic", "dome_live_v1.synthetic"):
        with Client(key) as client:
            assert client._origin == DEFAULT_BASE_URL
            assert client._authorization == "Bearer " + key


async def test_async_unified_default():
    async with AsyncClient("dome_free_v1.synthetic") as client:
        assert client._origin == DEFAULT_BASE_URL


@pytest.mark.parametrize("origin", ["https://free.irondome.dev", "https://FREE.IRONDOME.DEV./", "https://irondome-free.edgecompute.app"])
@pytest.mark.parametrize("client_type", [Client, AsyncClient])
def test_legacy_free_endpoints_rejected(origin, client_type):
    with pytest.raises(ConfigurationError):
        client_type("test-key", base_url=origin)
