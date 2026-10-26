#!/usr/bin/env node
/**
 * MCP stdio 冒烟测试：用几行 JSON-RPC 驱动 mcp/github-links-mcp.mjs
 * 用法： node test/mcp-smoke.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestRelay, TEST_TOKEN } from './helpers/relay.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MCP = path.join(ROOT, 'mcp/github-links-mcp.mjs');

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`);
  }
}

/* 隔离的中继实例：不会被真实浏览器扩展抢响应，也不污染用户的数据 */
const relay = await startTestRelay({ refreshWaitMs: 200 });

const seedSnapshot = {
  generatedAt: new Date().toISOString(),
  source: 'github-tab-collector',
  counts: { githubTabs: 3, repos: 2, issues: 1, pulls: 0, gists: 0, other: 1, totalTabs: 5 },
  repos: [
    { fullName: 'microsoft/PowerToys', owner: 'microsoft', repo: 'PowerToys', url: 'https://github.com/microsoft/PowerToys', titles: ['PowerToys'], tabCount: 1, open: true },
    { fullName: 'nano-muse/nanoMuse', owner: 'nano-muse', repo: 'nanoMuse', url: 'https://github.com/nano-muse/nanoMuse', titles: ['nanoMuse'], tabCount: 1, open: true }
  ],
  items: [
    { type: 'repo', url: 'https://github.com/microsoft/PowerToys', owner: 'microsoft', repo: 'PowerToys', fullName: 'microsoft/PowerToys', titles: ['PowerToys'], tabCount: 1 },
    { type: 'repo', url: 'https://github.com/nano-muse/nanoMuse', owner: 'nano-muse', repo: 'nanoMuse', fullName: 'nano-muse/nanoMuse', titles: ['nanoMuse'], tabCount: 1 },
    { type: 'issue', url: 'https://github.com/microsoft/PowerToys/issues/42', number: 42, titles: ['Issue #42'], tabCount: 1 }
  ]
};
await relay.seed(seedSnapshot, 'mcp-smoke');

const child = spawn(process.execPath, [MCP], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    GITHUB_LINKS_URL: relay.base + '/links',
    GITHUB_LINKS_TOKEN: TEST_TOKEN
  }
});

let buffer = '';
const responses = new Map();
let nextId = 1;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) responses.set(msg.id, msg);
    } catch {
      /* ignore */
    }
  }
});
child.stderr.on('data', (c) => process.stderr.write('[mcp stderr] ' + c));

function send(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method, params };
  child.stdin.write(JSON.stringify(msg) + '\n');
  return id;
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

async function waitFor(id, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (responses.has(id)) return responses.get(id);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timeout waiting for response id=' + id);
}

console.log('\n[MCP] 协议握手');

const initId = send('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '1.0.0' }
});
const initRes = await waitFor(initId);
check('initialize 返回 protocolVersion', initRes.result?.protocolVersion, '2024-11-05');
check('initialize 声明 tools 能力', !!initRes.result?.capabilities?.tools, true);
check('serverInfo.name', initRes.result?.serverInfo?.name, 'github-tab-collector');

notify('notifications/initialized', {});

console.log('\n[MCP] 工具列表');

const listId = send('tools/list', {});
const listRes = await waitFor(listId);
const toolNames = (listRes.result?.tools || []).map((t) => t.name).sort();
check('暴露 3 个工具', toolNames, ['get_github_snapshot', 'list_github_repos', 'search_github_links']);
check('工具带 inputSchema', (listRes.result?.tools || []).every((t) => !!t.inputSchema), true);

console.log('\n[MCP] 工具调用');

const reposId = send('tools/call', { name: 'list_github_repos', arguments: {} });
const reposRes = await waitFor(reposId);
const reposText = reposRes.result?.content?.[0]?.text || '';
check('list_github_repos 返回文本', typeof reposText === 'string' && reposText.length > 0, true);
check('list_github_repos 含仓库名', reposText.includes('microsoft/PowerToys'), true);

const filteredId = send('tools/call', { name: 'list_github_repos', arguments: { q: 'nano-muse' } });
const filteredRes = await waitFor(filteredId);
const filteredText = filteredRes.result?.content?.[0]?.text || '';
check('list_github_repos 支持过滤', filteredText.includes('nano-muse/nanoMuse'), true);
check('过滤后不含其他仓库', filteredText.includes('microsoft/PowerToys'), false);

const searchId = send('tools/call', { name: 'search_github_links', arguments: { query: 'issues' } });
const searchRes = await waitFor(searchId);
const searchText = searchRes.result?.content?.[0]?.text || '';
check('search_github_links 找到 issue 链接', searchText.includes('/issues/42'), true);

const snapId = send('tools/call', { name: 'get_github_snapshot', arguments: {} });
const snapRes = await waitFor(snapId);
const snapText = snapRes.result?.content?.[0]?.text || '';
check('get_github_snapshot 含统计', /仓库\s+\d/.test(snapText), true);

const badId = send('tools/call', { name: 'search_github_links', arguments: {} });
const badRes = await waitFor(badId);
check('缺参数返回 isError', badRes.result?.isError, true);

const unknownId = send('tools/call', { name: 'nope', arguments: {} });
const unknownRes = await waitFor(unknownId);
check('未知工具返回错误结果', unknownRes.result?.isError, true);

child.kill();
relay.stop();
console.log(`\n结果：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed ? 1 : 0);
