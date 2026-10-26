/**
 * 预览垫片（仅在非扩展环境生效）
 *
 * 让 popup / options 页面可以直接用普通浏览器打开预览（开发用）：
 *  - 提供最小的 chrome.storage / chrome.runtime / chrome.tabs 模拟
 *  - 拦截 /links、/health、/pair-token 请求，返回示例数据
 *
 * 在真正的扩展环境里，本文件什么都不做。
 */
(function () {
  'use strict';

  var isExtension =
    typeof chrome !== 'undefined' &&
    chrome.storage &&
    chrome.runtime &&
    typeof chrome.runtime.getURL === 'function';

  if (isExtension) return;

  var KEY = '__gtc_preview_store__';

  var store = {};
  try {
    store = JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch (e) {
    store = {};
  }
  store.serverUrl = store.serverUrl || 'http://127.0.0.1:8788';
  store.token = store.token || 'preview-token';
  store.autoSync = store.autoSync !== false;
  store.heartbeatMinutes = store.heartbeatMinutes || 1;
  store.includeIssues = store.includeIssues !== false;
  store.includeOtherPages = !!store.includeOtherPages;
  store.excludePatterns = store.excludePatterns || '';
  store.includeIncognito = !!store.includeIncognito;

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(store));
    } catch (e) {
      /* ignore */
    }
  }

  window.chrome = {
    storage: {
      local: {
        get: function (keys, cb) {
          var out = {};
          if (keys === null || keys === undefined) {
            out = JSON.parse(JSON.stringify(store));
          } else if (typeof keys === 'string') {
            if (keys in store) out[keys] = store[keys];
          } else if (Array.isArray(keys)) {
            keys.forEach(function (k) {
              if (k in store) out[k] = store[k];
            });
          } else {
            Object.keys(keys).forEach(function (k) {
              out[k] = k in store ? store[k] : keys[k];
            });
          }
          if (cb) cb(out);
          return Promise.resolve(out);
        },
        set: function (items, cb) {
          Object.assign(store, items);
          persist();
          if (cb) cb();
          return Promise.resolve();
        }
      }
    },
    runtime: {
      getURL: function (p) {
        return p;
      },
      openOptionsPage: function () {},
      sendMessage: function (m, cb) {
        if (cb) cb({ ok: false, error: 'preview' });
      },
      onMessage: { addListener: function () {} }
    },
    tabs: {
      query: function (q, cb) {
        var r = [];
        if (cb) cb(r);
        return Promise.resolve(r);
      }
    }
  };

  /* ---------------- 示例数据 ---------------- */

  var MOCK_REPOS = [
    ['abcwyc/pi-agent-desktop', 'Releases · abcwyc/pi-agent-desktop'],
    ['Fei2411/DS-Bot', 'Releases · Fei2411/DS-Bot'],
    ['Justin-sky/ai-art-engine', 'AI 艺术创作引擎：短视频 / 游戏3D / 2D 资产'],
    ['nano-muse/nanoMuse', 'Releases · nano-muse/nanoMuse'],
    ['qybaihe/mu', 'mu (μ)：把 coding agent 的 yes/no 决策交给小模型'],
    ['saya-ch/dsh-mobile', 'DeepSeek Harness 的 Android App 与远程访问插件'],
    ['tarwin/tinyjsapp', 'tinyjsapp/CHANGELOG.md at main'],
    ['techflag/workdsh', 'WorkBuddy 风格桌面工作区，DSH 插件生态'],
    ['vercel-labs/agent-browser', 'Releases · vercel-labs/agent-browser'],
    ['vercel-labs/portless', 'Releases · vercel-labs/portless'],
    ['vercel-labs/scriptc', 'TypeScript-to-Native Compiler'],
    ['xerj-org/xerj', '本地优先搜索引擎 + MCP server（Rust 单文件）']
  ];

  /**
   * 演示模式：?demo=1
   * 读取 docs/fixtures/demo-snapshot.json（一份虚构数据），用于文档截图，
   * 避免 README 里出现真实的浏览记录。
   */
  var isDemo = /[?&]demo=1/.test(window.location.search);
  var nativeFetch = window.fetch.bind(window);
  var demoPromise = null;

  if (isDemo) {
    demoPromise = nativeFetch('/docs/fixtures/demo-snapshot.json', { cache: 'no-store' })
      .then(function (r) {
        return r.json();
      })
      .then(function (snap) {
        // JSON 里只存了 ISO 时间，这里补上 epoch 毫秒（排序用）
        [].concat(snap.repos || [], snap.items || []).forEach(function (e) {
          if (e.openedAtMs === undefined && e.openedAt) {
            var ms = Date.parse(e.openedAt);
            e.openedAtMs = isNaN(ms) ? null : ms;
          }
        });
        snap.receivedAt = snap.generatedAt;
        snap.refreshed = true;
        snap.stale = false;
        return snap;
      })
      .catch(function () {
        return null;
      });
  }

  function mockSnapshot() {
    // 模拟打开时间：从 3 小时前开始，每个仓库往后 11 分钟
    var base = Date.now() - 3 * 60 * 60 * 1000;
    var repos = MOCK_REPOS.map(function (r, i) {
      var ms = base + i * 11 * 60 * 1000;
      return {
        fullName: r[0],
        owner: r[0].split('/')[0],
        repo: r[0].split('/')[1],
        url: 'https://github.com/' + r[0],
        titles: [r[1]],
        tabCount: 1,
        open: true,
        openedAt: new Date(ms).toISOString(),
        openedAtMs: ms,
        openedAtSource: 'tracked',
        tabIndex: i
      };
    });
    return {
      receivedAt: new Date().toISOString(),
      refreshed: true,
      stale: false,
      sortBy: 'openedAt-asc',
      counts: {
        repos: repos.length,
        githubTabs: repos.length + 6,
        issues: 2,
        pulls: 1,
        gists: 0,
        other: 3,
        totalTabs: 21
      },
      repos: repos,
      items: repos
        .map(function (r) {
          return {
            type: 'repo',
            url: r.url,
            owner: r.owner,
            repo: r.repo,
            fullName: r.fullName,
            titles: r.titles,
            tabCount: 1,
            openedAt: r.openedAt,
            openedAtMs: r.openedAtMs,
            openedAtSource: r.openedAtSource,
            tabIndex: r.tabIndex
          };
        })
        .concat([
          {
            type: 'releases',
            url: 'https://github.com/nano-muse/nanoMuse/releases',
            titles: ['Releases'],
            tabCount: 1,
            openedAtMs: base + 5 * 60 * 1000,
            openedAtSource: 'tracked'
          },
          {
            type: 'issue',
            url: 'https://github.com/vercel-labs/agent-browser/issues/42',
            number: 42,
            titles: ['Issue #42'],
            tabCount: 1,
            openedAtMs: base + 9 * 60 * 1000,
            openedAtSource: 'tracked'
          },
          {
            type: 'pull',
            url: 'https://github.com/xerj-org/xerj/pull/7',
            number: 7,
            titles: ['PR #7'],
            tabCount: 1,
            openedAtMs: base + 13 * 60 * 1000,
            openedAtSource: 'tracked'
          }
        ])
    };
  }

  var realFetch = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    var s = String(url && url.url ? url.url : url);
    if (s.indexOf('/links') !== -1) {
      if (demoPromise) {
        return demoPromise.then(function (snap) {
          return new Response(JSON.stringify(snap || mockSnapshot()), {
            headers: { 'Content-Type': 'application/json' }
          });
        });
      }
      return Promise.resolve(
        new Response(JSON.stringify(mockSnapshot()), { headers: { 'Content-Type': 'application/json' } })
      );
    }
    if (s.indexOf('/health') !== -1) {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, mode: 'pull', repos: 12, items: 18 }), {
          headers: { 'Content-Type': 'application/json' }
        })
      );
    }
    if (s.indexOf('/pair-token') !== -1) {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, token: 'preview-token', serverUrl: 'http://127.0.0.1:8788' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      );
    }
    return realFetch(url, opts);
  };
})();
