/**
 * GitHub Tab Collector — 标签页「打开时间」追踪
 *
 * 为什么需要自己追踪：
 *   Chromium 并没有提供标签页的创建时间。chrome.tabs.Tab 上跟时间沾边的只有
 *     lastAccessed  —— 上一次「变为活动状态」的时刻（Chrome/Edge 121+），不是打开时间
 *     index         —— 在窗口里的位置序号（顺序，不是时间）
 *     openerTabId   —— 打开它的父标签页 id（关系，不是时间）
 *   而 chrome.sessions.getRecentlyClosed() 的 lastModified 是「关闭」时刻，
 *   且只覆盖已关闭的标签页，对当前打开的标签页无效。
 *
 *   所以「打开时间」只能自建：后台 service worker 监听
 *     tabs.onCreated   标签页被创建
 *     tabs.onUpdated   URL 发生变化（同一个标签页导航到了新页面）
 *     tabs.onRemoved   标签页被关闭
 *   把时刻记进 chrome.storage.local，采集时再合并进快照。
 *
 * 存储结构（storage.local 的 key = tabOpenTimes）：
 *   {
 *     sessionStamp: 's-xxxx',        会话标识，浏览器重启后换新，用来识别作废数据
 *     bootAt: 1712345678901,         本次会话开始时间
 *     tabs: {
 *       '123': { tabAt: 1712..., pageAt: 1712..., url: 'https://github.com/x/y' }
 *     }
 *   }
 *     tabAt  = 标签页被创建的时刻
 *     pageAt = 该标签页「当前这个 URL」被打开的时刻（导航会刷新它）
 *
 * 对外语义（写进快照的 openedAtSource）：
 *   tracked        精确值，事件记录下来的真实打开时间
 *   session-start  该标签页在本次会话开始之前就存在（浏览器重启恢复的），
 *                  拿不到真实打开时间，只能用会话开始时刻兜底
 *   unknown        完全没有信息
 *
 * 同时被 background service worker（importScripts）与 popup 页面加载，
 * 因此使用全局对象，不使用 ES module。
 */
(function (root) {
  'use strict';

  var KEY = 'tabOpenTimes';

  var cache = null; // 内存副本
  var loading = null; // 并发读去重
  var writeChain = Promise.resolve(); // 串行写，避免并发互相覆盖

  function now() {
    return Date.now();
  }

  function randomStamp() {
    return 's-' + now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  async function read() {
    if (cache) return cache;
    if (loading) return loading;
    loading = (async function () {
      var got = await chrome.storage.local.get(KEY);
      var v = got && got[KEY];
      cache = v && typeof v === 'object' && v.tabs ? v : null;
      return cache;
    })();
    try {
      return await loading;
    } finally {
      loading = null;
    }
  }

  async function write(state) {
    cache = state;
    writeChain = writeChain
      .then(function () {
        return chrome.storage.local.set({ tabOpenTimes: state });
      })
      .catch(function () {
        /* 存储失败不影响主流程 */
      });
    return writeChain;
  }

  /**
   * 给当前所有标签页补基线时间。
   * 会话开始之前就存在的标签页（浏览器重启恢复的）拿不到真实打开时间，
   * 统一记成 bootAt，并在快照里标记成 session-start。
   */
  async function baseline(state) {
    var tabs = [];
    try {
      tabs = await chrome.tabs.query({});
    } catch (e) {
      return state;
    }
    var changed = false;
    (tabs || []).forEach(function (t) {
      if (!t || t.id === undefined || t.id === null) return;
      var key = String(t.id);
      if (!state.tabs[key]) {
        state.tabs[key] = { tabAt: state.bootAt, pageAt: state.bootAt, url: t.url || '' };
        changed = true;
      }
    });
    if (changed) await write(state);
    return state;
  }

  /**
   * 确保有会话数据。
   * @param {boolean} force true = 浏览器重启或全新安装，作废旧记录重新起算
   */
  async function ensureSession(force) {
    var state = await read();

    if (force || !state || !state.sessionStamp) {
      state = { sessionStamp: randomStamp(), bootAt: now(), tabs: {} };
      await write(state);
      await baseline(state);
      return state;
    }

    // 已有会话：给漏记的标签页补基线
    await baseline(state);
    return state;
  }

  /** 标签页创建 */
  async function recordCreated(tab) {
    if (!tab || tab.id === undefined || tab.id === null) return null;
    var state = await read();
    if (!state || !state.sessionStamp) {
      state = await ensureSession(false);
    }
    var t = now();
    state.tabs[String(tab.id)] = { tabAt: t, pageAt: t, url: tab.url || '' };
    await write(state);
    return state;
  }

  /** 标签页导航到了新 URL */
  async function recordNavigated(tabId, url) {
    if (tabId === undefined || tabId === null) return null;
    var state = await read();
    if (!state || !state.sessionStamp) return null; // 会话还没起来，交给 baseline 兜底

    var key = String(tabId);
    var rec = state.tabs[key];
    if (!rec) {
      rec = { tabAt: now(), pageAt: now(), url: '' };
      state.tabs[key] = rec;
    }
    rec.pageAt = now();
    if (url) rec.url = url;
    await write(state);
    return state;
  }

  /** 标签页关闭 */
  async function removeTab(tabId) {
    if (tabId === undefined || tabId === null) return null;
    var state = await read();
    if (!state || !state.tabs) return null;
    var key = String(tabId);
    if (!state.tabs[key]) return state;
    delete state.tabs[key];
    await write(state);
    return state;
  }

  /**
   * 取某个标签页的打开时间。
   * @returns {{openedAt:number|null, openedAtSource:string, tabOpenedAt:number|null}}
   */
  function lookup(state, tab) {
    var rec = null;
    if (state && state.tabs && tab && tab.id !== undefined && tab.id !== null) {
      rec = state.tabs[String(tab.id)] || null;
    }
    if (rec) {
      var at = typeof rec.pageAt === 'number' ? rec.pageAt : typeof rec.tabAt === 'number' ? rec.tabAt : null;
      if (at !== null) {
        return { openedAt: at, openedAtSource: 'tracked', tabOpenedAt: rec.tabAt || at };
      }
    }
    if (state && typeof state.bootAt === 'number') {
      return { openedAt: state.bootAt, openedAtSource: 'session-start', tabOpenedAt: state.bootAt };
    }
    return { openedAt: null, openedAtSource: 'unknown', tabOpenedAt: null };
  }

  /** 取当前会话的完整状态（采集时用） */
  async function getState() {
    var state = await read();
    if (!state || !state.sessionStamp) {
      state = await ensureSession(false);
    }
    return state;
  }

  root.OpenTime = {
    KEY: KEY,
    ensureSession: ensureSession,
    getState: getState,
    recordCreated: recordCreated,
    recordNavigated: recordNavigated,
    removeTab: removeTab,
    lookup: lookup
  };
})(typeof self !== 'undefined' ? self : this);
