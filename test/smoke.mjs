#!/usr/bin/env node
/**
 * 冒烟测试：
 *  1. GitHub URL 解析与快照组装
 *  2. 中继服务（若已启动）：/ingest 写入 -> /links、/links.md、/repos、/health 读取
 *
 * 用法： node test/smoke.mjs
 */

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestRelay } from './helpers/relay.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

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

/* ------------------------------------------------------------------ */
/* 1. 加载扩展解析模块                                                 */
/* ------------------------------------------------------------------ */

const sandbox = { self: {}, URL, Date, JSON, RegExp, Array, Object, String };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'extension/lib/github.js'), 'utf8'), sandbox);
const G = sandbox.self.GitHubTabs;

/* lib/opentime.js 的替身：只实现 github.js 真正用到的那部分契约 */
sandbox.self.OpenTime = {
  lookup(state, tab) {
    const rec = state && state.tabs && tab ? state.tabs[String(tab.id)] : null;
    if (rec) {
      return {
        openedAt: rec.pageAt ?? rec.tabAt ?? null,
        openedAtSource: 'tracked',
        tabOpenedAt: rec.tabAt ?? null
      };
    }
    if (state && typeof state.bootAt === 'number') {
      return { openedAt: state.bootAt, openedAtSource: 'session-start', tabOpenedAt: state.bootAt };
    }
    return { openedAt: null, openedAtSource: 'unknown', tabOpenedAt: null };
  }
};

console.log('\n[1] URL 解析');

check('仓库页', G.parse('https://github.com/microsoft/PowerToys').type, 'repo');
check('仓库页 owner/repo', G.parse('https://github.com/microsoft/PowerToys').fullName ?? G.parse('https://github.com/microsoft/PowerToys').owner + '/' + G.parse('https://github.com/microsoft/PowerToys').repo, 'microsoft/PowerToys');
check('仓库带尾斜杠', G.parse('https://github.com/microsoft/PowerToys/').url, 'https://github.com/microsoft/PowerToys');
check('仓库子路径保留 file 类型', G.parse('https://github.com/microsoft/PowerToys/tree/main/src').type, 'file');
check('file 类型 URL 无双斜杠', G.parse('https://github.com/tarwin/tinyjsapp/blob/main/CHANGELOG.md').url, 'https://github.com/tarwin/tinyjsapp/blob/main/CHANGELOG.md');
check('顶层页面 URL 无双斜杠', G.parse('https://github.com/settings/profile').url, 'https://github.com/settings/profile');
check('文件页', G.parse('https://github.com/microsoft/PowerToys/blob/main/README.md').type, 'file');
check('Issue', G.parse('https://github.com/microsoft/PowerToys/issues/123').type, 'issue');
check('Issue 编号', G.parse('https://github.com/microsoft/PowerToys/issues/123').number, 123);
check('PR', G.parse('https://github.com/microsoft/PowerToys/pull/456').type, 'pull');
check('PR 编号', G.parse('https://github.com/microsoft/PowerToys/pull/456').number, 456);
check('Discussion', G.parse('https://github.com/o/r/discussions/7').type, 'discussion');
check('Wiki', G.parse('https://github.com/o/r/wiki').type, 'wiki');
check('Projects', G.parse('https://github.com/o/r/projects/1').type, 'project');
check('Releases', G.parse('https://github.com/o/r/releases').type, 'releases');
check('Actions', G.parse('https://github.com/o/r/actions').type, 'actions');
check('Gist', G.parse('https://gist.github.com/user/abc123').type, 'gist');
check('首页是噪音', G.parse('https://github.com/').type, 'home');
check('设置页是噪音', G.parse('https://github.com/settings/profile').type, 'settings');
check('组织主页', G.parse('https://github.com/microsoft').type, 'org');
check('非 GitHub 域名', G.parse('https://example.com/foo/bar'), null);
check('非 http 协议', G.parse('chrome://extensions'), null);

console.log('\n[2] 快照组装');

const fakeTabs = [
  { id: 1, url: 'https://github.com/microsoft/PowerToys', title: 'PowerToys', windowId: 1 },
  { id: 2, url: 'https://github.com/microsoft/PowerToys', title: 'PowerToys 副本', windowId: 1 },
  { id: 3, url: 'https://github.com/microsoft/PowerToys/issues/42', title: 'Issue #42', windowId: 2 },
  { id: 4, url: 'https://github.com/nano-muse/nanoMuse', title: 'nanoMuse', windowId: 2 },
  { id: 5, url: 'https://github.com/', title: 'GitHub', windowId: 2 },
  { id: 6, url: 'https://github.com/settings/profile', title: 'Settings', windowId: 2 },
  { id: 7, url: 'https://example.com', title: '别的站', windowId: 3 },
  { id: 8, url: 'https://github.com/microsoft/PowerToys/pull/99', title: 'PR #99', windowId: 3, incognito: true }
];

