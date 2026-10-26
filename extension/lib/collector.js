/**
 * GitHub Tab Collector — 采集与推送核心
 *
 * 同时被 background service worker（importScripts）与 popup 页面（<script>）加载。
 * 抽成共享模块的好处：即使 service worker 出问题，popup 依然能独立完成
 * 「采集标签页 -> 推送到中继」，不会出现静默失败。
 */
(function (root) {
  'use strict';

  var DEFAULT_SETTINGS = {
    serverUrl: 'http://127.0.0.1:8788',
    token: '',
    autoSync: true,
    heartbeatMinutes: 1,
    includeIssues: true,
    includeOtherPages: false,
    excludePatterns: '',
    includeIncognito: false
  };

  var PUSH_DEBOUNCE_MS = 1500;
  var state = { lastPushedSignature: null, inFlight: false, debounceTimer: null };

  /* ---------------------------------------------------------------- */
  /* 设置                                                              */
  /* ---------------------------------------------------------------- */

  async function getSettings() {
    var stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
    var s = {};
    Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
      s[k] = stored[k] !== undefined ? stored[k] : DEFAULT_SETTINGS[k];
    });
    return s;
  }

  async function setSettings(patch) {
    await chrome.storage.local.set(patch || {});
    return getSettings();
  }

  function matchesExclude(url, patterns) {
    if (!patterns) return false;
    var list = patterns
      .split('\n')
      .map(function (p) {
        return p.trim().toLowerCase();
      })
      .filter(Boolean);
    var low = url.toLowerCase();
    for (var i = 0; i < list.length; i++) {
      if (low.indexOf(list[i]) !== -1) return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- */
  /* 自动配对                                                          */
  /* ---------------------------------------------------------------- */

  /** 方式一：读取扩展自身目录里的令牌副本（零握手，最可靠） */
  async function readLocalToken() {
    try {
      var res = await fetch(chrome.runtime.getURL('relay-token.txt'), { cache: 'no-store' });
      if (!res.ok) return null;
      var t = (await res.text()).trim();
      return t || null;
    } catch (e) {
      return null;
    }
  }

  /** 方式二：向中继的 /pair-token 要令牌（扩展直连请求不带 Origin，中继已放行） */
  async function fetchTokenOverHttp(serverUrl) {
    try {
      var res = await fetch(serverUrl.replace(/\/+$/, '') + '/pair-token', { cache: 'no-store' });
      if (!res.ok) return null;
      var body = await res.json();
      return body && body.token ? body.token : null;
    } catch (e) {
      return null;
    }
  }

  async function autoConfigure() {
    var s = await getSettings();
    if (s.token) return { paired: true, via: 'stored' };

    var token = await readLocalToken();
    var via = 'local-file';
    if (!token) {
      token = await fetchTokenOverHttp(s.serverUrl);
      via = 'http';
    }
    if (!token) return { paired: false, via: 'none' };

    await chrome.storage.local.set({ token: token });
    return { paired: true, via: via };
  }

  /* ---------------------------------------------------------------- */
  /* 采集                                                              */
  /* ---------------------------------------------------------------- */

  async function collect() {
    var settings = await getSettings();
    var tabs = [];
    try {
      tabs = await chrome.tabs.query({});
    } catch (e) {
      return null;
    }

    var filtered = tabs.filter(function (tab) {
      if (!tab.url || !/^https?:\/\//i.test(tab.url)) return false;
      if (tab.incognito && !settings.includeIncognito) return false;
      if (matchesExclude(tab.url, settings.excludePatterns)) return false;
      return true;
    });

    // 取标签页打开时间（lib/opentime.js 维护，见该文件顶部对 Chromium API 的说明）
    var openState = null;
    try {
      if (root.OpenTime && typeof root.OpenTime.getState === 'function') {
        openState = await root.OpenTime.getState();
      }
    } catch (e) {
      openState = null;
    }

    var snapshot = root.GitHubTabs.buildSnapshot(filtered, {
      includeNonProject: !!settings.includeOtherPages,
      includeIssues: settings.includeIssues !== false,
      openState: openState
    });

    snapshot.counts.totalTabs = tabs.length;
    snapshot.counts.matchedTabs = filtered.length;
    return snapshot;
  }

  function signature(snapshot) {
    if (!snapshot) return '';
    return (
      snapshot.counts.githubTabs +
      '|' +
      snapshot.counts.repos +
      '|' +
      snapshot.items
        .map(function (i) {
          return i.url;
        })
        .sort()
        .join(',')
    );
  }

  /* ---------------------------------------------------------------- */
  /* 推送                                                              */
  /* ---------------------------------------------------------------- */

  async function push(snapshot, reason) {
    if (state.inFlight) return { ok: false, error: 'busy' };
    var settings = await getSettings();
    if (!settings.serverUrl) return { ok: false, error: 'no-server' };

    state.inFlight = true;
    try {
      var headers = { 'Content-Type': 'application/json' };
      if (settings.token) headers['Authorization'] = 'Bearer ' + settings.token;

      var res = await fetch(settings.serverUrl.replace(/\/+$/, '') + '/ingest', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          sentAt: new Date().toISOString(),
          reason: reason || 'auto',
          snapshot: snapshot
        })
      });

      if (res.status === 401) {
        // 令牌不对：重新配对后重试一次
        await chrome.storage.local.set({ token: '' });
        var paired = await autoConfigure();
        if (paired.paired) {
          var s2 = await getSettings();
          headers.Authorization = 'Bearer ' + s2.token;
          var res2 = await fetch(settings.serverUrl.replace(/\/+$/, '') + '/ingest', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
              sentAt: new Date().toISOString(),
              reason: (reason || 'auto') + '-retry',
              snapshot: snapshot
            })
          });
          if (res2.ok) {
            state.lastPushedSignature = signature(snapshot);
            await chrome.storage.local.set({ lastSyncAt: new Date().toISOString(), lastSyncOk: true, lastSyncError: null });
            return { ok: true, retried: true };
          }
          throw new Error('HTTP ' + res2.status);
        }
        throw new Error('HTTP 401 且无法自动配对');
      }

      if (!res.ok) throw new Error('HTTP ' + res.status);

      state.lastPushedSignature = signature(snapshot);
      await chrome.storage.local.set({
        lastSyncAt: new Date().toISOString(),
        lastSyncOk: true,
        lastSyncError: null
      });
      return { ok: true };
    } catch (e) {
      var msg = String((e && e.message) || e);
      await chrome.storage.local.set({
        lastSyncAt: new Date().toISOString(),
        lastSyncOk: false,
        lastSyncError: msg
      });
      return { ok: false, error: msg };
    } finally {
      state.inFlight = false;
    }
  }

  async function sync(reason, force) {
    var snapshot = await collect();
    if (!snapshot) return { ok: false, error: 'collect-failed' };

    await chrome.storage.local.set({ lastSnapshot: snapshot });

    var settings = await getSettings();
    if (!settings.autoSync && reason !== 'manual' && reason !== 'popup') {
      return { ok: true, skipped: 'auto-sync-off', snapshot: snapshot };
    }

    if (!settings.token) {
      await autoConfigure();
      settings = await getSettings();
    }

    var sig = signature(snapshot);
    if (!force && sig === state.lastPushedSignature && reason !== 'heartbeat') {
      return { ok: true, skipped: 'unchanged', snapshot: snapshot };
    }

    var res = await push(snapshot, reason);
    return { ok: res.ok, error: res.error, skipped: res.skipped, snapshot: snapshot };
  }

  function scheduleSync(reason) {
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(function () {
      state.debounceTimer = null;
      sync(reason, false);
    }, PUSH_DEBOUNCE_MS);
  }

  /* ---------------------------------------------------------------- */
  /* 拉取模式：轮询待命                                                */
  /* ---------------------------------------------------------------- */

  var pollState = { running: false, backoff: 1000, lastError: null };

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  /**
   * 一轮长轮询：挂在中继的 /poll 上，等 agent 要数据时（中继返回 action=collect）
   * 才去采集标签页并回传。平时完全静默，不产生任何主动推送。
   */
  async function pollOnce() {
    var settings = await getSettings();
    var base = (settings.serverUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('no-server');

    var headers = {};
    if (settings.token) headers['Authorization'] = 'Bearer ' + settings.token;

    var res = await fetch(base + '/poll', { headers: headers, cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var body = await res.json();
    pollState.lastError = null;

    if (body && body.action === 'collect') {
      var snapshot = await collect();
      if (snapshot) {
        await push(snapshot, 'pull');
      }
    }
    return true;
  }

  async function pollLoop() {
    if (pollState.running) return;
    pollState.running = true;
    while (pollState.running) {
      try {
        await pollOnce();
        pollState.backoff = 1000;
      } catch (e) {
        pollState.lastError = String((e && e.message) || e);
        await sleep(pollState.backoff);
        pollState.backoff = Math.min(pollState.backoff * 2, 30000);
      }
    }
    pollState.running = false;
  }

  /** 幂等：轮询已经活着就不重复启动 */
  function ensurePolling() {
    if (!pollState.running) {
      pollLoop();
      return true;
    }
    return false;
  }

  function stopPolling() {
    pollState.running = false;
  }

  function isPolling() {
    return pollState.running;
  }

  root.Collector = {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    getSettings: getSettings,
    setSettings: setSettings,
    autoConfigure: autoConfigure,
    collect: collect,
    push: push,
    sync: sync,
    scheduleSync: scheduleSync,
    pollOnce: pollOnce,
    ensurePolling: ensurePolling,
    stopPolling: stopPolling,
    isPolling: isPolling,
    pollState: pollState
  };
})(typeof self !== 'undefined' ? self : this);
