/** Structured JSON lines. Redacts anything that looks like a secret or a tokenised URL. */
const SECRET_KEY = /(key|secret|token|passphrase|password|private)/i;

function redact(v: unknown, k = ''): unknown {
  if (typeof v === 'string') {
    if (SECRET_KEY.test(k)) return '[redacted]';
    return v.replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g, '$1?[redacted]').replace(/[1-9A-HJ-NP-Za-km-z]{80,}/g, '[redacted]');
  }
  if (Array.isArray(v)) return v.map((x) => redact(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, redact(vv, kk)]));
  return v;
}

type Level = 'debug' | 'info' | 'warn' | 'error';
function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg: redact(msg), ...(fields ? (redact(fields) as object) : {}) });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => write('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => write('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => write('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => write('error', m, f),
  redact,
};
