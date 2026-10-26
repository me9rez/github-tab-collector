#!/usr/bin/env node
/**
 * GitHub Tab Collector — MCP stdio 服务（零依赖，Node >= 18）
 *
 * 把浏览器里打开的 GitHub 链接暴露成 MCP 工具，任何支持 MCP 的 Agent 都能直接调用，
 * 不再需要人工复制粘贴。
 *
 * 暴露的工具：
 *   list_github_repos      列出当前打开的仓库（可带关键字过滤）
 *   search_github_links    在所有 GitHub 链接里做子串搜索
 *   get_github_snapshot    返回统计信息与原始 JSON 路径
 *
 * 环境变量：
 *   GITHUB_LINKS_URL    中继地址，默认 http://127.0.0.1:8788/links
 *   GITHUB_LINKS_TOKEN  中继令牌（若启用）
 *   GITHUB_LINKS_FILE   本地快照文件（当中继不可用时的回退来源）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const URL_ENDPOINT = process.env.GITHUB_LINKS_URL || 'http://127.0.0.1:8788/links';
const TOKEN = process.env.GITHUB_LINKS_TOKEN || '';
const FILE = path.resolve(ROOT, process.env.GITHUB_LINKS_FILE || 'data/github-tabs.json');

const SERVER_INFO = { name: 'github-tab-collector', version: '1.0.0' };
const DEFAULT_PROTOCOL = '2024-11-05';

/* ------------------------------------------------------------------ */
/* 数据获取                                                            */
/* ------------------------------------------------------------------ */

function readLocalSnapshot() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && parsed.snapshot ? parsed.snapshot : parsed;
  } catch {
    return null;
  }
}

/**
 * 拉取模式：向中继要最新数据。
 * refresh=1 会让中继通知扩展去重新采集标签页，然后返回新快照；
 * 扩展没响应时中继会返回上一次快照并带上 stale 标记。
 */
async function fetchRemoteSnapshot(refresh) {
  const headers = {};
  if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
  const sep = URL_ENDPOINT.includes('?') ? '&' : '?';
  const url = refresh ? URL_ENDPOINT + sep + 'refresh=1' : URL_ENDPOINT;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), refresh ? 30000 : 5000);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const body = await res.json();
    return {
      generatedAt: body.receivedAt || body.generatedAt || null,
      counts: body.counts || {},
      repos: body.repos || [],
      items: body.items || [],
      refreshed: !!body.refreshed,
      stale: !!body.stale
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let cache = null;

async function getSnapshot(force) {
  if (cache && !force && Date.now() - cache.at < 3000) return cache.data;
  let data = await fetchRemoteSnapshot(true);
  let source = 'relay';
  if (!data) {
    data = readLocalSnapshot();
    source = 'file';
  }
  if (!data) {
    data = { generatedAt: null, counts: {}, repos: [], items: [] };
    source = 'empty';
  }
  cache = { at: Date.now(), data, source };
  return cache.data;
}

/* ------------------------------------------------------------------ */
/* 工具实现                                                            */
/* ------------------------------------------------------------------ */

function textResult(text, isError) {
  const out = { content: [{ type: 'text', text }] };
  if (isError) out.isError = true;
  return out;
}

/* ------------------------------------------------------------------ */
/* 打开时间                                                            */
/* ------------------------------------------------------------------ */

/** 打开时间格式化：2026-10-26 16:24 */
function fmtOpened(entry) {
  const ms = entry && entry.openedAtMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '未知';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '未知';
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  const approx = entry.openedAtSource === 'session-start' ? '≈' : '';
  return `${approx}${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 排序：最早打开的在前；同一时刻按窗口内位置；再相同按名字 */
function sortByOpenedAt(list) {
  return list.slice().sort((a, b) => {
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

async function toolListRepos(args) {
  const q = (args.q || '').toString().trim().toLowerCase();
  const snap = await getSnapshot(false);
  let repos = snap.repos || [];
  if (q) {
    repos = repos.filter(
      (r) =>
        (r.fullName || '').toLowerCase().includes(q) ||
        (r.url || '').toLowerCase().includes(q) ||
        (r.titles || []).some((t) => (t || '').toLowerCase().includes(q))
    );
  }
  if (!repos.length) {
    return textResult(
      q
        ? `没有匹配 "${q}" 的 GitHub 仓库标签页。\n\n当前共 ${(snap.repos || []).length} 个仓库标签页。`
        : '当前没有检测到打开的 GitHub 仓库标签页。'
    );
  }
  const lines = sortByOpenedAt(repos).map((r) => {
    const title = r.titles && r.titles.length ? `  // ${r.titles[0]}` : '';
    return `${fmtOpened(r)}  ${r.fullName}  ${r.url}${title}`;
  });
  const header =
    `共 ${repos.length} 个仓库标签页（按打开时间从早到晚；更新时间：${snap.generatedAt || '未知'}）\n`;
  return textResult(header + lines.join('\n') + '\n\nJSON:\n' + JSON.stringify(repos));
}