const snap = G.buildSnapshot(fakeTabs, { includeNonProject: false });
check('仓库数', snap.counts.repos, 2);
check('GitHub 标签页数', snap.counts.githubTabs, 4);
check('Issue 数', snap.counts.issues, 1);
check('PR 数', snap.counts.pulls, 1);
check('同仓库多标签合并', snap.repos.find((r) => r.fullName === 'microsoft/PowerToys').tabCount, 4);
check('仓库排序', snap.repos.map((r) => r.fullName), ['microsoft/PowerToys', 'nano-muse/nanoMuse']);
check('首页被排除', snap.items.some((i) => i.url === 'https://github.com/'), false);
check('设置页被排除', snap.items.some((i) => i.type === 'settings'), false);

// 只打开了仓库内的文件页，也应识别出仓库
const fileOnly = G.buildSnapshot(
  [{ id: 9, url: 'https://github.com/vuejs/core/blob/main/README.md', title: 'README', windowId: 1 }],
  { includeNonProject: false }
);
check('仅文件页也能识别仓库', fileOnly.repos.map((r) => r.fullName), ['vuejs/core']);
check('仅文件页时仓库 URL 规范化', fileOnly.repos[0].url, 'https://github.com/vuejs/core');

// 关闭 includeIssues 后，Issue/PR 及其贡献的仓库都不再出现
const noIssues = G.buildSnapshot(fakeTabs, { includeNonProject: false, includeIssues: false });
check('关闭 Issue/PR 后标签页数', noIssues.counts.githubTabs, 2);
check('关闭 Issue/PR 后仓库数', noIssues.counts.repos, 2);
check('关闭 Issue/PR 后无 issue 条目', noIssues.items.some((i) => i.type === 'issue' || i.type === 'pull'), false);

const md = G.toMarkdown(snap);
check('Markdown 含仓库', md.includes('microsoft/PowerToys'), true);
check('Markdown 含 PR', md.includes('#99'), true);

/* ------------------------------------------------------------------ */
/* 3. 打开时间追踪与排序                                               */
/* ------------------------------------------------------------------ */

console.log('\n[3] 打开时间追踪与排序');

const openState = {
  sessionStamp: 's-test',
  bootAt: 1699999999000,
  tabs: {
    '1': { tabAt: 1700000600000, pageAt: 1700000600000 },
    '2': { tabAt: 1700000700000, pageAt: 1700000700000 },
    '3': { tabAt: 1700000300000, pageAt: 1700000300000 },
    '4': { tabAt: 1700000100000, pageAt: 1700000100000 },
    '8': { tabAt: 1700000200000, pageAt: 1700000200000 }
  }
};

const timedTabs = [
  { id: 1, url: 'https://github.com/microsoft/PowerToys', title: 'PowerToys', windowId: 1, index: 0 },
  { id: 2, url: 'https://github.com/microsoft/PowerToys', title: 'PowerToys 副本', windowId: 1, index: 1 },
  { id: 3, url: 'https://github.com/microsoft/PowerToys/issues/42', title: 'Issue #42', windowId: 2, index: 0 },
  { id: 4, url: 'https://github.com/nano-muse/nanoMuse', title: 'nanoMuse', windowId: 2, index: 1 },
  { id: 8, url: 'https://github.com/microsoft/PowerToys/pull/99', title: 'PR #99', windowId: 3, index: 0 }
];

const timed = G.buildSnapshot(timedTabs, { includeNonProject: false, openState });

check('快照声明排序方式', timed.sortBy, 'openedAt-asc');
check('条目带 openedAtMs', timed.items.find((i) => i.tabId === 4).openedAtMs, 1700000100000);
check('条目带 ISO 打开时间', timed.items.find((i) => i.tabId === 4).openedAt, new Date(1700000100000).toISOString());
check('打开来源标记为 tracked', timed.items.find((i) => i.tabId === 4).openedAtSource, 'tracked');
check('仓库按打开时间升序', timed.repos.map((r) => r.fullName), ['nano-muse/nanoMuse', 'microsoft/PowerToys']);
check('仓库取名下最早的打开时间', timed.repos.find((r) => r.fullName === 'microsoft/PowerToys').openedAtMs, 1700000200000);
check('条目也按打开时间排序', timed.items.map((i) => i.openedAtMs), [1700000100000, 1700000200000, 1700000300000, 1700000600000]);
check('同一 URL 的多个标签页取最早', timed.items.find((i) => i.url === 'https://github.com/microsoft/PowerToys').openedAtMs, 1700000600000);

