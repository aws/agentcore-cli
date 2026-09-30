"""AgentCore Runtime (ACR) lifecycle server for a BMA exec-server.

AgentCore calls ``GET /ping`` for health and ``POST /invocations`` for the BMA
lifecycle calls ``activate``, ``renew_turn_lease``, ``release_turn_lease``, and
``disconnect``. An invocation with no action returns the status.

The server runs one ``codex exec-server`` for the attachment of the last
``activate`` call and saves the attachment in ``state.json`` in ``BMA_STATE_DIR``.
The default is ``.bma`` in the home directory. If the server cannot create
``BMA_STATE_DIR``, it keeps ``state.json`` in ``.bma`` in the home directory.
AgentCore mounts session storage only when an invocation starts, so the server
reads ``state.json`` on the first invocation. On replacement compute, that
invocation starts the exec-server again.
"""

from __future__ import annotations

import contextlib
import json
import os
import shlex
import signal
import subprocess
import threading
import time
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from opentelemetry import propagate, trace

BMA_NAME = "bma-acr-lifecycle"
BMA_VERSION = "0.1.0"
TRACER = trace.get_tracer(BMA_NAME, BMA_VERSION)

BMA_CODEX_BINARY = Path(os.environ.get("BMA_CODEX_BINARY", "/opt/bma/bin/codex"))
BMA_HOME_DIR = Path(os.environ.get("BMA_HOME_DIR", str(Path.home())))
BMA_STATE_DIR = Path(os.environ.get("BMA_STATE_DIR", str(BMA_HOME_DIR / ".bma")))
BMA_CODEX_HOME = Path(os.environ.get("BMA_CODEX_HOME", str(BMA_HOME_DIR / ".codex")))
BMA_MAX_TURN_LEASE = max(1, int(os.environ.get("BMA_MAX_TURN_LEASE", "300")))

AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
BMA_REMOTE_SERVICE = "bedrock-mantle"

COLLECTOR_BINARY = Path("/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent")
COLLECTOR_CONFIG = Path("/opt/bma/otel/collector.yaml")
COLLECTOR_ENDPOINT = "http://127.0.0.1:4318"
COLLECTOR_COMMAND = [
    str(COLLECTOR_BINARY),
    "-config",
    os.devnull,
    "-otelconfig",
    str(COLLECTOR_CONFIG),
]
OBSERVABILITY_ENABLED = (
    os.environ.get("AGENT_OBSERVABILITY_ENABLED", "").lower() == "true"
)
EXPORTER = '{otlp-http={endpoint="%s/v1/%s",protocol="binary"}}'
TELEMETRY_OVERRIDES = [
    "-c",
    "otel.trace_exporter=" + EXPORTER % (COLLECTOR_ENDPOINT, "traces"),
    "-c",
    "otel.exporter=" + EXPORTER % (COLLECTOR_ENDPOINT, "logs"),
]

EXEC_SERVER_ENVIRONMENT = {
    "RUST_LOG": "codex_exec_server=info,codex_cli=info",
    "RUST_BACKTRACE": "1",
    "HOME": str(BMA_HOME_DIR),
    "CODEX_HOME": str(BMA_CODEX_HOME),
    "OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED": "false",
    "OTEL_PYTHON_LOG_CORRELATION": "false",
}

PROTOCOL_VERSION = 1
RESTART_DELAY_SECONDS = 5
STOP_GRACE_SECONDS = 3


def usable_dir(preferred: Path, fallback: Path) -> Path:
    """Creates and returns preferred, or fallback if the server cannot create preferred."""
    try:
        preferred.mkdir(parents=True, exist_ok=True)
        return preferred
    except OSError as error:
        log("directory_fallback", directory=str(preferred), error=str(error))
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback


def state_dir() -> Path:
    home = BMA_HOME_DIR / ".bma"
    return usable_dir(BMA_STATE_DIR if BMA_STATE_DIR.parent.is_dir() else home, home)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def log(message: str, **details: Any) -> None:
    record = {"timestamp": now(), "runtimeSessionId": LIFECYCLE.runtime_session_id}
    print(json.dumps({**record, "message": message, **details}), flush=True)


def step_span(name: str, **attributes: Any) -> Any:
    """Starts a child span of the current span. The span has the session ID for the console.

    A step outside a BMA call, for example an exec-server restart by the monitor thread, gets no span, so it does not
    start a new trace.
    """
    if not trace.get_current_span().get_span_context().is_valid:
        return contextlib.nullcontext(trace.INVALID_SPAN)
    if LIFECYCLE.runtime_session_id:
        attributes["session.id"] = LIFECYCLE.runtime_session_id
    return TRACER.start_as_current_span(name, attributes=attributes)


