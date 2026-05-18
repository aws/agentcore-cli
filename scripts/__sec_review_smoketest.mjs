// Deliberately vulnerable file used to smoke-test the Claude Security Review
// workflow. Will be deleted in a follow-up commit once we verify the action
// posts inline comments correctly. Do not import this file from anywhere.
// eslint-disable
import { exec } from 'node:child_process';
import http from 'node:http';

// FINDING 1 (hardcoded credential): an AWS-style access key checked into source.
// This should be picked up under "Hardcoded API keys, passwords, or tokens".
const HARDCODED_AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const HARDCODED_AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

function buildSignedRequest(payload) {
  // Trivial use so the constants aren't dead code; the credential being checked
  // in is the actual finding regardless of how it is consumed.
  return {
    payload,
    auth: `AWS4-HMAC-SHA256 Credential=${HARDCODED_AWS_ACCESS_KEY_ID}`,
    secret: HARDCODED_AWS_SECRET_ACCESS_KEY,
  };
}

// FINDING 2 (command injection): builds a shell command from an HTTP query
// string parameter and passes it to exec(). This is a clear OS-command
// injection sink with a concrete attack path from untrusted user input.
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