async function toolSearchLinks(args) {
  const query = (args.query || '').toString().trim().toLowerCase();
  const limit = Math.min(Number(args.limit) || 50, 500);
  if (!query) return textResult('缺少参数 query。', true);

  const snap = await getSnapshot(false);
  const hits = (snap.items || []).filter((it) => {
    const hay = [
      it.url,
      it.fullName,
      it.owner,
      it.repo,
      it.type,
      ...(it.titles || [])
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return hay.includes(query);
  });

  if (!hits.length) {
    return textResult(
      `没有匹配 "${query}" 的链接。\n\n当前共 ${(snap.items || []).length} 条 GitHub 标签页记录。`
    );
  }
  const shown = sortByOpenedAt(hits).slice(0, limit);
  const lines = shown.map((it) => {
    const label = it.type + (it.number ? ' #' + it.number : '');
    const title = it.titles && it.titles.length ? `  // ${it.titles[0]}` : '';
    return `${fmtOpened(it)}  [${label}] ${it.url}${title}`;
  });
  const more = hits.length > shown.length ? `\n… 另有 ${hits.length - shown.length} 条未显示` : '';
  return textResult(
    `匹配 "${query}" 的链接 ${hits.length} 条（按打开时间从早到晚）：\n` + lines.join('\n') + more
  );
}

async function toolSnapshot() {
  const snap = await getSnapshot(false);
  const c = snap.counts || {};
  const lines = [
    'GitHub Tab Collector 快照（拉取模式）',
    `更新时间      ${snap.generatedAt || '未知'}`,
    `仓库          ${c.repos ?? 0}`,
    `GitHub 标签页 ${c.githubTabs ?? 0}`,
    `Issue         ${c.issues ?? 0}`,
    `PR            ${c.pulls ?? 0}`,
    `Gist          ${c.gists ?? 0}`,
    `数据来源      ${cache.source}（中继 ${URL_ENDPOINT}）`,
    `排序          按标签页打开时间从早到晚`,
    snap.stale ? '状态          扩展未响应，返回的是上次快照' : '状态          已从扩展取到最新快照',
    `本地文件      ${FILE}`,
    '',
    '仓库列表：',
    ...sortByOpenedAt(snap.repos || []).map((r) => `  ${fmtOpened(r)}  ${r.fullName}  ${r.url}`)
  ];
  return textResult(lines.join('\n'));
}

const TOOLS = [
  {
    name: 'list_github_repos',
    description:
      '列出用户浏览器中当前打开的 GitHub 仓库标签页（owner/repo + URL + 页面标题 + 打开时间）。按标签页打开时间从早到晚排序。可选 q 做关键字过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '关键字，匹配仓库名、URL 或标签页标题；留空返回全部' }
      }
    }
  },
  {
    name: 'search_github_links',
    description:
      '在浏览器中打开的所有 GitHub 链接里做子串搜索，返回仓库 / Issue / PR / Gist 等链接、标题与打开时间。按打开时间从早到晚排序。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜索的关键词' },
        limit: { type: 'number', description: '最多返回条数，默认 50' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_github_snapshot',
    description: '返回浏览器 GitHub 标签页的统计快照、数据来源与本地文件路径。',
    inputSchema: { type: 'object', properties: {} }
  }
];

const HANDLERS = {
  list_github_repos: toolListRepos,
  search_github_links: toolSearchLinks,
  get_github_snapshot: toolSnapshot
};

/* ------------------------------------------------------------------ */
/* JSON-RPC over stdio                                                */
/* ------------------------------------------------------------------ */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO
      });
      return;

    case 'notifications/initialized':
    case 'initialized':
      return; // 通知，无需响应

    case 'ping':
      reply(id, {});
      return;

    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;

    case 'tools/call': {
      const name = params?.name;
      const fn = HANDLERS[name];
      if (!fn) {
        reply(id, textResult(`未知工具：${name}`, true));
        return;
      }
      try {
        const result = await fn(params?.arguments || {});
        reply(id, result);
      } catch (e) {
        reply(id, textResult(`工具执行失败：${String(e?.message || e)}`, true));
      }
      return;
    }

    case 'resources/list':
      reply(id, { resources: [] });
      return;

    case 'prompts/list':
      reply(id, { prompts: [] });
      return;

    default:
      if (id !== undefined && id !== null) {
        replyError(id, -32601, `Method not found: ${method}`);
      }
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    Promise.resolve(handle(msg)).catch((e) => {
      if (msg && msg.id !== undefined && msg.id !== null) {
        replyError(msg.id, -32603, String(e?.message || e));
      }
    });
  }
});

process.stdin.on('end', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
