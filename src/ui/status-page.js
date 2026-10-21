'use strict';

const { redact } = require('../backend/url');

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function statusHtml({ title, detail = '', tone = 'working' } = {}) {
  const safeTitle = escapeHtml(redact(title || '正在启动 dsh 后端'));
  const safeDetail = escapeHtml(redact(detail || '后端就绪后会自动进入工作区，无需操作。'));
  const color = tone === 'error' ? '#ff7b72' : tone === 'warn' ? '#d29922' : '#58a6ff';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: grid;
    place-items: center;
    background: radial-gradient(1100px 700px at 50% -10%, #1b2430 0%, #0d1117 55%, #090c10 100%);
    color: #e6edf3;
    font-family: "Segoe UI", "Microsoft YaHei UI", system-ui, -apple-system, sans-serif;
  }
  main { width: min(560px, calc(100vw - 64px)); text-align: center; }
  .mark {
    width: 64px; height: 64px; margin: 0 auto 26px;
    border-radius: 18px;
    background: linear-gradient(140deg, #1f6feb, ${color});
    box-shadow: 0 18px 60px rgba(31, 111, 235, .28);
    position: relative;
  }
  .mark::after {
    content: "d";
    position: absolute; inset: 0;
    display: grid; place-items: center;
    color: white; font: 700 40px/1 "Segoe UI", sans-serif;
    transform: translateY(-2px);
  }
  h1 { margin: 0 0 12px; font-size: 22px; font-weight: 650; letter-spacing: .2px; }
  p { margin: 0; color: #8b949e; font-size: 14px; line-height: 1.8; white-space: pre-wrap; }
  .bar {
    width: 180px; height: 3px; margin: 28px auto 0; border-radius: 99px;
    background: #21262d; overflow: hidden;
  }
  .bar::after {
    content: ""; display: block; width: 42%; height: 100%; border-radius: inherit;
    background: linear-gradient(90deg, transparent, ${color}, transparent);
    animation: slide 1.4s ease-in-out infinite;
  }
  @keyframes slide { from { transform: translateX(-120%); } to { transform: translateX(340%); } }
  @media (prefers-reduced-motion: reduce) { .bar::after { animation: none; width: 100%; opacity: .5; } }
</style>
</head>
<body>
<main>
  <div class="mark" aria-hidden="true"></div>
  <h1>${safeTitle}</h1>
  <p>${safeDetail}</p>
  <div class="bar" aria-hidden="true"></div>
</main>
</body>
</html>`;
}

function statusDataUrl(options) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(statusHtml(options))}`;
}

module.exports = { escapeHtml, statusDataUrl, statusHtml };
