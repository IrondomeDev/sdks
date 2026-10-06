from pathlib import Path
import ssl
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from testing.server import serve


@pytest.fixture(scope="session")
def tls_server():
    with serve() as fixture:
        yield fixture


@pytest.fixture
def options(tls_server):
    _, url, cert = tls_server
    context = ssl.create_default_context(cafile=str(cert))
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    return {"base_url": url, "ssl_context": context}