// 同一时刻打开的：按窗口内位置（index）排
const tieSnap = G.buildSnapshot(
  [
    { id: 11, url: 'https://github.com/zeta/one', title: 'Z', windowId: 1, index: 3 },
    { id: 12, url: 'https://github.com/alpha/two', title: 'A', windowId: 1, index: 1 }
  ],
  {
    includeNonProject: false,
    openState: {
      sessionStamp: 's',
      bootAt: 1000,
      tabs: { '11': { tabAt: 5000, pageAt: 5000 }, '12': { tabAt: 5000, pageAt: 5000 } }
    }
  }
);
check('同一时刻按窗口位置排序', tieSnap.repos.map((r) => r.fullName), ['alpha/two', 'zeta/one']);

// 完全没有时间的排最后
const mixedSnap = G.buildSnapshot(
  [
    { id: 31, url: 'https://github.com/zzz/late', title: 'Z', windowId: 1, index: 0 },
    { id: 32, url: 'https://github.com/aaa/unknown', title: 'A', windowId: 1, index: 1 }
  ],
  { includeNonProject: false, openState: { sessionStamp: 's', tabs: { '31': { tabAt: 9000, pageAt: 9000 } } } }
);
check('未知的打开时间排最后', mixedSnap.repos.map((r) => r.fullName), ['zzz/late', 'aaa/unknown']);
check('未知来源标记为 unknown', mixedSnap.repos.find((r) => r.fullName === 'aaa/unknown').openedAtSource, 'unknown');

// 会话开始之前就存在的标签页：只能记到会话开始时刻，标记为估算
const sessionSnap = G.buildSnapshot(
  [{ id: 41, url: 'https://github.com/x/y', title: 'XY', windowId: 1, index: 0 }],
  { includeNonProject: false, openState: { sessionStamp: 's', bootAt: 4000 } }
);
check('会话前标签页标记为估算', sessionSnap.repos[0].openedAtSource, 'session-start');
check('会话前标签页用 bootAt 兜底', sessionSnap.repos[0].openedAtMs, 4000);

const timedMd = G.toMarkdown(timed);
check('Markdown 含打开时间', timedMd.includes('打开于：'), true);
check('Markdown 声明排序方式', timedMd.includes('按标签页打开时间从早到晚'), true);
check('Markdown 标注估算时间', G.toMarkdown(sessionSnap).includes('时间为估算'), true);

/* ------------------------------------------------------------------ */
/* 4. 中继服务                                                          */
/* ------------------------------------------------------------------ */

console.log('\n[4] 中继服务（隔离实例，不影响你正在跑的中继）');

const relay = await startTestRelay();
try {
  const health = await fetch(relay.base + '/health');
  check('/health 可达', health.ok, true);
  check('处于拉取模式', (await health.json()).mode, 'pull');

  const ingest = await relay.seed(snap, 'smoke');
  check('/ingest 接受快照', ingest.ok, true);
  check('/ingest 回显仓库数', ingest.repos, 2);

  const links = await (await fetch(relay.base + '/links', { headers: relay.auth })).json();
  check('/links 仓库数', links.repos.length, 2);
  check('/links 首个仓库', links.repos[0].fullName, 'microsoft/PowerToys');

  const mdRes = await fetch(relay.base + '/links.md', { headers: relay.auth });
  const mdText = await mdRes.text();
  check('/links.md 含仓库', mdText.includes('nano-muse/nanoMuse'), true);

  const repos = await (await fetch(relay.base + '/repos?q=nano', { headers: relay.auth })).json();
  check('/repos 过滤', repos.repos, ['nano-muse/nanoMuse']);

  const fileJson = JSON.parse(fs.readFileSync(path.join(relay.dataDir, 'github-tabs.json'), 'utf8'));
  check('落盘 JSON 有快照', Array.isArray(fileJson.snapshot.items), true);
  check('落盘 Markdown 存在', fs.existsSync(path.join(relay.dataDir, 'github-links.md')), true);

  const fontRoute = await fetch(relay.base + '/fonts/fusion-pixel-12px-latin.woff2');
  check('面板字体路由可用', fontRoute.ok, true);
} catch (e) {
  failed++;
  console.log(`  ! 中继测试失败：${e.message}`);
} finally {
  relay.stop();
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed ? 1 : 0);
