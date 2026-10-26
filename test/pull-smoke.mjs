#!/usr/bin/env node
/**
 * 拉取模式端到端测试：
 *   模拟一个扩展（长轮询 /poll，收到 collect 就回传快照）
 *   模拟一个 agent（GET /links?refresh=1）
 * 验证：agent 主动查询 → 中继通知扩展 → 扩展回传 → agent 拿到新数据
 *
 * 用法： node test/pull-smoke.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestRelay } from './helpers/relay.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const relay = await startTestRelay();
const BASE = relay.base;
const AUTH = relay.auth;

console.log('\n[1] 中继可用');
const health = await (await fetch(BASE + '/health')).json();
check('健康检查 ok', health.ok, true);
check('处于拉取模式', health.mode, 'pull');

/* ------------------------------------------------------------------ */
/* 模拟扩展：长轮询 + 回传                                            */
/* ------------------------------------------------------------------ */

const fakeSnapshot = {
  generatedAt: new Date().toISOString(),
  source: 'github-tab-collector',
  counts: { githubTabs: 2, repos: 2, issues: 0, pulls: 0, gists: 0, other: 0, totalTabs: 5 },
  repos: [
    { fullName: 'acme/alpha', owner: 'acme', repo: 'alpha', url: 'https://github.com/acme/alpha', titles: ['Alpha'], tabCount: 1, open: true },
    { fullName: 'acme/beta', owner: 'acme', repo: 'beta', url: 'https://github.com/acme/beta', titles: ['Beta'], tabCount: 1, open: true }
  ],
  items: []
};

let stopped = false;
let pollsServed = 0;

async function fakeExtension() {
  while (!stopped) {
    try {
      const res = await fetch(BASE + '/poll', { headers: AUTH });
      const body = await res.json();
      pollsServed++;
      if (body.action === 'collect') {
        await fetch(BASE + '/ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: JSON.stringify({ sentAt: new Date().toISOString(), reason: 'pull', snapshot: fakeSnapshot })
        });
      }
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

const ext = fakeExtension();
await new Promise((r) => setTimeout(r, 600)); // 让模拟扩展挂上长轮询

console.log('\n[2] agent 主动查询');
const t0 = Date.now();
const res = await fetch(BASE + '/links?refresh=1', { headers: AUTH });
const body = await res.json();
const elapsed = Date.now() - t0;

check('返回 200', res.status, 200);
check('refreshed 为 true', body.refreshed, true);
check('stale 为 false', body.stale, false);
check('拿到新快照的仓库', body.repos.map((r) => r.fullName), ['acme/alpha', 'acme/beta']);
check('等待时间在合理范围', elapsed >= 5 && elapsed < 5000, true);
check('中继记录了拉取次数', body.counts.repos, 2);

console.log('\n[3] 不带 refresh 的查询立即返回');
const t1 = Date.now();
const res2 = await fetch(BASE + '/links', { headers: AUTH });
const body2 = await res2.json();
const elapsed2 = Date.now() - t1;
check('立即返回', elapsed2 < 1500, true);
check('复用同一份快照', body2.repos.map((r) => r.fullName), ['acme/alpha', 'acme/beta']);
check('未标记 refreshed', body2.refreshed, false);

console.log('\n[4] 未鉴权被拒绝');
const res3 = await fetch(BASE + '/links', { headers: { Authorization: 'Bearer wrong-token' } });
check('错误令牌返回 401', res3.status, 401);

console.log('\n[5] /poll 是长轮询');
const t2 = Date.now();
const poll = await fetch(BASE + '/poll', { headers: AUTH });
const pollBody = await poll.json();
const elapsed3 = Date.now() - t2;
check('无请求时返回 idle', pollBody.action, 'idle');
check('挂起了一段时间再返回', elapsed3 > 1000, true);

stopped = true;
relay.stop();
console.log(`\n结果：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed ? 1 : 0);
