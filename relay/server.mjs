#!/usr/bin/env node
/**
 * GitHub Tab Collector — 本地中继服务（零依赖，Node >= 18）
 *
 *   POST /ingest     扩展推送快照（Bearer 鉴权，可选）
 *   GET  /links      取 JSON 快照（Agent 最常用）
 *   GET  /links.md   取 Markdown
 *   GET  /health     健康检查
 *   GET  /           人看的网页面板
 *
 * 同时把快照写入 data/github-tabs.json 与 data/github-links.md，方便任意工具直接读文件。
 *
 * 启动：node relay/server.mjs
 * 环境变量：
 *   PORT        监听端口，默认 8788
 *   HOST        监听地址，默认 127.0.0.1
 *   RELAY_TOKEN 访问令牌，不设则自动生成并写入 data/relay-token.txt
 *   DATA_DIR    数据目录，默认 ./data
 */

import http from 'node:http';
import fs from 'node:fs';
import path, { basename } from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || '127.0.0.1';
/** 实际绑定的端口（PORT=0 时由系统随机分配，面板横幅要用真实值） */
let boundPort = PORT;
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const POLL_WAIT_MS = Number(process.env.POLL_WAIT_MS || 20000);
const REFRESH_WAIT_MS = Number(process.env.REFRESH_WAIT_MS || 25000);
const JSON_FILE = path.join(DATA_DIR, 'github-tabs.json');
const MD_FILE = path.join(DATA_DIR, 'github-links.md');
const TOKEN_FILE = path.join(DATA_DIR, 'relay-token.txt');
const PID_FILE = path.join(DATA_DIR, 'relay.pid');
/** 扩展目录里的令牌副本：扩展可读取自身目录中的文件，用它做零握手自动配对 */
const EXT_TOKEN_FILE = path.join(ROOT, 'extension', 'relay-token.txt');

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* 令牌                                                                */
/* ------------------------------------------------------------------ */

function resolveToken() {
  if (process.env.RELAY_TOKEN) return process.env.RELAY_TOKEN;
  try {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* 首次运行 */
  }
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_FILE, token, 'utf8');
  return token;
}
const TOKEN = resolveToken();

/**
 * 把令牌同步一份到扩展目录，扩展用它零握手自动配对。
 * 仅在使用本地生成的令牌时同步：自建部署（RELAY_TOKEN）不应覆盖扩展的配对文件。
 */
function publishTokenToExtension() {
  if (process.env.RELAY_TOKEN) return false;
  try {
    fs.mkdirSync(path.dirname(EXT_TOKEN_FILE), { recursive: true });
    fs.writeFileSync(EXT_TOKEN_FILE, TOKEN + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}
publishTokenToExtension();

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

let state = {
  snapshot: {
    generatedAt: new Date().toISOString(),
    source: 'github-tab-collector',
    counts: { repos: 0, githubTabs: 0, issues: 0, pulls: 0, gists: 0, other: 0 },
    repos: [],
    items: []
  },
  receivedAt: null,
  reason: null,
  hits: 0,
  /** 是否有 agent 请求了最新快照 */
  refreshRequested: false,
  /** 等待新快照的请求方 */
  waiters: []
};

/* ------------------------------------------------------------------ */
/* 按需刷新（拉取模式）                                                */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function requestRefresh() {
  state.refreshRequested = true;
}

/** 收到新快照时唤醒所有等待者 */
function resolveWaiters() {
  const list = state.waiters.splice(0, state.waiters.length);
  for (const w of list) {
    clearTimeout(w.timer);
    w.resolve(true);
  }
}

/** 等待下一份新快照；超时返回 false */
function waitForSnapshot(timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const idx = state.waiters.findIndex((w) => w.timer === timer);
      if (idx >= 0) state.waiters.splice(idx, 1);
      resolve(false);
    }, timeoutMs);
    state.waiters.push({ resolve, timer });
  });
}

function loadFromDisk() {
  try {
    const raw = fs.readFileSync(JSON_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.snapshot) {
      state.snapshot = parsed.snapshot;
      state.receivedAt = parsed.receivedAt || null;
    } else if (parsed && parsed.repos) {
      state.snapshot = parsed;
    }
  } catch {
    /* 没有历史数据，忽略 */
  }
}
loadFromDisk();

/* ------------------------------------------------------------------ */
/* Markdown 渲染                                                      */
/* ------------------------------------------------------------------ */

