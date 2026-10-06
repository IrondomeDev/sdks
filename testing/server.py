"""Loopback-only TLS contract fixture. Never contacts the deployed service."""
from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, handler):
        super().__init__(address, handler)
        self.lock = threading.Lock()
        self.connections = 0
        self.requests_seen = 0
        self.checks_seen = 0
        self.health_authorized = False
        self.cookies_seen = False

    def get_request(self):
        sock, address = super().get_request()
        with self.lock:
            self.connections += 1
        return sock, address


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def handle(self):
        try:
            super().handle()
        except OSError:
            # Fault-injection clients intentionally cancel or truncate TLS streams.
            pass

    def log_message(self, *_):
        pass

    def setup(self):
        super().setup()
        with self.server.lock:
            self.connection_id = self.server.connections

    def do_GET(self):
        if self.path == "/_stats":
            with self.server.lock:
                data = {key: getattr(self.server, key) for key in (
                    "connections", "requests_seen", "checks_seen", "health_authorized", "cookies_seen")}
            self.reply(200, data)
        elif self.path == "/healthz":
            self.record(False)
            self.reply(200, {"status": "ok"})
        else:
            self.reply(404, {"error": {"code": "not_found"}})

    def record(self, check):
        with self.server.lock:
            self.server.requests_seen += 1
            self.server.checks_seen += int(check)
            if not check and self.headers.get("authorization"):
                self.server.health_authorized = True
            self.server.cookies_seen |= bool(self.headers.get("cookie"))
            self.request_number = self.server.requests_seen

    def do_POST(self):
        self.record(True)
        if self.path != "/v1/check":
            self.reply(404, {"error": {"code": "not_found"}})
            return
        length = self.headers.get("content-length")
        if not length or not length.isdecimal() or self.headers.get("transfer-encoding"):
            self.reply(411, {"error": {"code": "content_length_required"}})
            return
        if int(length) > 1024:
            self.reply(413, {"error": {"code": "body_too_large"}})
            self.close_connection = True
            return
        raw = self.rfile.read(int(length))
        try:
            data = json.loads(raw)
            assert isinstance(data, dict) and list(data) == ["email"] and isinstance(data["email"], str)
        except (ValueError, AssertionError):
            self.reply(400, {"error": {"code": "invalid_json"}})
            return
        if self.headers.get("authorization") != "Bearer test-key":
            self.reply(401, {"error": {"code": "invalid_api_key", "message": "Do not expose this body."}})
            return
        mode = data["email"].split("@", 1)[0]
        if mode == "redirect":
            self.reply(307, {}, {"location": "/redirect-target"})
        elif mode == "unavailable":
            self.reply(503, {"error": {"code": "service_unavailable", "message": "private"}}, {"retry-after": "5"})
        elif mode == "html":
            self.reply(502, b"<html>private</html>", {"content-type": "text/html"})
        elif mode == "malformed":
            self.reply(200, b"not JSON")
        elif mode == "invalid-schema":
            self.reply(200, {"provider": "custom", "valid": True, "disposable": False, "reason": "blocked_email"})
        elif mode == "oversized":
            self.reply(200, b"x" * 16385)
        elif mode == "chunked-oversized":
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("transfer-encoding", "chunked")
            self.end_headers()
            with contextlib.suppress(OSError):
                self.wfile.write(b"4001\r\n" + b"x" * 16385 + b"\r\n0\r\n\r\n")
                self.wfile.flush()
        elif mode == "truncated":
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", "100")
            self.end_headers()
            self.wfile.write(b"{")
            self.wfile.flush()
            self.close_connection = True
        elif mode == "slow":
            time.sleep(0.2)
            self.reply(200, self.result())
        elif mode == "slow-body":
            body = json.dumps(self.result()).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            with contextlib.suppress(OSError):
                self.wfile.write(body[:1])
                self.wfile.flush()
                time.sleep(0.2)
                self.wfile.write(body[1:])
        elif mode == "cookie":
            self.reply(200, self.result(), {"set-cookie": "session=do-not-persist; Secure; Path=/"})
        else:
            self.reply(200, self.result())

    @staticmethod
    def result():
        return {"provider": "custom", "valid": True, "disposable": False, "reason": "not_listed"}

    def reply(self, status, value, extra=None):
        body = value if isinstance(value, bytes) else json.dumps(value, separators=(",", ":")).encode()
        headers = {"content-type": "application/json", "content-length": str(len(body)),
                   "x-request-id": f"conn{self.connection_id}-req{getattr(self, 'request_number', 0)}",
                   "x-detector-base-version": "test-release", "cache-control": "no-store"}
        headers.update(extra or {})
        with contextlib.suppress(OSError):
            self.send_response(status)
            for name, value in headers.items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()


def openssl_executable() -> str:
    configured = os.environ.get("OPENSSL", "openssl")
    if resolved := shutil.which(configured):
        return resolved
    if os.name == "nt":
        program_files = Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
        for relative in ("Git/usr/bin/openssl.exe", "Git/mingw64/bin/openssl.exe"):
            candidate = program_files / relative
            if candidate.is_file():
                return str(candidate)
    raise RuntimeError("OpenSSL is required to run the local TLS fixture")


def run(*args: str) -> None:
    command = list(args)
    if command[0] == "openssl":
        command[0] = openssl_executable()
    if os.name == "nt":
        # Some Windows terminals cannot duplicate PIPE or null-device handles.
        subprocess.run(command, check=True)
    else:
        subprocess.run(
            command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )


@contextlib.contextmanager
def serve():
    with tempfile.TemporaryDirectory(prefix="irondome-test-") as directory:
        directory_path = Path(directory)
        ca_cert = directory_path / "ca.pem"
        ca_key = directory_path / "ca-key.pem"
        cert = directory_path / "server.pem"
        key = directory_path / "server-key.pem"
        request = directory_path / "server.csr"
        extensions = directory_path / "server.ext"

        # Generate a real test root and a distinct localhost leaf. Modern rustls/
        # webpki correctly rejects a self-signed end-entity certificate presented
        # as its own trust anchor (CaUsedAsEndEntity).
        run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256",
            "-keyout", str(ca_key), "-out", str(ca_cert), "-days", "1",
            "-subj", "/CN=IronDome SDK Test Root",
            "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
            "-addext", "keyUsage=critical,keyCertSign,cRLSign")
        run("openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256",
            "-keyout", str(key), "-out", str(request), "-subj", "/CN=localhost")
        extensions.write_text(
            "basicConstraints=critical,CA:FALSE\n"
            "keyUsage=critical,digitalSignature,keyEncipherment\n"
            "extendedKeyUsage=serverAuth\n"
            "subjectAltName=DNS:localhost\n"
            "subjectKeyIdentifier=hash\n"
            "authorityKeyIdentifier=keyid,issuer\n",
            encoding="ascii",
        )
        run("openssl", "x509", "-req", "-in", str(request), "-CA", str(ca_cert),
            "-CAkey", str(ca_key), "-CAcreateserial", "-out", str(cert),
            "-days", "1", "-sha256", "-extfile", str(extensions))
        os.chmod(ca_key, 0o600)
        os.chmod(key, 0o600)

        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(cert, key)
        context.set_alpn_protocols(["http/1.1"])
        server = Server(("127.0.0.1", 0), Handler)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield server, f"https://localhost:{server.server_port}", ca_cert
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    with serve() as (_, url, ca_cert):
        print(json.dumps({"url": url, "ca_file": str(ca_cert)}), flush=True)
        # The parent closes stdin to request graceful shutdown and remove the keys.
        import sys
        sys.stdin.read()
