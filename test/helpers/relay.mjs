/**
 * 测试辅助：启动一个隔离的中继实例（独立端口、独立数据目录、独立令牌）。
 *
 * 这样测试既不会污染用户正在运行的中继，也不会和真实浏览器扩展抢响应。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

export const TEST_TOKEN = 'test-token-0123456789abcdef';

export async function startTestRelay(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtc-test-'));

  const child = spawn(process.execPath, [path.join(ROOT, 'relay/server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      RELAY_TOKEN: TEST_TOKEN,
      POLL_WAIT_MS: String(opts.pollWaitMs || 3000),
      REFRESH_WAIT_MS: String(opts.refreshWaitMs || 3000)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('中继启动超时')), 15000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      const m = /监听\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => process.stderr.write('[relay] ' + c));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('中继退出 code=' + code));
    });
  });

  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: 'Bearer ' + TEST_TOKEN };

  // 等服务真正可用
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(base + '/health');
      if (res.ok) break;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    base,
    auth,
    port,
    dataDir,
    async seed(snapshot, reason = 'test') {
      const res = await fetch(base + '/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ sentAt: new Date().toISOString(), reason, snapshot })
      });
      return res.json();
    },
    stop() {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  };
}
