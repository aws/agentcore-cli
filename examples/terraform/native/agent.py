"""Dependency-free Runtime smoke test. No model calls or customer data."""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.respond({"status": "Healthy"}, 200 if self.path == "/ping" else 404)

    def do_POST(self):
        if self.path != "/invocations":
            return self.respond({"error": "not found"}, 404)
        try:
            payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        except (ValueError, json.JSONDecodeError):
            return self.respond({"error": "invalid JSON"}, 400)
        self.respond({
            "method": os.environ["DEPLOYMENT_METHOD"],
            "memoryId": os.environ["AGENTCORE_MEMORY_HISTORY_ID"],
            "echo": payload,
        })

    def respond(self, body, status=200):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
