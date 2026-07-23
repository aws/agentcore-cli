const REDACTED = '[REDACTED]';
const MIN_SECRET_LENGTH = 8;
const PRIVATE_KEY_TYPES = ['', 'RSA ', 'EC ', 'OPENSSH '] as const;

interface SecretPattern {
  pattern: RegExp;
  replacement?: (match: string, ...groups: string[]) => string;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g },
  { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    pattern: /\bbearer[ \t]+[A-Za-z0-9._~+/-]{16,2048}={0,2}/gi,
    replacement: () => `Bearer ${REDACTED}`,
  },
  {
    pattern:
      /(\b(?:api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|password|secret|session[_-]?token|token)\b\s*[:=]\s*["']?)([^"',;<>{}[\]\s]{8,})/gi,
    replacement: (_match, prefix) => `${prefix}${REDACTED}`,
  },
];

const SENSITIVE_ENV_KEY =
  /(?:^|_)(?:ACCESS_KEY_ID|API_KEY|API_KEY_SECRET|APP_PRIVATE_KEY|CLIENT_SECRET|PASSWORD|PRIVATE_KEY|SECRET|SECRET_ACCESS_KEY|SESSION_TOKEN|TOKEN|WALLET_SECRET)$/i;
const REFERENCE_ENV_KEY = /(?:^|_)(?:API_KEY_ID|APP_ID|AUTHORIZATION_ID|CLIENT_ID)$/i;

export interface RedactionResult {
  text: string;
  redactions: number;
}

export function sensitiveEnvironmentValues(environment: NodeJS.ProcessEnv = process.env): string[] {
  const values = Object.entries(environment)
    .filter((entry): entry is [string, string] => {
      const [key, value] = entry;
      return (
        typeof value === 'string' &&
        value.length >= MIN_SECRET_LENGTH &&
        SENSITIVE_ENV_KEY.test(key) &&
        !REFERENCE_ENV_KEY.test(key)
      );
    })
    .map(([, value]) => value);

  return [...new Set(values)].sort((left, right) => right.length - left.length);
}

export function redactTestOutput(input: string, secretValues: readonly string[] = []): RedactionResult {
  let text = input;
  let redactions = 0;

  for (const keyType of PRIVATE_KEY_TYPES) {
    const beginMarker = `-----BEGIN ${keyType}PRIVATE KEY-----`;
    const endMarker = `-----END ${keyType}PRIVATE KEY-----`;
    let beginIndex = text.indexOf(beginMarker);

    while (beginIndex >= 0) {
      const endIndex = text.indexOf(endMarker, beginIndex + beginMarker.length);
      if (endIndex < 0) break;
      text = text.slice(0, beginIndex) + REDACTED + text.slice(endIndex + endMarker.length);
      redactions += 1;
      beginIndex = text.indexOf(beginMarker, beginIndex + REDACTED.length);
    }
  }

  for (const secret of [...new Set(secretValues)].sort((left, right) => right.length - left.length)) {
    if (secret.length < MIN_SECRET_LENGTH || !text.includes(secret)) continue;
    const occurrences = text.split(secret).length - 1;
    text = text.split(secret).join(REDACTED);
    redactions += occurrences;
  }

  for (const { pattern, replacement } of SECRET_PATTERNS) {
    text = text.replace(pattern, (match: string, ...groups: string[]) => {
      redactions += 1;
      return replacement ? replacement(match, ...groups) : REDACTED;
    });
  }

  return { text, redactions };
}

export function containsSensitiveTestOutput(input: string, secretValues: readonly string[] = []): boolean {
  return redactTestOutput(input, secretValues).redactions > 0;
}
