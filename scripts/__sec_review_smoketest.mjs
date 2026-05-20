// Deliberately vulnerable file used to smoke-test the Claude Security Review
// workflow. Two HIGH-severity findings the bundled /security-review skill
// should flag and post as inline review comments. Will be deleted once the
// posting path is verified.
import { exec } from 'node:child_process';
import http from 'node:http';

// FINDING 1 — Hardcoded credential pattern.
const HARDCODED_AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const HARDCODED_AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

function buildSignedRequest(payload) {
  return {
    payload,
    auth: `AWS4-HMAC-SHA256 Credential=${HARDCODED_AWS_ACCESS_KEY_ID}`,
    secret: HARDCODED_AWS_SECRET_ACCESS_KEY,
  };
}

// FINDING 2 — Command injection via exec() with unvalidated HTTP query parameter.
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const target = url.searchParams.get('host') ?? 'localhost';

  exec(`ping -c 1 ${target}`, (err, stdout, stderr) => {
    if (err) {
      res.writeHead(500);
      res.end(String(err));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(stdout || stderr);
  });
});

export { buildSignedRequest, server };
