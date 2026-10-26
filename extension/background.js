/**
 * GitHub Tab Collector — background service worker（拉取模式）
 *
 * 扩展不再主动推送。它做的是「轮询待命」：
 *   一直挂在中继的 /poll 长轮询上；agent 来要数据时，中继回一个 collect，
 *   扩展这时才去扫描标签页并把结果回传给中继。
 *
 * 平时完全静默：没有任何定时推送，也没有标签页变化推送。
 */

importScripts('lib/github.js');
importScripts('lib/collector.js');
importScripts('lib/opentime.js');

var Collector = self.Collector;
var OpenTime = self.OpenTime;

/* ------------------------------------------------------------------ */
/* 标签页打开时间追踪                                                  */
/* ------------------------------------------------------------------ */
/*
 * Chromium 没有提供标签页的创建时间（Tab 上只有 lastAccessed = 最后活动时刻、
 * index = 窗口内位置），所以这里自建一套：记录每个标签页被创建、以及导航到
 * 新 URL 的时刻，供采集时按「打开时间」排序。
 *
 * 监听器必须在顶层同步注册 —— MV3 的 service worker 随时会被回收，
 * 事件到达时浏览器会重新拉起脚本并派发这些事件。
 */
chrome.tabs.onCreated.addListener(function (tab) {
  OpenTime.recordCreated(tab);
});

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (changeInfo && changeInfo.url) {
    OpenTime.recordNavigated(tabId, tab && tab.url);
  }
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  OpenTime.removeTab(tabId);
});

/**
 * 保活 alarm：只负责把被回收的轮询循环重新拉起来，不做任何推送。
 * 注意：只在 alarm 不存在时才创建 —— 每次启动都 clear+create 会把触发时间
 * 一直往后推，导致永远不触发。
 */
function setupKeepalive() {
  Collector.getSettings().then(function (settings) {
    var minutes = Math.max(1, parseInt(settings.heartbeatMinutes, 10) || 1);
    chrome.alarms.get('keepalive', function (existing) {
      if (existing) {
        if (Math.abs(existing.periodInMinutes - minutes) < 0.001) return;
        chrome.alarms.clear('keepalive', function () {
          chrome.alarms.create('keepalive', { periodInMinutes: minutes });
        });
        return;
      }
      chrome.alarms.create('keepalive', { periodInMinutes: minutes });
    });
  });
}

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === 'keepalive') {
    Collector.ensurePolling();
  }
});

chrome.runtime.onInstalled.addListener(function (details) {
  setupKeepalive();
  Collector.ensurePolling();
  // 全新安装才重置会话；扩展升级（update）要保留已记录的打开时间
  if (!details || details.reason === 'install') {
    OpenTime.ensureSession(true);
  }
});

chrome.runtime.onStartup.addListener(function () {
  setupKeepalive();
  Collector.ensurePolling();
  // 浏览器重启：旧 tabId 全部作废，重新起算
  OpenTime.ensureSession(true);
});

/* 浏览器唤醒时确认轮询还活着（不推送任何数据） */
chrome.tabs.onActivated.addListener(function () {
  Collector.ensurePolling();
});
chrome.windows && chrome.windows.onFocusChanged &&
  chrome.windows.onFocusChanged.addListener(function () {
    Collector.ensurePolling();
  });

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;
  if (changes.serverUrl || changes.token || changes.heartbeatMinutes) {
    setupKeepalive();
    Collector.ensurePolling();
  }
});

/* 供 popup / options 调用 */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return false;

  if (msg.type === 'collect') {
    Collector.collect().then(function (snapshot) {
      sendResponse({ ok: true, snapshot: snapshot });
    });
    return true;
  }

  if (msg.type === 'sync') {
    Collector.sync(msg.reason || 'manual', true).then(function (res) {
      sendResponse(res);
    });
    return true;
  }

  if (msg.type === 'getSettings') {
    Collector.getSettings().then(function (s) {
      sendResponse({ ok: true, settings: s });
    });
    return true;
  }

  if (msg.type === 'setSettings') {
    Collector.setSettings(msg.settings || {}).then(function (s) {
      sendResponse({ ok: true, settings: s });
    });
    return true;
  }

  if (msg.type === 'getStatus') {
    Promise.all([
      Collector.getSettings(),
      chrome.storage.local.get(['lastSnapshot', 'lastSyncAt', 'lastSyncOk', 'lastSyncError'])
    ]).then(function (r) {
      sendResponse({
        ok: true,
        settings: r[0],
        snapshot: r[1].lastSnapshot || null,
        lastSyncAt: r[1].lastSyncAt || null,
        lastSyncOk: r[1].lastSyncOk,
        lastSyncError: r[1].lastSyncError || null,
        polling: Collector.isPolling()
      });
    });
    return true;
  }

  if (msg.type === 'ensurePolling') {
    Collector.ensurePolling();
    sendResponse({ ok: true, polling: Collector.isPolling() });
    return false;
  }

  return false;
});

/* service worker 启动：确保轮询在跑，并准备好打开时间追踪 */
setupKeepalive();
Collector.ensurePolling();
OpenTime.ensureSession(false);