def failed(
    span: trace.Span, message: str, error: Exception | str, **details: Any
) -> None:
    """Logs a failed step and sets the error on its span."""
    log(message, **details, error=str(error))
    if isinstance(error, Exception):
        span.record_exception(error)
    span.set_status(trace.StatusCode.ERROR, str(error))


def valid_generation(generation: Any) -> bool:
    return type(generation) is int and generation >= 0


def parse_attachment(request: dict[str, Any]) -> tuple[str, int] | None:
    """Returns the environment ID and the attachment generation of a BMA call."""
    version = request.get("protocol_version")
    environment_id = request.get("environment_id")
    generation = request.get("attachment_generation")
    if type(version) is not int or version != PROTOCOL_VERSION:
        return None
    if not isinstance(environment_id, str) or not environment_id:
        return None
    if not valid_generation(generation):
        return None
    return environment_id, generation


BAD_ATTACHMENT = {
    "error": (
        f"protocol_version must be {PROTOCOL_VERSION}, environment_id is required, and "
        "attachment_generation must be a non-negative integer"
    )
}
EXEC_SERVER_DOWN = {"error": "the exec-server did not start"}
ATTACHMENT_TEXT_FIELDS = (
    "environment_id",
    "workspace_directory",
    "endpoint",
    "region",
    "service",
)


def valid_attachment(attachment: Any) -> bool:
    """Returns whether an attachment from activate or state.json can start the exec-server."""
    if not isinstance(attachment, dict):
        return False
    if not valid_generation(attachment.get("attachment_generation")):
        return False
    return all(
        isinstance(attachment.get(field), str)
        and attachment[field]
        and "\0" not in attachment[field]
        for field in ATTACHMENT_TEXT_FIELDS
    )


