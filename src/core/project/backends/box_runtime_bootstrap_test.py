"""Behavior tests for the generated Runtime bootstrap, using a real HTTP child."""

from concurrent.futures import ThreadPoolExecutor
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

sys.dont_write_bytecode = True

ASSET = Path(__file__).resolve().parents[3] / "assets/templates/box-codezip/box_runtime.py"
spec = importlib.util.spec_from_file_location("box_runtime", ASSET)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


def available_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_for(predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("Condition did not become true before timeout")


def live(pid):
    try:
        state = Path("/proc/%s/stat" % pid).read_text().rsplit(")", 1)[1].split()[0]
        return state != "Z"
    except FileNotFoundError:
        return False


def child_main(config):
    directory = Path(config["directory"])
    with (directory / "starts").open("a") as output:
        output.write(str(os.getpid()) + "\n")
    if config.get("grandchild"):
        grandchild = subprocess.Popen([sys.executable, "-c", "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)"])
        (directory / "grandchild").write_text(str(grandchild.pid))
    if config.get("exit"):
        sys.exit(7)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def body(self):
            if self.headers.get("Transfer-Encoding") == "chunked":
                chunks = []
                while True:
                    size = int(self.rfile.readline().split(b";", 1)[0], 16)
                    if not size:
                        self.rfile.readline()
                        return b"".join(chunks)
                    chunks.append(self.rfile.read(size))
                    assert self.rfile.read(2) == b"\r\n"
            return self.rfile.read(int(self.headers.get("Content-Length", "0")))

        def fixed(self, status, data, headers=()):
            self.send_response(status)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            for name, value in headers:
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(data)
            self.wfile.flush()
            self.close_connection = True

        def do_GET(self):
            busy = (directory / "busy").exists()
            unhealthy = config.get("unhealthy") or (directory / "unhealthy").exists()
            self.fixed(503 if unhealthy else 200, json.dumps({"status": "HealthyBusy" if busy else "Healthy"}).encode(), [("X-Child-Health", "observed")])

        def do_POST(self):
            body = self.body()
            (directory / "requests").open("a").write(body.decode(errors="replace") + "\n")
            time.sleep(config.get("response_delay", 0))
            if body == b"stream":
                self.send_response(206)
                self.send_header("Transfer-Encoding", "chunked")
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("X-Stream", "preserved")
                self.send_header("Connection", "close, X-Private")
                self.send_header("X-Private", "must-not-forward")
                self.end_headers()
                self.wfile.write(b"6\r\nfirst!\r\n")
                self.wfile.flush()
                wait_for(lambda: (directory / "release").exists(), 5)
                self.wfile.write(b"5\r\nlast!\r\n0\r\n\r\n")
                self.wfile.flush()
                self.close_connection = True
            elif body == b"truncate":
                self.send_response(200)
                self.send_header("Content-Length", "100")
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(b"short")
                self.wfile.flush()
                self.close_connection = True
            else:
                data = json.dumps({"body": body.decode(), "headers": dict(self.headers)}).encode()
                self.fixed(201, data, [("X-Child", "yes"), ("Set-Cookie", "a=1"), ("Set-Cookie", "b=2")])

    server = ThreadingHTTPServer(("127.0.0.1", config["port"]), Handler)
    server.daemon_threads = True
    server.serve_forever(poll_interval=0.02)


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="box-bootstrap-test-")
        self.directory = Path(self.temporary.name)
        self.servers = []
        self.processes = []

    def tearDown(self):
        for server, thread in self.servers:
            server.shutdown()
            server.close()
            thread.join(3)
        for process in self.processes:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=4)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        self.temporary.cleanup()

    def command(self, **child_options):
        port = available_port()
        config = {"directory": str(self.directory), "port": port, **child_options}
        return [sys.executable, str(Path(__file__).resolve()), "--child", json.dumps(config)], port

    def start(self, *, mount_ready=None, startup_timeout=3, request_timeout=3, response_timeout=3, **child_options):
        command, port = self.command(**child_options)
        server = runtime.RuntimeServer(("127.0.0.1", 0), command, child_port=port,
                                       startup_timeout=startup_timeout, shutdown_timeout=0.2,
                                       request_timeout=request_timeout, response_timeout=response_timeout,
                                       mount_ready=mount_ready)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        thread.start()
        self.servers.append((server, thread))
        return server

    def request(self, server, method="POST", body=b"hello", headers=None):
        connection = http.client.HTTPConnection(*server.server_address, timeout=4)
        connection.request(method, "/ping" if method == "GET" else "/invocations", body=body, headers=headers or {})
        response = connection.getresponse()
        data = response.read()
        result = response.status, response.getheaders(), data
        connection.close()
        return result

    def raw(self, server, request):
        with socket.create_connection(server.server_address, timeout=4) as sock:
            sock.sendall(request)
            response = http.client.HTTPResponse(sock)
            response.begin()
            return response.status, response.read()

    def test_health_and_exact_warmup_do_not_start_child(self):
        server = self.start()
        self.assertEqual(self.request(server, "GET")[0], 200)
        for value in ("memory", "disk"):
            status, body = self.raw(server, (
                "POST /warmup HTTP/1.1\r\nHost: test\r\nContent-Length: 0\r\n"
                + runtime.WARMUP_HEADER + ": " + value + "\r\n\r\n").encode())
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body), {"warmup_skipped": True})
        status, body = self.raw(server, b"POST /warmup HTTP/1.1\r\nHost: test\r\nContent-Length: 0\r\nX-Amzn-Bedrock-AgentCore-Runtime-Warmup-Type: arbitrary\r\n\r\n")
        self.assertEqual(status, 404)
        self.assertFalse((self.directory / "starts").exists())
        # Runtime warmup hooks cannot target /invocations. A caller header must not suppress a real invocation.
        self.assertEqual(self.request(server, headers={runtime.WARMUP_HEADER: "disk"})[0], 201)
        self.assertEqual(self.request(server, headers={runtime.WARMUP_HEADER: "unrecognized"})[0], 201)
        self.assertEqual(len((self.directory / "starts").read_text().splitlines()), 1)

    def test_mount_gate_and_concurrent_first_invocations_launch_once(self):
        mounted = threading.Event()
        server = self.start(mount_ready=lambda mounts: mounted.is_set())
        with ThreadPoolExecutor(max_workers=2) as pool:
            before = time.time()
            responses = [pool.submit(self.request, server, body=value) for value in (b"one", b"two")]
            wait_for(lambda: server.child.state == "starting")
            time.sleep(0.1)
            self.assertFalse((self.directory / "starts").exists())
            first_health = json.loads(self.request(server, "GET")[2])
            self.assertEqual(first_health["status"], "HealthyBusy")
            self.assertGreaterEqual(first_health["time_of_last_update"], before)
            self.assertLessEqual(first_health["time_of_last_update"], time.time())
            time.sleep(0.03)
            self.assertEqual(json.loads(self.request(server, "GET")[2])["time_of_last_update"],
                             first_health["time_of_last_update"])
            mounted.set()
            self.assertEqual([response.result()[0] for response in responses], [201, 201])
        self.assertEqual(len((self.directory / "starts").read_text().splitlines()), 1)
        self.assertEqual(sorted((self.directory / "requests").read_text().splitlines()), ["one", "two"])

    def test_missing_mount_failure_is_sticky_without_launch(self):
        server = self.start(mount_ready=lambda mounts: False, startup_timeout=0.15)
        for unused in range(2):
            status, _, body = self.request(server)
            self.assertEqual(status, 503)
            self.assertEqual(json.loads(body)["error"], "storage_not_ready")
        self.assertFalse((self.directory / "starts").exists())
        self.assertEqual(self.request(server, "GET")[0], 503)

    def test_exact_active_mount_and_filesystem_not_directory_or_placeholder(self):
        point = self.directory / "mount space"
        point.mkdir()
        device = os.stat(point).st_dev
        number = "%d:%d" % (os.major(device), os.minor(device))
        encoded = str(point).replace(" ", r"\040")
        info = self.directory / "mountinfo"
        mounts = [{"path": str(point), "filesystem_types": ["nfs", "nfs4"]}]
        info.write_text("")
        self.assertFalse(runtime.required_mounts_ready(mounts, info))
        info.write_text("10 1 %s / %s rw shared:1 - ext4 /dev/root rw\n" % (number, encoded))
        self.assertFalse(runtime.required_mounts_ready(mounts, info))
        info.write_text("11 10 0:999 / %s rw - nfs4 server:/ rw\n" % encoded)
        self.assertFalse(runtime.required_mounts_ready(mounts, info))
        info.write_text("10 1 0:999 / %s rw - ext4 /dev/root rw\n11 10 %s / %s rw - nfs4 server:/ rw\n" % (encoded, number, encoded))
        self.assertTrue(runtime.required_mounts_ready(mounts, info))
        self.assertFalse(runtime.required_mounts_ready([{"path": str(point / "child")}], info))

    def test_invalid_mount_paths_and_non_argv_commands_are_rejected(self):
        for path in ("relative", "/", "/mnt/.", "/mnt/..", "/mnt/../elsewhere"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                runtime.RuntimeServer(("127.0.0.1", 0), ["box"], [path])
        with self.assertRaises(ValueError):
            runtime.RuntimeServer(("127.0.0.1", 0), "box run profile")

    def test_status_headers_and_live_child_health_are_preserved(self):
        server = self.start()
        status, headers, body = self.request(server, headers={"X-Customer": "kept", "Connection": "close, X-Remove", "X-Remove": "gone"})
        self.assertEqual(status, 201)
        self.assertEqual([value for name, value in headers if name.lower() == "set-cookie"], ["a=1", "b=2"])
        forwarded = {key.lower(): value for key, value in json.loads(body)["headers"].items()}
        self.assertEqual(forwarded["x-customer"], "kept")
        self.assertNotIn("x-remove", forwarded)
        (self.directory / "busy").touch()
        status, headers, body = self.request(server, "GET")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["status"], "HealthyBusy")
        self.assertIn(("X-Child-Health", "observed"), headers)
        (self.directory / "unhealthy").touch()
        self.assertEqual(self.request(server, "GET")[0], 503)

    def test_first_stream_chunk_arrives_before_child_finishes(self):
        server = self.start()
        connection = http.client.HTTPConnection(*server.server_address, timeout=2)
        connection.request("POST", "/invocations", b"stream")
        response = connection.getresponse()
        self.assertEqual(response.status, 206)
        self.assertEqual(response.getheader("Content-Type"), "text/event-stream")
        self.assertIsNone(response.getheader("X-Private"))
        self.assertEqual(response.read(6), b"first!")
        self.assertFalse((self.directory / "release").exists())
        (self.directory / "release").touch()
        self.assertEqual(response.read(), b"last!")
        connection.close()
        wait_for(lambda: len(server.connections) == 0)

    def test_response_wait_exceeds_incoming_timeout_without_truncating_stream(self):
        server = self.start(request_timeout=0.05, response_timeout=1, response_delay=0.15)
        connection = http.client.HTTPConnection(*server.server_address, timeout=2)
        connection.request("POST", "/invocations", b"stream")
        response = connection.getresponse()
        self.assertEqual(response.status, 206)
        self.assertEqual(response.read(6), b"first!")
        # Both the initial response and the next chunk outlast the incoming request timeout.
        time.sleep(0.15)
        (self.directory / "release").touch()
        self.assertEqual(response.read(), b"last!")
        connection.close()

    def test_shutdown_during_mount_wait_does_not_launch_child(self):
        mounted = threading.Event()
        server = self.start(mount_ready=lambda mounts: mounted.is_set())
        with ThreadPoolExecutor(max_workers=1) as pool:
            request = pool.submit(self.request, server)
            wait_for(lambda: server.child.state == "starting")
            server.shutdown()
            server.close()
            mounted.set()
            with self.assertRaises((OSError, http.client.HTTPException)):
                request.result(timeout=2)
            wait_for(lambda: server.child.state == "failed")
        self.assertFalse((self.directory / "starts").exists())

    def test_shutdown_during_child_start_stops_descendants(self):
        server = self.start(unhealthy=True, grandchild=True)
        with ThreadPoolExecutor(max_workers=1) as pool:
            request = pool.submit(self.request, server)
            wait_for(lambda: (self.directory / "grandchild").exists())
            pid = int((self.directory / "starts").read_text())
            descendant = int((self.directory / "grandchild").read_text())
            server.shutdown()
            server.close()
            with self.assertRaises((OSError, http.client.HTTPException)):
                request.result(timeout=2)
            wait_for(lambda: not live(pid) and not live(descendant))
        self.assertEqual(len((self.directory / "starts").read_text().splitlines()), 1)

    def test_truncated_child_response_is_not_reported_as_complete(self):
        server = self.start()
        connection = http.client.HTTPConnection(*server.server_address, timeout=2)
        connection.request("POST", "/invocations", b"truncate")
        response = connection.getresponse()
        with self.assertRaises(http.client.IncompleteRead):
            response.read()
        connection.close()

    def test_ambiguous_framing_is_rejected_before_launch_and_chunked_body_works(self):
        server = self.start()
        invalid = [b"Content-Length: 0\r\nContent-Length: 0", b"Content-Length: 0\r\nTransfer-Encoding: chunked", b"Transfer-Encoding: gzip"]
        for headers in invalid:
            status, unused = self.raw(server, b"POST /invocations HTTP/1.1\r\nHost: test\r\n" + headers + b"\r\n\r\n")
            self.assertEqual(status, 400)
        self.assertFalse((self.directory / "starts").exists())
        status, body = self.raw(server, b"POST /invocations HTTP/1.1\r\nHost: test\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\nX-Trailer: ignored\r\n\r\n")
        self.assertEqual(status, 201)
        self.assertEqual(json.loads(body)["body"], "abcde")
        status, body = self.raw(server, b"POST /invocations HTTP/1.1\r\nHost: test\r\n\r\n")
        self.assertEqual(status, 201)
        self.assertEqual(json.loads(body)["body"], "")

    def test_child_start_failure_does_not_restart_or_expose_command(self):
        server = self.start(exit=True)
        for unused in range(2):
            status, _, body = self.request(server)
            self.assertEqual(status, 503)
            self.assertEqual(json.loads(body)["error"], "box_exited_during_start")
            self.assertNotIn(str(self.directory).encode(), body)
        self.assertEqual(len((self.directory / "starts").read_text().splitlines()), 1)

    def test_unhealthy_child_is_killed_and_does_not_restart(self):
        server = self.start(unhealthy=True, grandchild=True, startup_timeout=0.4)
        status, _, body = self.request(server)
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body)["error"], "box_health_timeout")
        pid = int((self.directory / "starts").read_text())
        descendant = int((self.directory / "grandchild").read_text())
        wait_for(lambda: not live(pid) and not live(descendant))
        self.assertEqual(self.request(server)[0], 503)
        self.assertEqual(len((self.directory / "starts").read_text().splitlines()), 1)

    def test_sigterm_stops_wrapper_child_and_descendant(self):
        command, child_port = self.command(grandchild=True)
        outer_port = available_port()
        config = {"command": command, "host": "127.0.0.1", "port": outer_port, "child_port": child_port,
                  "startup_timeout": 3, "shutdown_timeout": 0.2}
        process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--wrapper", json.dumps(config)])
        self.processes.append(process)
        def healthy():
            try:
                with socket.create_connection(("127.0.0.1", outer_port), timeout=0.1):
                    return True
            except OSError:
                return False
        wait_for(healthy)
        connection = http.client.HTTPConnection("127.0.0.1", outer_port, timeout=3)
        connection.request("POST", "/invocations", b"once")
        response = connection.getresponse()
        self.assertEqual(response.status, 201)
        response.read()
        connection.close()
        pid = int((self.directory / "starts").read_text())
        descendant = int((self.directory / "grandchild").read_text())
        process.terminate()
        self.assertEqual(process.wait(timeout=4), 0)
        wait_for(lambda: not live(pid) and not live(descendant))

    def test_child_exit_after_success_is_unhealthy_without_replay(self):
        server = self.start()
        self.assertEqual(self.request(server, body=b"once")[0], 201)
        server.child.process.terminate()
        wait_for(lambda: server.child.state == "failed")
        self.assertEqual(self.request(server, "GET")[0], 503)
        self.assertEqual(self.request(server, body=b"twice")[0], 503)
        self.assertEqual((self.directory / "requests").read_text().splitlines(), ["once"])
        self.assertEqual(len((self.directory / "starts").read_text().splitlines()), 1)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--child":
        child_main(json.loads(sys.argv[2]))
    elif len(sys.argv) > 1 and sys.argv[1] == "--wrapper":
        runtime.serve(**json.loads(sys.argv[2]))
    else:
        unittest.main()
