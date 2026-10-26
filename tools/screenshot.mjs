#!/usr/bin/env node
/**
 * 文档截图用的假中继：起一个隔离的中继实例，塞进虚构数据，
 * 然后一直挂着，方便用浏览器去截中继面板的图。
 *
 *   node tools/screenshot.mjs
 *   → http://127.0.0.1:<随机端口>/   （Ctrl+C 结束）
 *
 * 数据来自 docs/fixtures/demo-snapshot.json，仓库名全部是杜撰的，
 * 不会泄漏真实的浏览记录。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestRelay } from '../test/helpers/relay.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(ROOT, 'docs', 'fixtures', 'demo-snapshot.json');

function loadSnapshot() {
  const snap = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  for (const e of [].concat(snap.repos || [], snap.items || [])) {
    if (e.openedAtMs === undefined && e.openedAt) {
      const ms = Date.parse(e.openedAt);
      e.openedAtMs = Number.isNaN(ms) ? null : ms;
    }
  }
  return snap;
}

const relay = await startTestRelay();
await relay.seed(loadSnapshot(), 'docs-screenshot');

process.stdout.write(
  [
    '',
    '  假中继已启动（虚构数据，与你的真实标签页无关）',
    `  面板  ${relay.base}/`,
    '',
    '  Ctrl+C 结束。',
    ''
  ].join('\n')
);

process.on('SIGINT', () => {
  relay.stop();
  process.exit(0);
});
