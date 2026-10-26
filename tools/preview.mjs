#!/usr/bin/env node
/**
 * 预览服务器：静态托管 extension/ 目录，方便不开浏览器扩展也能预览 UI。
 *
 *   node tools/preview.mjs          → http://127.0.0.1:8899/popup.html
 *   node tools/preview.mjs 9000     → 换端口
 *
 * 预览模式下 lib/preview-shim.js 会提供模拟的 chrome API 和示例数据。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', 'extension');
const DOCS = path.resolve(__dirname, '..', 'docs');
const PORT = Number(process.argv[2] || process.env.PORT || 8899);
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/popup.html';

  // /docs/** 映射到仓库根下的 docs/（文档截图用的固定数据）
  let base = ROOT;
  if (rel === '/docs' || rel.startsWith('/docs/')) {
    base = DOCS;
    rel = rel.slice('/docs'.length) || '/';
  }

  const filePath = path.join(base, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(base)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(
    [
      '',
      '  预览服务器已启动（模拟数据，不会连真实中继）',
      `  popup    http://${HOST}:${PORT}/popup.html`,
      `  options  http://${HOST}:${PORT}/options.html`,
      '',
      '  Ctrl+C 退出。',
      ''
    ].join('\n')
  );
});
