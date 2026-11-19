"""Start a Box HTTP agent after invocation-time storage becomes available."""

import fnmatch
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import threading
import time


WARMUP_HEADER = "X-Amzn-Bedrock-AgentCore-Runtime-Warmup-Type"
WARMUP_TYPES = frozenset(("memory", "disk"))
_HOP_HEADERS = frozenset((
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", "proxy-connection",
))
_CHUNK_SIZE = 64 * 1024


class BootstrapError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class RequestError(Exception):
    def __init__(self, status=400, code="invalid_request_framing"):
        self.status = status
        self.code = code
        super().__init__(code)


def _mount_spec(value):
    value = {"path": value} if isinstance(value, str) else value
    if not isinstance(value, dict):
        raise ValueError("A required mount must name an absolute path")
    path = value.get("path")
    types = value.get("filesystem_types", ())
    if (not isinstance(path, str) or not os.path.isabs(path) or "\0" in path
            or os.path.normpath(path) == "/" or any(part in (".", "..") for part in path.split("/"))):
        raise ValueError("A required mount must name an absolute path below the root")
    if not isinstance(types, (list, tuple)) or not all(isinstance(t, str) and t for t in types):
        raise ValueError("Mount filesystem_types must be a list of filesystem names")
    return {"path": os.path.normpath(path), "filesystem_types": tuple(types)}


def required_mounts_ready(required_mounts, mountinfo_path="/proc/self/mountinfo"):
    """Match the resolved device, exact mountpoint, and configured filesystem types."""
    if not required_mounts:
        return True
    try:
        rows = []
        for line in Path(mountinfo_path).read_text().splitlines():
            left, right = line.split(" - ", 1)
            fields, filesystem = left.split(), right.split()[0]
            point = re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), fields[4])
            rows.append((point, fields[2], filesystem))
        for raw in required_mounts:
            spec = _mount_spec(raw)
            info = os.stat(spec["path"])
            device = f"{os.major(info.st_dev)}:{os.minor(info.st_dev)}"
            if not any(
                point == spec["path"] and mounted_device == device
                and (not spec["filesystem_types"] or any(
                    fnmatch.fnmatchcase(filesystem, kind) for kind in spec["filesystem_types"]
                ))
                for point, mounted_device, filesystem in rows
            ):
                return False
        return True
    except (OSError, ValueError, IndexError):
        return False


class _Child:
    def __init__(self, command, required_mounts, address, startup_timeout, shutdown_timeout, mount_ready):
        if not isinstance(command, (list, tuple)) or not command or not all(isinstance(part, str) and part for part in command):
            raise ValueError("Box command must be a nonempty argument list")
        self.command = list(command)
        self.mounts = tuple(_mount_spec(value) for value in required_mounts)
        self.address = address
        self.startup_timeout = startup_timeout
        self.shutdown_timeout = shutdown_timeout
        self.mount_ready = mount_ready or required_mounts_ready
        self.condition = threading.Condition()
        self.cleanup_lock = threading.Lock()
        self.stopping = threading.Event()
        self.state = "new"
        self.starting_at = None
        self.error = None
        self.process = None
        self.process_cleaned = False

    def ensure_ready(self):
        with self.condition:
            while self.state == "starting" and not self.stopping.is_set():
                self.condition.wait(0.1)
            if self.stopping.is_set():
                raise BootstrapError("runtime_stopping")
            if self.state == "ready" and self.process.poll() is None:
                return
            if self.state == "failed" or self.state == "ready":
                raise BootstrapError(self.error or "box_exited")
            self.state = "starting"
            self.starting_at = time.time()
        try:
            self._start()
        except BootstrapError as error:
            self._failed(error.code)
            self._stop_process()
            raise
        except Exception:
            self._failed("box_start_failed")
            self._stop_process()
            raise BootstrapError("box_start_failed") from None
        with self.condition:
            if self.stopping.is_set():
                raise BootstrapError("runtime_stopping")
            self.state = "ready"
            self.condition.notify_all()
        threading.Thread(target=self._watch, daemon=True).start()

    def _start(self):
        deadline = time.monotonic() + self.startup_timeout
        while not self.mount_ready(self.mounts):
            if self.stopping.wait(0.05):
                raise BootstrapError("runtime_stopping")
            if time.monotonic() >= deadline:
                raise BootstrapError("storage_not_ready")
        if time.monotonic() >= deadline:
            raise BootstrapError("storage_not_ready")
        # A listener left by another process must not satisfy the new child's health check.
        try:
            with socket.create_connection(self.address, timeout=0.2):
                raise BootstrapError("box_port_in_use")
        except OSError:
            pass
        with self.condition:
            if self.stopping.is_set():
                raise BootstrapError("runtime_stopping")
            self.process = subprocess.Popen(self.command, stdin=subprocess.DEVNULL, start_new_session=True)
        while time.monotonic() < deadline:
            if self.stopping.is_set():
                raise BootstrapError("runtime_stopping")
            if self.process.poll() is not None:
                raise BootstrapError("box_exited_during_start")
            connection = http.client.HTTPConnection(*self.address, timeout=min(0.5, max(0.01, deadline - time.monotonic())))
            try:
                connection.request("GET", "/ping", headers={"Connection": "close"})
                response = connection.getresponse()
                value = json.loads(response.read(8193))
                if response.status == 200 and value.get("status") in ("Healthy", "HealthyBusy"):
                    return
            except (OSError, http.client.HTTPException, ValueError, AttributeError):
                pass
            finally:
                connection.close()
            self.stopping.wait(0.05)
        raise BootstrapError("box_health_timeout")

    def _failed(self, code):
        with self.condition:
            self.error = code
            self.state = "failed"
            self.condition.notify_all()

    def _watch(self):
        self.process.wait()
        if not self.stopping.is_set():
            self._failed("box_exited")
            self._stop_process()

    def _stop_process(self):
        with self.cleanup_lock:
            process = self.process
            if process is None or self.process_cleaned:
                return
            self.process_cleaned = True
            # The new session owns the group, including descendants of a child that already exited.
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                process.wait()
                return
            deadline = time.monotonic() + self.shutdown_timeout
            while time.monotonic() < deadline:
                process.poll()
                try:
                    os.killpg(process.pid, 0)
                except ProcessLookupError:
                    return
                time.sleep(0.02)
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=self.shutdown_timeout)
            except subprocess.TimeoutExpired:
                pass

    def stop(self):
        self.stopping.set()
        with self.condition:
            self.condition.notify_all()
        self._stop_process()


