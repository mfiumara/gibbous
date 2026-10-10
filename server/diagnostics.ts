// The debug bundle people paste into an issue: versions, health, counts and log tails, with secrets scrubbed.
import fs from 'node:fs';

export function redact(text: string, known: string[] = []) {
  for (const k of known) if (k && k.length >= 8) text = text.split(k).join('[redacted]');
  return text
    .replace(/(Bearer\s+|token=|[?&]key=|"(?:api_?key|token|password|secret|accessToken)"\s*:\s*")[^\s"&]+/gi, '$1[redacted]')
    .replace(/\b(sk|pk|ghp|gho|xox[abp]|AKIA)[-_A-Za-z0-9]{12,}/g, '[redacted]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[redacted]');
}

export function tail(file: string, lines = 120) {
  try {
    const fd = fs.openSync(file, 'r'), size = fs.fstatSync(fd).size, buf = Buffer.alloc(Math.min(size, 256 * 1024));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length); fs.closeSync(fd);
    return buf.toString().split('\n').slice(-lines).join('\n');
  } catch { return '(no log)'; }
}
