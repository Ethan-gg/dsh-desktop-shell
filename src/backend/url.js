'use strict';

const ANSI_RE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const URL_LINE_RE = /dsh web:\s+(https?:\/\/\S+)/;

function stripAnsi(value) {
  return String(value).replace(ANSI_RE, '');
}

function isLoopbackHostname(hostname) {
  const value = hostname.toLowerCase();
  return value === '127.0.0.1' || value === 'localhost' || value === '[::1]' || value === '::1';
}

/**
 * Parse the one line dsh prints after the Web server is listening:
 *
 *   dsh web: http://127.0.0.1:19828/?token=...
 *
 * The token is the *only* way to enter the UI. Loading a bare
 * http://127.0.0.1:<port>/ returns 401, so this URL must be loaded exactly as
 * printed. We still validate it rather than trusting arbitrary child output.
 */
function parseDshUrl(text) {
  const match = stripAnsi(text).match(URL_LINE_RE);
  if (!match) return null;

  let url;
  try {
    url = new URL(match[1].replace(/[),.;]+$/u, ''));
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!isLoopbackHostname(url.hostname)) return null;
  if (!url.searchParams.get('token')) return null;
  return url.href;
}

function redact(value) {
  return String(value)
    .replace(/(\bhttps?:\/\/)([^/@\s]+)@/gi, '$1<redacted>@')
    .replace(/([?&]token=)[^&\s"'<>]+/gi, '$1<redacted>');
}

function safeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

module.exports = {
  ANSI_RE,
  isLoopbackHostname,
  parseDshUrl,
  redact,
  safeOrigin,
  stripAnsi,
};