class Lifecycle:
    """Keeps the attachment, the exec-server, the collector, and the turn leases."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.runtime_session_id: str | None = None
        self.state_loaded = False
        self.attachment: dict[str, Any] | None = None
        self.process: subprocess.Popen[str] | None = None
        self.collector: subprocess.Popen[bytes] | None = None
        self.leases: dict[str, float] = {}

    def load_state(self, runtime_session_id: str | None) -> None:
        """Starts the exec-server for the saved attachment on the first invocation."""
        with self.lock:
            if runtime_session_id:
                self.runtime_session_id = runtime_session_id
            if self.state_loaded:
                return
            self.state_loaded = True
            with step_span("bma.state_load") as span:
                try:
                    saved = json.loads(
                        (state_dir() / "state.json").read_text(encoding="utf-8")
                    )
                except FileNotFoundError:
                    span.set_attribute("bma.state.found", False)
                    return
                except (OSError, ValueError) as error:
                    failed(span, "state_load_failed", error)
                    return
                span.set_attribute("bma.state.found", True)
                attachment = (
                    saved.get("attachment") if isinstance(saved, dict) else None
                )
                if valid_attachment(attachment):
                    self.attachment = attachment
                    log("state_loaded", **attachment)
                    self._ensure_running_locked("state_loaded")
                elif attachment is not None:
                    failed(
                        span, "state_load_failed", "state.json has a wrong attachment"
                    )

    def _save_locked(self) -> None:
        with step_span("bma.state_save") as span:
            try:
                directory = state_dir()
                temporary = directory / "state.json.tmp"
                temporary.write_text(
                    json.dumps({"attachment": self.attachment}), encoding="utf-8"
                )
                temporary.replace(directory / "state.json")
            except OSError as error:
                failed(span, "state_save_failed", error)

    def activate(self, request: dict[str, Any]) -> tuple[HTTPStatus, dict[str, Any]]:
        parsed = parse_attachment(request)
        if parsed is None:
            return HTTPStatus.BAD_REQUEST, BAD_ATTACHMENT
        workspace = request.get("workspace")
        directory = workspace.get("directory") if isinstance(workspace, dict) else None
        if not isinstance(directory, str) or not Path(directory).is_absolute():
            return HTTPStatus.BAD_REQUEST, {
                "error": "workspace.directory must be an absolute path"
            }
        with step_span(
            "bma.workspace_check", **{"bma.workspace.directory": directory}
        ) as span:
            try:
                Path(directory).mkdir(parents=True, exist_ok=True)
            except OSError as error:
                failed(span, "workspace_unavailable", error, directory=directory)
                return HTTPStatus.SERVICE_UNAVAILABLE, {
                    "error": f"cannot create workspace.directory: {error}"
                }
        environment_id, generation = parsed
        region = request.get("region") or AWS_REGION
        attachment = {
            "environment_id": environment_id,
            "attachment_generation": generation,
            "workspace_directory": directory,
            "endpoint": request.get("endpoint")
            or f"https://{BMA_REMOTE_SERVICE}.{region}.api.aws",
            "region": region,
            "service": request.get("service") or BMA_REMOTE_SERVICE,
        }
        if not valid_attachment(attachment):
            return HTTPStatus.BAD_REQUEST, {
                "error": "workspace.directory, endpoint, region, and service must be strings"
            }

        with self.lock:
            current_id, current_generation = self._key()
            if current_id == environment_id and generation < current_generation:
                return self._conflict("stale attachment generation")
            same = (current_id, current_generation) == parsed
            if not (same and self._running()):
                self._stop_locked("activate")
                if not same:
                    self.leases.clear()
                self.attachment = attachment
                self._save_locked()
            if not self._ensure_running_locked("activate"):
                return HTTPStatus.SERVICE_UNAVAILABLE, EXEC_SERVER_DOWN

        return HTTPStatus.OK, {
            "protocol_version": PROTOCOL_VERSION,
            "environment_id": environment_id,
            "attachment_generation": generation,
            "workspace": "ready",
            "exec_server": "connecting",
            "runtime_session_id": self.runtime_session_id,
        }

    def disconnect(self) -> tuple[HTTPStatus, dict[str, Any]]:
        with self.lock:
            self._stop_locked("disconnect")
            self.attachment = None
            self.leases.clear()
            self._save_locked()
        return HTTPStatus.OK, {
            "protocol_version": PROTOCOL_VERSION,
            "exec_server": "stopped",
        }

    def renew_turn_lease(
        self, request: dict[str, Any]
    ) -> tuple[HTTPStatus, dict[str, Any]]:
        turn_id = request.get("turn_id")
        duration = request.get("lease_duration_seconds")
        if (
            not isinstance(turn_id, str)
            or not turn_id
            or type(duration) is not int
            or duration < 1
        ):
            return HTTPStatus.BAD_REQUEST, {
                "error": "turn_id and a positive integer lease_duration_seconds are required"
            }
        accepted = min(duration, BMA_MAX_TURN_LEASE)
        with self.lock:
            if error := self._check_lease_locked(request):
                return error
            if not self._ensure_running_locked("renew_turn_lease"):
                return HTTPStatus.SERVICE_UNAVAILABLE, EXEC_SERVER_DOWN
            deadline = time.monotonic() + accepted
            self.leases[turn_id] = max(self.leases.get(turn_id, deadline), deadline)
            body = self._lease_body(turn_id, lease_duration_seconds=accepted)
        log(
            "turn_lease_renewed",
            turnId=turn_id,
            leaseDurationSeconds=accepted,
            activeLeases=body["active_lease_count"],
        )
        return HTTPStatus.OK, body

    def release_turn_lease(
        self, request: dict[str, Any]
    ) -> tuple[HTTPStatus, dict[str, Any]]:
        turn_id = request.get("turn_id")
        if not isinstance(turn_id, str) or not turn_id:
            return HTTPStatus.BAD_REQUEST, {"error": "turn_id is required"}
        with self.lock:
            if error := self._check_lease_locked(request):
                return error
            released = self.leases.pop(turn_id, None) is not None
            body = self._lease_body(turn_id, released=released)
        log(
            "turn_lease_released",
            turnId=turn_id,
            released=released,
            activeLeases=body["active_lease_count"],
        )
        return HTTPStatus.OK, body

    def _lease_body(self, turn_id: str, **fields: Any) -> dict[str, Any]:
        environment_id, generation = self._key()
        return {
            "protocol_version": PROTOCOL_VERSION,
            "environment_id": environment_id,
            "attachment_generation": generation,
            "turn_id": turn_id,
            **fields,
            "active_lease_count": len(self.leases),
        }

    def _check_lease_locked(
        self, request: dict[str, Any]
    ) -> tuple[HTTPStatus, dict[str, Any]] | None:
        parsed = parse_attachment(request)
        if parsed is None:
            return HTTPStatus.BAD_REQUEST, BAD_ATTACHMENT
        with step_span("bma.attachment_check") as span:
            matched = self._key() == parsed
            span.set_attribute("bma.attachment.matched", matched)
            if not matched:
                return self._conflict("turn lease does not match the active attachment")
        self._prune_locked()
        return None

    def _conflict(self, message: str) -> tuple[HTTPStatus, dict[str, Any]]:
        environment_id, generation = self._key()
        return HTTPStatus.CONFLICT, {
            "error": message,
            "environment_id": environment_id,
            "attachment_generation": generation,
        }

    def _key(self) -> tuple[str | None, int | None]:
        """Returns the environment ID and the generation of the attachment."""
        attachment = self.attachment or {}
        return attachment.get("environment_id"), attachment.get("attachment_generation")

    def _prune_locked(self) -> None:
        cutoff = time.monotonic()
        self.leases = {turn: end for turn, end in self.leases.items() if end > cutoff}

    def health(self) -> str:
        """Does not take the lock, so an exec-server stop does not delay /ping."""
        cutoff = time.monotonic()
        busy = any(end > cutoff for end in self.leases.copy().values())
        return "HealthyBusy" if busy else "Healthy"

    def status(self) -> dict[str, Any]:
        with self.lock:
            self._prune_locked()
            return {
                "service": f"{BMA_NAME}/{BMA_VERSION}",
                "runtimeSessionId": self.runtime_session_id,
                "attachment": self.attachment,
                "execServerRunning": self._running(),
                "activeLeaseCount": len(self.leases),
            }

    def _running(self) -> bool:
        return self.process is not None and self.process.poll() is None

    def _ensure_running_locked(self, reason: str) -> bool:
        """Starts the exec-server for the attachment if it does not run. Returns whether it runs."""
        attachment = self.attachment
        if attachment is None:
            return False
        if self._running():
            return True
        with step_span("bma.exec_server_start", **{"bma.reason": reason}) as span:
            command = [
                str(BMA_CODEX_BINARY),
                *(TELEMETRY_OVERRIDES if self._ensure_collector_locked() else []),
                "exec-server",
                "--remote",
                f"{attachment['endpoint'].rstrip('/')}/v1",
                "--environment-id",
                attachment["environment_id"],
                "--remote-transport",
                "direct",
                "--aws-sigv4",
                "--aws-service",
                attachment["service"],
                "--aws-region",
                attachment["region"],
            ]
            try:
                workspace = Path(attachment["workspace_directory"])
                workspace.mkdir(parents=True, exist_ok=True)
                BMA_HOME_DIR.mkdir(parents=True, exist_ok=True)
                BMA_CODEX_HOME.mkdir(parents=True, exist_ok=True)
                log(
                    "exec_server_start",
                    reason=reason,
                    command=shlex.join(command),
                    cwd=str(workspace),
                    **attachment,
                )
                self.process = subprocess.Popen(
                    command,
                    cwd=workspace,
                    env={**os.environ, **EXEC_SERVER_ENVIRONMENT},
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                    start_new_session=True,
                )
            except (OSError, ValueError) as error:
                self.process = None
                failed(span, "exec_server_start_failed", error)
                return False
            span.set_attribute("process.pid", self.process.pid)
        threading.Thread(target=self._drain, args=(self.process,), daemon=True).start()
        return True

    def _ensure_collector_locked(self) -> bool:
        """Starts the collector if it does not run. Returns whether it gets the Codex spans and logs."""
        if not OBSERVABILITY_ENABLED or not self.runtime_session_id:
            return False
        if self.collector is not None and self.collector.poll() is None:
            return True
        environment = {
            **os.environ,
            "AGENTCORE_RUNTIME_SID": self.runtime_session_id,
        }
        with step_span("bma.collector_start") as span:
            try:
                self.collector = subprocess.Popen(COLLECTOR_COMMAND, env=environment)
            except OSError as error:
                failed(span, "collector_start_failed", error)
                return False
            span.set_attribute("process.pid", self.collector.pid)
        log("collector_start", pid=self.collector.pid)
        return True

    def _stop_locked(self, reason: str) -> None:
        process, self.process = self.process, None
        if process is None or process.poll() is not None:
            return
        log("exec_server_stop", reason=reason, pid=process.pid)
        with step_span(
            "bma.exec_server_stop", **{"bma.reason": reason, "process.pid": process.pid}
        ) as span:
            process.terminate()
            try:
                process.wait(timeout=STOP_GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                span.set_attribute("bma.killed", True)

    @staticmethod
    def _drain(process: subprocess.Popen[str]) -> None:
        for line in process.stdout or []:
            log("exec_server_output", line=line.rstrip("\n"))
        log("exec_server_exited", returnCode=process.wait())

    def monitor(self) -> None:
        """Starts the exec-server again if it stops while an attachment is active."""
        while True:
            time.sleep(RESTART_DELAY_SECONDS)
            with self.lock:
                self._ensure_running_locked("monitor")

    def shutdown(self) -> None:
        with self.lock:
            self._stop_locked("shutdown")
            if self.collector is not None:
                self.collector.terminate()

    def dispatch(
        self, action: str, request: dict[str, Any]
    ) -> tuple[HTTPStatus, dict[str, Any]]:
        handlers = {
            "activate": self.activate,
            "renew_turn_lease": self.renew_turn_lease,
            "release_turn_lease": self.release_turn_lease,
            "disconnect": lambda _: self.disconnect(),
            "status": lambda _: (HTTPStatus.OK, self.status()),
        }
        if action not in handlers:
            return HTTPStatus.BAD_REQUEST, {"error": f"unknown action: {action}"}
        return handlers[action](request)


LIFECYCLE = Lifecycle()


class Handler(BaseHTTPRequestHandler):
    server_version = f"{BMA_NAME}/{BMA_VERSION}"
    protocol_version = "HTTP/1.1"

    def send_json(self, status: HTTPStatus, body: dict[str, Any]) -> None:
        """Sends HTTP 200, because the Runtime drops the body of any other status."""
        if status != HTTPStatus.OK:
            body = {**body, "status_code": int(status)}
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def read_body(self) -> bytes:
        """Reads the request body, with Content-Length or chunked transfer encoding."""
        if "chunked" not in self.headers.get("Transfer-Encoding", "").lower():
            length = int(self.headers.get("Content-Length") or 0)
            return self.rfile.read(length) if length > 0 else b""
        chunks = []
        while size := int(self.rfile.readline().split(b";")[0], 16):
            chunks.append(self.rfile.read(size))
            self.rfile.readline()
        # Read the trailer section to the empty line that ends the request.
        while self.rfile.readline().strip():
            pass
        return b"".join(chunks)

    def do_GET(self) -> None:
        if self.path == "/ping":
            self.send_json(HTTPStatus.OK, {"status": LIFECYCLE.health()})
        else:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "route not found"})

    def do_POST(self) -> None:
        if self.path != "/invocations":
            self.close_connection = True
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "route not found"})
            return
        try:
            body = self.read_body()
            request = json.loads(body) if body else {}
        except ValueError:
            request = None
        if not isinstance(request, dict):
            self.close_connection = True
            self.send_json(
                HTTPStatus.BAD_REQUEST, {"error": "request body must be a JSON object"}
            )
            return
        runtime_session_id = self.headers.get(
            "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id"
        )
        action = str(request.get("action", "status"))
        with TRACER.start_as_current_span(
            "bma.invocation",
            context=propagate.extract(self.headers),
            kind=trace.SpanKind.SERVER,
            attributes={"bma.action": action},
        ) as span:
            if runtime_session_id:
                span.set_attribute("session.id", runtime_session_id)
            try:
                LIFECYCLE.load_state(runtime_session_id)
                status, body = LIFECYCLE.dispatch(action, request)
            except Exception as error:
                log("dispatch_failed", action=action, error=str(error))
                span.record_exception(error)
                status, body = (
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": "internal error"},
                )
            span.set_attribute("http.response.status_code", int(status))
            if status >= HTTPStatus.INTERNAL_SERVER_ERROR:
                span.set_status(trace.StatusCode.ERROR)
        self.send_json(status, body)

    def log_message(self, message_format: str, *args: Any) -> None:
        if getattr(self, "path", None) == "/ping":
            return
        log("http", client=self.client_address[0], request=message_format % args)


def serve() -> None:
    def handle(signal_number: int, _frame: Any) -> None:
        log("signal", signal=signal_number)
        LIFECYCLE.shutdown()
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, handle)
    signal.signal(signal.SIGINT, handle)
    threading.Thread(target=LIFECYCLE.monitor, daemon=True).start()
    log("server_ready", port=8080, stateDir=str(BMA_STATE_DIR))
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()


if __name__ == "__main__":
    serve()