/* 打开时间格式化：2026-10-26 16:24 */
function formatOpenedAt(entry) {
  const ms = entry && entry.openedAtMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '未知';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '未知';
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  const approx = entry.openedAtSource === 'session-start' ? '≈' : '';
  return `${approx}${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* 排序：最早打开的在前 */
function sortByOpenedAt(list) {
  return (list || []).slice().sort((a, b) => {
    const at = typeof a.openedAtMs === 'number' ? a.openedAtMs : Infinity;
    const bt = typeof b.openedAtMs === 'number' ? b.openedAtMs : Infinity;
    if (at !== bt) return at - bt;
    const ai = typeof a.tabIndex === 'number' ? a.tabIndex : 9999;
    const bi = typeof b.tabIndex === 'number' ? b.tabIndex : 9999;
    if (ai !== bi) return ai - bi;
    const an = (a.fullName || a.url || '').toLowerCase();
    const bn = (b.fullName || b.url || '').toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

function toMarkdown(snapshot) {
  const lines = [];
  lines.push('# GitHub 项目链接（浏览器已打开标签页）');
  lines.push('');
  lines.push(`> 更新时间：${snapshot.generatedAt}`);
  lines.push(`> 仓库 ${snapshot.counts.repos} 个 / GitHub 标签页 ${snapshot.counts.githubTabs} 个`);
  lines.push('> 排序：按标签页打开时间从早到晚');
  lines.push('');
  lines.push('## 仓库');
  lines.push('');
  if (!snapshot.repos.length) {
    lines.push('_(没有打开的 GitHub 仓库标签页)_');
  } else {
    for (const r of sortByOpenedAt(snapshot.repos)) {
      lines.push(`- **${r.fullName}** — ${r.url}`);
      lines.push(`  - 打开于：${formatOpenedAt(r)}`);
      if (r.titles && r.titles.length) lines.push(`  - 标签页标题：${r.titles.join(' / ')}`);
    }
  }
  lines.push('');
  lines.push('## 其他 GitHub 链接');
  lines.push('');
  const others = sortByOpenedAt((snapshot.items || []).filter((i) => i.type !== 'repo'));
  if (!others.length) {
    lines.push('_(无)_');
  } else {
    for (const i of others) {
      const label = i.type + (i.number ? ' #' + i.number : '');
      lines.push(`- [${label}](${i.url})${i.titles && i.titles.length ? ' — ' + i.titles[0] : ''}`);
      lines.push(`  - 打开于：${formatOpenedAt(i)}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function persist() {
  const payload = {
    receivedAt: state.receivedAt,
    reason: state.reason,
    snapshot: state.snapshot
  };
  fs.writeFileSync(JSON_FILE, JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(MD_FILE, toMarkdown(state.snapshot), 'utf8');
}

/* ------------------------------------------------------------------ */
/* HTTP 辅助                                                          */
/* ------------------------------------------------------------------ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Max-Age': '600'
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...CORS
  });
  res.end(body);
}

function sendText(res, code, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...CORS
  });
  res.end(text);
}

function authorized(req) {
  if (!TOKEN) return true;
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (m && m[1].trim() === TOKEN) return true;
  // 允许来自本机带 token 的查询参数
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.searchParams.get('token') === TOKEN) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * 一键配对：只把令牌交给浏览器扩展。
 *
 * 判定依据：
 *  - Origin 为 chrome-extension://…（部分浏览器会带）
 *  - 或者完全没有 Origin 头：网页发起的跨域 fetch/XHR 一定会带 Origin（opaque 源带 "null"），
 *    而扩展在有 host_permissions 时是直连请求，服务端看不到 Origin。
 * 两条都要求没有 Sec-Fetch-Site —— 网页请求必带该头。
 */
function isExtensionOrigin(req) {
  const origin = req.headers.origin || '';
  if (req.headers['sec-fetch-site']) return false;
  if (/^chrome-extension:\/\/[a-p]{32}$/i.test(origin)) return true;
  if (!origin) return true;
  return false;
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const HTML_ENTITIES = {
  '<': 'lt',
  '>': 'gt',
  '"': 'quot',
  "'": '#39'
};

function escapeHtml(s) {
  const amp = String.fromCharCode(38);
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? amp : amp + HTML_ENTITIES[c]
  );
}

function dashboardHtml() {
  const s = state.snapshot;
  const rows = sortByOpenedAt(s.repos || [])
    .map(
      (r) => `<tr>
        <td class="mono">${escapeHtml(formatOpenedAt(r))}</td>
        <td class="mono"><a href="${escapeHtml(r.url)}" target="_blank" rel="noreferrer">${escapeHtml(r.fullName)}</a></td>
        <td>${escapeHtml((r.titles && r.titles[0]) || '')}</td>
        <td class="num">${r.tabCount || 1}</td>
      </tr>`
    )
    .join('\n');

  const others = sortByOpenedAt((s.items || []).filter((i) => i.type !== 'repo'))
    .map(
      (i) => `<tr>
        <td><span class="tag ${escapeHtml(i.type)}">${escapeHtml(i.type)}${i.number ? '#' + i.number : ''}</span></td>
        <td class="mono">${escapeHtml(formatOpenedAt(i))}</td>
        <td class="mono"><a href="${escapeHtml(i.url)}" target="_blank" rel="noreferrer">${escapeHtml(i.url)}</a></td>
        <td>${escapeHtml((i.titles && i.titles[0]) || '')}</td>
      </tr>`
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="10">
<title>GitHub Tab Collector · 中继</title>
<style>
  @font-face {
    font-family:'Fusion Pixel';
    src:url('/fonts/fusion-pixel-12px-latin.woff2') format('woff2');
    font-display:swap;
    unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+2000-206F,U+2190-21BB,U+2212,U+FEFF,U+FFFD;
  }
  @font-face {
    font-family:'Fusion Pixel';
    src:url('/fonts/fusion-pixel-12px-zh_hans.woff2') format('woff2');
    font-display:swap;
    unicode-range:U+3000-303F,U+4E00-9FFF,U+FF00-FFEF;
  }
  :root {
    --shell:#c4bfb0; --panel:#dbd6c4; --light:#efecdc; --mid:#8b8776;
    --ink:#2b2a24; --green:#4d7c3f; --red:#b04a3a; --gold:#c9a227; --magenta:#a3346e;
    /* 像素箭头：4 段纯色条，靠 background-size / background-position 排成阶梯三角 */
    --arrow:
      linear-gradient(var(--ink),var(--ink)), linear-gradient(var(--ink),var(--ink)),
      linear-gradient(var(--ink),var(--ink)), linear-gradient(var(--ink),var(--ink));
  }
  * { box-sizing:border-box; margin:0; padding:0 }
  body {
    padding:18px 20px 60px; color:var(--ink); background:var(--shell);
    font-family:'Fusion Pixel', ui-monospace, Consolas, monospace; font-size:12px; line-height:18px;
    -webkit-font-smoothing:none; text-rendering:geometricPrecision;
    background-image:
      repeating-linear-gradient(0deg, rgba(43,42,36,.05) 0 1px, transparent 1px 6px),
      repeating-linear-gradient(90deg, rgba(43,42,36,.05) 0 1px, transparent 1px 6px);
  }
  h1 { font-size:24px; line-height:30px; font-weight:normal; letter-spacing:2px }
  h2 { font-size:12px; letter-spacing:1px; margin:20px 0 8px; color:var(--ink) }
  p.sub { color:var(--mid); margin-top:4px }
  .win { background:var(--panel); border:2px solid var(--ink); box-shadow:4px 4px 0 var(--ink); margin-bottom:16px }
  .win > .head { background:var(--ink); color:var(--light); padding:3px 8px; letter-spacing:1px; display:flex; justify-content:space-between }
  .win > .head .sub { color:var(--mid) }
  .win > .body { padding:10px }
  .cards { display:grid; grid-template-columns:repeat(5,1fr); gap:5px; max-width:520px }
  .card { background:var(--light); border:2px solid var(--ink); padding:3px 4px 4px }
  .card b { display:block; font-size:24px; line-height:24px; font-weight:normal }
  .card span { color:var(--mid) }
  .card.g b { color:var(--green) } .card.w b { color:var(--gold) }
  table { width:100%; border-collapse:collapse; background:var(--light); border:2px solid var(--ink) }
  th,td { text-align:left; padding:3px 8px; border-bottom:2px solid var(--mid); font-size:12px; vertical-align:top }
  th { color:var(--ink); font-weight:normal; letter-spacing:1px; background:#c9c4b4; white-space:nowrap }
  tr:last-child td { border-bottom:none }
  tbody tr:nth-child(even) { background:rgba(43,42,36,.04) }
  td.num { text-align:right; color:var(--mid); white-space:nowrap; width:1%; }
  a { color:var(--ink); text-decoration:none } a:hover { color:var(--magenta) }
  .tag { display:inline-block; border:2px solid var(--ink); background:var(--gold); padding:0 4px; line-height:16px }
  .tag.issue { background:var(--green); color:#fff } .tag.pull { background:var(--magenta); color:#fff }
  .tag.file, .tag.releases { background:var(--mid); color:#fff }
  code { background:var(--light); border:2px solid var(--ink); box-shadow:inset 2px 2px 0 var(--mid); padding:0 4px }
  .api code { display:inline-block; margin:2px 0 }
  .empty { color:var(--mid); padding:12px }
  .bar { background:var(--ink); color:var(--light); padding:6px 10px; letter-spacing:2px; display:flex; gap:10px; align-items:center }
  .bar .led { width:10px; height:10px; border:2px solid var(--light); background:var(--green) }
  .bar .u { color:var(--mid); letter-spacing:0; margin-left:auto }

  /* 掌机风滚动条 */
  ::-webkit-scrollbar { width:20px; height:20px }
  ::-webkit-scrollbar-track {
    background-color:var(--shell);
    background-image:repeating-conic-gradient(rgba(43,42,36,.12) 0 25%, transparent 0 50%);
    background-size:4px 4px;
    border-left:2px solid var(--ink); border-top:2px solid var(--ink);
  }
  ::-webkit-scrollbar-thumb {
    background-color:var(--mid);
    background-image:repeating-linear-gradient(180deg, transparent 0 4px, rgba(43,42,36,.32) 4px 6px);
    border:2px solid var(--ink);
    box-shadow:inset 2px 2px 0 rgba(239,236,220,.4), inset -2px -2px 0 rgba(43,42,36,.28);
  }
  ::-webkit-scrollbar-thumb:hover { background-color:#9d9988 }
  ::-webkit-scrollbar-thumb:active {
    background-color:var(--green);
    background-image:repeating-linear-gradient(180deg, transparent 0 4px, rgba(239,236,220,.35) 4px 6px);
  }
  ::-webkit-scrollbar-button:single-button {
    display:block; width:20px; height:20px;
    background-color:var(--light); border:2px solid var(--ink);
    box-shadow:inset 2px 2px 0 rgba(255,255,255,.55);
    background-repeat:no-repeat; background-position:center;
  }
  ::-webkit-scrollbar-button:single-button:hover { background-color:#fff }
  ::-webkit-scrollbar-button:single-button:active { background-color:var(--gold) }
  ::-webkit-scrollbar-button:single-button:vertical:decrement {
    background-image:var(--arrow);
    background-size:1px 2px, 3px 2px, 5px 2px, 7px 2px;
    background-position:center calc(50% - 4px), center calc(50% - 2px), center 50%, center calc(50% + 2px);
  }
  ::-webkit-scrollbar-button:single-button:vertical:increment {
    background-image:var(--arrow);
    background-size:7px 2px, 5px 2px, 3px 2px, 1px 2px;
    background-position:center calc(50% - 4px), center calc(50% - 2px), center 50%, center calc(50% + 2px);
  }
  ::-webkit-scrollbar-button:single-button:horizontal:decrement {
    background-image:var(--arrow);
    background-size:2px 7px, 2px 5px, 2px 3px, 2px 1px;
    background-position:calc(50% - 4px) center, calc(50% - 2px) center, 50% center, calc(50% + 2px) center;
  }
  ::-webkit-scrollbar-button:single-button:horizontal:increment {
    background-image:var(--arrow);
    background-size:2px 1px, 2px 3px, 2px 5px, 2px 7px;
    background-position:calc(50% - 4px) center, calc(50% - 2px) center, 50% center, calc(50% + 2px) center;
  }
  ::-webkit-scrollbar-button:double-button { display:none }
  ::-webkit-scrollbar-corner {
    background-color:var(--shell);
    background-image:repeating-conic-gradient(rgba(43,42,36,.12) 0 25%, transparent 0 50%);
    background-size:4px 4px;
  }
  /* Firefox 回退：必须用 -moz-appearance 限定，Chromium 121+ 声明 scrollbar-color 会
     整体接管滚动条并丢弃所有 ::-webkit-scrollbar-* 样式 */
  @supports (-moz-appearance: none) {
    * { scrollbar-color:var(--mid) var(--shell); scrollbar-width:thin }
  }
</style></head><body>
<div class="bar"><span class="led"></span><span>GITHUB TAB COLLECTOR</span><span class="u">RELAY · ${escapeHtml(HOST)}:${boundPort}</span></div>

<p class="sub" style="margin-bottom:14px">最后接收：${escapeHtml(state.receivedAt || '尚未收到快照')} · 原因：${escapeHtml(state.reason || '-')} · 模式：拉取（Agent 查询时才采集）</p>

<div class="cards">
  <div class="card g"><b>${s.counts.repos || 0}</b><span>仓库</span></div>
  <div class="card"><b>${s.counts.githubTabs || 0}</b><span>GH页</span></div>
  <div class="card g"><b>${s.counts.issues || 0}</b><span>ISSUE</span></div>
  <div class="card g"><b>${s.counts.pulls || 0}</b><span>PR</span></div>
  <div class="card w"><b>${s.counts.totalTabs || 0}</b><span>全部页</span></div>
</div>

<div class="win" style="margin-top:14px">
  <div class="head"><span>仓库 LIST</span><span class="sub">${(s.repos || []).length} · 按打开时间</span></div>
  <div class="body">
  ${(s.repos || []).length ? `<table><thead><tr><th>打开时间</th><th>仓库</th><th>标签页标题</th><th style="text-align:right">标签数</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">尚未收到任何仓库链接。</div>'}
  </div>
</div>

<div class="win">
  <div class="head"><span>其他 GitHub 链接</span><span class="sub">${(s.items || []).filter((i) => i.type !== 'repo').length}</span></div>
  <div class="body">
  ${others ? `<table><thead><tr><th>类型</th><th>打开时间</th><th>链接</th><th>标签页标题</th></tr></thead><tbody>${others}</tbody></table>` : '<div class="empty">无</div>'}
  </div>
</div>

<div class="win">
  <div class="head"><span>AGENT 接口</span><span class="sub">API</span></div>
  <div class="body api">
    <div><code>GET /links?refresh=1</code> 拉取最新（通知扩展重新采集）</div>
    <div><code>GET /links</code> 取上次快照，立即返回</div>
    <div><code>GET /links.md</code> Markdown</div>
    <div><code>GET /repos</code> 只要 owner/repo 列表</div>
    <div><code>GET /health</code> 状态</div>
    <div style="margin-top:6px;color:var(--mid)">需要令牌时追加 <code>?token=…</code>，或用 <code>Authorization: Bearer …</code> 头。</div>
  </div>
</div>
</body></html>`;
}

/* ------------------------------------------------------------------ */
/* 请求处理                                                            */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname.replace(/\/+$/, '') || '/';

  res.on('finish', () => {
    const origin = req.headers.origin || '-';
    process.stdout.write(
      `  ${new Date().toISOString()}  ${req.method} ${path} -> ${res.statusCode}  (origin: ${origin})\n`
    );
  });

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  // 一键配对：仅限浏览器扩展
  if (req.method === 'GET' && route === '/pair-token') {
    if (!isExtensionOrigin(req)) {
      process.stdout.write(
        `  pair-token 拒绝, headers: ${JSON.stringify({
          origin: req.headers.origin || null,
          'sec-fetch-site': req.headers['sec-fetch-site'] || null,
          'user-agent': (req.headers['user-agent'] || '').slice(0, 40)
        })}\n`
      );
      sendJson(res, 403, { ok: false, error: 'extension-origin-required' });
      return;
    }
    sendJson(res, 200, { ok: true, token: TOKEN, serverUrl: `http://${HOST}:${PORT}` });
    return;
  }

  if (req.method === 'POST' && route === '/ingest') {
    if (!authorized(req)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw);
      const snapshot = body.snapshot || body;
      if (!snapshot || !Array.isArray(snapshot.items)) {
        sendJson(res, 400, { ok: false, error: 'invalid-payload' });
        return;
      }
      state.snapshot = snapshot;
      state.receivedAt = body.sentAt || new Date().toISOString();
      state.reason = body.reason || 'unknown';
      state.hits += 1;
      persist();
      resolveWaiters();
      sendJson(res, 200, {
        ok: true,
        received: snapshot.items.length,
        repos: (snapshot.repos || []).length,
        receivedAt: state.receivedAt
      });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: String(e.message || e) });
    }
    return;
  }

  if (req.method === 'GET' && route === '/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'github-tab-collector-relay',
      mode: 'pull',
      receivedAt: state.receivedAt,
      repos: (state.snapshot.repos || []).length,
      items: (state.snapshot.items || []).length,
      hits: state.hits,
      refreshRequested: state.refreshRequested,
      pollWaitMs: POLL_WAIT_MS,
      refreshWaitMs: REFRESH_WAIT_MS,
      files: { json: JSON_FILE, markdown: MD_FILE }
    });
    return;
  }

  /**
   * 长轮询：扩展在这里挂起等待。
   * agent 请求刷新时，中继返回 {action:'collect'}，扩展立刻采集并回传。
   */
  if (req.method === 'GET' && route === '/poll') {
    if (!authorized(req)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const deadline = Date.now() + POLL_WAIT_MS;
    while (!state.refreshRequested && Date.now() < deadline) {
      await sleep(400);
    }
    const action = state.refreshRequested ? 'collect' : 'idle';
    state.refreshRequested = false;
    sendJson(res, 200, { ok: true, action, serverTime: new Date().toISOString() });
    return;
  }

  if (req.method === 'GET' && (route === '/links' || route === '/links.json')) {
    if (!authorized(req)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }

    let refreshed = false;
    let waitedMs = 0;
    if (url.searchParams.get('refresh') === '1') {
      const started = Date.now();
      requestRefresh();
      refreshed = await waitForSnapshot(REFRESH_WAIT_MS);
      waitedMs = Date.now() - started;
    }

    sendJson(res, 200, {
      receivedAt: state.receivedAt,
      reason: state.reason,
      refreshed: refreshed,
      waitedMs: waitedMs,
      stale: !refreshed && url.searchParams.get('refresh') === '1',
      counts: state.snapshot.counts,
      repos: state.snapshot.repos,
      items: state.snapshot.items
    });
    return;
  }

  if (req.method === 'GET' && (route === '/links.md' || route === '/links.txt')) {
    if (!authorized(req)) {
      sendText(res, 401, 'unauthorized');
      return;
    }
    sendText(res, 200, toMarkdown(state.snapshot));
    return;
  }

  if (req.method === 'GET' && route === '/repos') {
    if (!authorized(req)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const only = url.searchParams.get('q');
    const list = (state.snapshot.repos || [])
      .filter((r) => !only || r.fullName.toLowerCase().includes(only.toLowerCase()))
      .map((r) => r.fullName);
    sendJson(res, 200, { count: list.length, repos: list });
    return;
  }

  // 面板用到的像素字体（与扩展同一套文件）
  if (req.method === 'GET' && route.startsWith('/fonts/')) {
    const name = route.slice('/fonts/'.length);
    const file = path.join(ROOT, 'extension', 'fonts', basename(name));
    fs.readFile(file, (err, data) => {
      if (err) {
        sendText(res, 404, 'not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'font/woff2',
        'Content-Length': data.length,
        'Cache-Control': 'public, max-age=86400'
      });
      res.end(data);
    });
    return;
  }

  if (req.method === 'GET' && route === '/') {
    sendText(res, 200, dashboardHtml(), 'text/html; charset=utf-8');
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not-found' });
});

server.listen(PORT, HOST, () => {
  const actualPort = server.address().port;
  boundPort = actualPort;
  try {
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  } catch {
    /* ignore */
  }
  const banner = [
    '',
    '  GitHub Tab Collector · 中继服务已启动',
    `  监听      http://${HOST}:${actualPort}`,
    `  面板      http://${HOST}:${actualPort}/`,
    `  JSON      http://${HOST}:${actualPort}/links`,
    `  Markdown  http://${HOST}:${actualPort}/links.md`,
    `  数据文件  ${JSON_FILE}`,
    `             ${MD_FILE}`,
    `  令牌      ${TOKEN ? TOKEN + '  (也写在 ' + TOKEN_FILE + ')' : '(未启用鉴权)'}`,
    '',
    '  在扩展设置里填入同样的地址与令牌即可。Ctrl+C 退出。',
    ''
  ].join('\n');
  process.stdout.write(banner);
});

process.on('SIGINT', () => {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    /* ignore */
  }
  process.stdout.write('\n已停止。\n');
  process.exit(0);
});