def _hop_headers(headers):
    names = set(_HOP_HEADERS)
    for value in headers.get_all("Connection", []):
        names.update(token.strip().lower() for token in value.split(",") if token.strip())
    return names


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.connection.settimeout(self.server.request_timeout)
        self.server.track(self.connection)

    def finish(self):
        try:
            super().finish()
        finally:
            self.server.untrack(self.connection)

    def log_message(self, format_string, *args):
        # Request paths and headers can contain customer identifiers or credentials.
        pass

    def _json(self, status, value):
        data = json.dumps(value, separators=(",", ":")).encode()
        self.send_response_only(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.wfile.flush()
        self.close_connection = True

    def _framing(self):
        lengths = self.headers.get_all("Content-Length", [])
        transfers = self.headers.get_all("Transfer-Encoding", [])
        if self.headers.get("Upgrade"):
            raise RequestError(400, "upgrade_not_supported")
        if len(lengths) > 1 or len(transfers) > 1 or (lengths and transfers):
            raise RequestError()
        if transfers:
            if transfers[0].strip().lower() != "chunked":
                raise RequestError()
            return "chunked", None
        if not lengths:
            return "length", 0
        value = lengths[0].strip()
        if len(value) > 20 or not re.fullmatch(r"[0-9]+", value):
            raise RequestError()
        return "length", int(value)

    def _body(self, framing):
        kind, remaining = framing
        if kind == "length":
            while remaining:
                data = self.rfile.read(min(_CHUNK_SIZE, remaining))
                if not data:
                    raise RequestError()
                remaining -= len(data)
                yield data
            return
        while True:
            line = self.rfile.readline(8193)
            token = line.split(b";", 1)[0].strip()
            if len(line) > 8192 or not line.endswith(b"\r\n") or not re.fullmatch(b"[0-9a-fA-F]+", token):
                raise RequestError()
            remaining = int(token, 16)
            if not remaining:
                total = 0
                while True:
                    trailer = self.rfile.readline(8193)
                    total += len(trailer)
                    if total > 65536 or not trailer.endswith(b"\r\n"):
                        raise RequestError()
                    if trailer == b"\r\n":
                        return
            while remaining:
                data = self.rfile.read(min(_CHUNK_SIZE, remaining))
                if not data:
                    raise RequestError()
                remaining -= len(data)
                yield data
            if self.rfile.read(2) != b"\r\n":
                raise RequestError()

    def do_GET(self):
        if self.path.split("?", 1)[0] != "/ping":
            self._json(404, {"error": "not_found"})
            return
        child = self.server.child
        with child.condition:
            state = child.state
            starting_at = child.starting_at
        if child.stopping.is_set() or state == "failed":
            self._json(503, {"status": "Unhealthy", "error": child.error or "runtime_stopping"})
        elif state == "ready":
            self._proxy(("length", 0))
        elif state == "starting":
            self._json(200, {"status": "HealthyBusy", "time_of_last_update": starting_at})
        else:
            self._json(200, {"status": "Healthy"})

    def do_POST(self):
        try:
            framing = self._framing()
            if self.path.split("?", 1)[0] != "/invocations" and self.headers.get(WARMUP_HEADER) in WARMUP_TYPES:
                self._json(200, {"warmup_skipped": True})
                return
            if self.path.split("?", 1)[0] != "/invocations":
                self._json(404, {"error": "not_found"})
                return
            self.server.child.ensure_ready()
            self._proxy(framing)
        except RequestError as error:
            self._json(error.status, {"error": error.code})
        except BootstrapError as error:
            self._json(503, {"error": error.code})

    def _proxy(self, framing):
        connection = http.client.HTTPConnection(*self.server.child.address, timeout=self.server.request_timeout)
        sent_headers = False
        upstream_socket = None
        response = None
        try:
            connection.connect()
            upstream_socket = connection.sock
            self.server.track(upstream_socket)
            connection.putrequest(self.command, self.path, skip_host=True, skip_accept_encoding=True)
            excluded = _hop_headers(self.headers) | {"content-length", "expect"}
            saw_host = False
            for name, value in self.headers.raw_items():
                if name.lower() not in excluded:
                    connection.putheader(name, value)
                    saw_host = saw_host or name.lower() == "host"
            if not saw_host:
                connection.putheader("Host", "%s:%s" % self.server.child.address)
            if framing[0] == "chunked":
                connection.putheader("Transfer-Encoding", "chunked")
            else:
                connection.putheader("Content-Length", str(framing[1]))
            connection.putheader("Connection", "close")
            connection.endheaders()
            for data in self._body(framing):
                if framing[0] == "chunked":
                    connection.send(("%x\r\n" % len(data)).encode() + data + b"\r\n")
                else:
                    connection.send(data)
            if framing[0] == "chunked":
                connection.send(b"0\r\n\r\n")
            # Request upload and health checks remain bounded independently of a long invocation.
            if self.command == "POST":
                upstream_socket.settimeout(self.server.response_timeout)
            response = connection.getresponse()
            if response.status == 101:
                raise BootstrapError("upgrade_not_supported")
            self.send_response_only(response.status, response.reason)
            excluded = _hop_headers(response.headers) | {"content-length"}
            for name, value in response.getheaders():
                if name.lower() not in excluded:
                    self.send_header(name, value)
            has_body = self.command != "HEAD" and response.status not in (204, 304) and response.status >= 200
            if has_body:
                self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Connection", "close")
            self.end_headers()
            sent_headers = True
            if has_body:
                while True:
                    data = response.read1(_CHUNK_SIZE)
                    if not data:
                        if response.length not in (None, 0):
                            raise http.client.IncompleteRead(b"")
                        break
                    self.wfile.write(("%x\r\n" % len(data)).encode() + data + b"\r\n")
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
        except RequestError as error:
            if not sent_headers:
                self._json(error.status, {"error": error.code})
        except (OSError, http.client.HTTPException, BootstrapError):
            if not sent_headers:
                self._json(502, {"error": "box_response_failed"})
        finally:
            if upstream_socket is not None:
                self.server.untrack(upstream_socket)
            if response is not None:
                response.close()
            connection.close()
            self.close_connection = True


class RuntimeServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, command, required_mounts=(), *, child_host="127.0.0.1", child_port=8082,
                 startup_timeout=60.0, request_timeout=300.0, response_timeout=28800.0, shutdown_timeout=2.0, mount_ready=None):
        if startup_timeout <= 0 or request_timeout <= 0 or response_timeout <= 0 or shutdown_timeout <= 0:
            raise ValueError("Runtime timeouts must be positive")
        self.child = _Child(command, required_mounts, (child_host, child_port), startup_timeout, shutdown_timeout, mount_ready)
        self.request_timeout = request_timeout
        self.response_timeout = response_timeout
        self.connections = set()
        self.connections_lock = threading.Lock()
        super().__init__(address, _Handler)

    def track(self, connection):
        with self.connections_lock:
            if self.child.stopping.is_set():
                connection.close()
                raise BootstrapError("runtime_stopping")
            self.connections.add(connection)

    def untrack(self, connection):
        with self.connections_lock:
            self.connections.discard(connection)

    def close(self):
        self.child.stopping.set()
        with self.child.condition:
            self.child.condition.notify_all()
        with self.connections_lock:
            connections = list(self.connections)
        for connection in connections:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            connection.close()
        self.child.stop()
        self.server_close()

    def handle_error(self, request, client_address):
        # Keep request data and subprocess arguments out of bootstrap errors.
        pass


def serve(command, required_mounts=(), *, host="0.0.0.0", port=8080, child_host="127.0.0.1", child_port=8082,
          startup_timeout=60.0, request_timeout=300.0, response_timeout=28800.0, shutdown_timeout=2.0):
    """Serve health and invocations, forwarding through one invocation-started Box child."""
    server = RuntimeServer((host, port), command, required_mounts, child_host=child_host, child_port=child_port,
                           startup_timeout=startup_timeout, request_timeout=request_timeout,
                           response_timeout=response_timeout, shutdown_timeout=shutdown_timeout)
    previous = {}

    def stop(signum, frame):
        server.child.stopping.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    if threading.current_thread() is threading.main_thread():
        for number in (signal.SIGTERM, signal.SIGINT):
            previous[number] = signal.signal(number, stop)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.close()
        for number, handler in previous.items():
            signal.signal(number, handler)
