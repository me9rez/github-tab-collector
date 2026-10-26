/* popup.js —— 拉取模式：数据来自中继，popup 只是查看器 */
(function () {
  'use strict';

  var Collector = self.Collector;

  var el = function (id) {
    return document.getElementById(id);
  };

  function fmtTime(iso) {
    if (!iso) return '尚未取到数据';
    try {
      var d = new Date(iso);
      var p = function (n) {
        return n < 10 ? '0' + n : '' + n;
      };
      return '更新 ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    } catch (e) {
      return '更新 ' + iso;
    }
  }

  /** 打开时间：MM-DD HH:MM；会话开始前就存在的标签页用 ≈ 标出是估算值 */
  function fmtOpened(entry) {
    if (!entry || entry.openedAtMs === null || entry.openedAtMs === undefined) return '时间未知';
    var d = new Date(entry.openedAtMs);
    if (isNaN(d.getTime())) return '时间未知';
    var p = function (n) {
      return n < 10 ? '0' + n : '' + n;
    };
    var approx = entry.openedAtSource === 'session-start' ? '≈' : '';
    return approx + '打开 ' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function renderCounts(c) {
    var stats = [
      { n: c.repos || 0, l: '仓库', cls: 'cool' },
      { n: c.githubTabs || 0, l: 'GH页', cls: '' },
      { n: c.issues || 0, l: 'ISSUE', cls: 'cool' },
      { n: c.pulls || 0, l: 'PR', cls: 'cool' },
      { n: c.totalTabs || 0, l: '全部页', cls: 'warm' }
    ];
    el('counts').innerHTML = stats
      .map(function (s) {
        return (
          '<div class="gb-stat ' + s.cls + '"><div class="n">' + s.n + '</div><div class="l">' + s.l + '</div></div>'
        );
      })
      .join('');
  }

  function renderRepos(repos) {
    var list = el('repo-list');
    el('repo-count').textContent = repos.length;
    if (!repos.length) {
      list.innerHTML = '<li class="gb-empty">没有打开的 GitHub 仓库标签页</li>';
      return;
    }
    list.innerHTML = repos
      .map(function (r) {
        var meta = fmtOpened(r) + ' · ' + (r.titles && r.titles.length ? r.titles[0] : '(无标题)');
        if (r.tabCount > 1) meta += ' · ' + r.tabCount + ' 个标签页';
        return (
          '<li>' +
          '<div class="row"><span class="gb-caret">▸</span>' +
          '<a class="name" href="' + r.url + '" target="_blank">' + r.fullName + '</a></div>' +
          '<div class="meta">' + meta + '</div></li>'
        );
      })
      .join('');
  }

  function renderOthers(items) {
    var others = items.filter(function (i) {
      return i.type !== 'repo';
    });
    el('other-count').textContent = others.length;
    if (!others.length) {
      el('other-list').innerHTML = '<li class="gb-empty">无</li>';
      return;
    }
    el('other-list').innerHTML = others
      .map(function (i) {
        var label = i.type + (i.number ? '#' + i.number : '');
        var meta = fmtOpened(i);
        if (i.titles && i.titles.length) meta += ' · ' + i.titles[0];
        return (
          '<li>' +
          '<div class="row"><span class="gb-tag ' + i.type + '">' + label + '</span>' +
          '<a class="name" href="' + i.url + '" target="_blank">' + i.url + '</a></div>' +
          '<div class="meta">' + meta + '</div></li>'
        );
      })
      .join('');
  }

  /**
   * 复制到剪贴板。
   * 走标准剪贴板 API，但加超时保护：某些环境下 writeText 会一直挂着，
   * 那时退回 textarea + execCommand 兜底，别让按钮卡在「已复制」。
   */
  async function copyText(text, btn) {
    var old = btn.getAttribute('data-label') || btn.textContent;
    var how = 'failed';

    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        var how2 = await Promise.race([
          navigator.clipboard.writeText(text).then(function () {
            return 'clipboard';
          }),
          new Promise(function (resolve) {
            setTimeout(function () {
              resolve('timeout');
            }, 1500);
          })
        ]);
        if (how2 === 'clipboard') how = 'clipboard';
      } catch (e) {
        /* 落到兜底 */
      }
    }

    if (how !== 'clipboard' && fallbackCopy(text)) how = 'execCommand';

    btn.textContent = how === 'failed' ? '复制失败 ✗' : '已复制 ✓';
    setTimeout(function () {
      btn.textContent = old;
    }, 1200);
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }

  var current = null;

  /** 向中继要数据；refresh=1 表示让中继通知扩展去重新采集 */
  async function fetchLinks(refresh) {
    var settings = await Collector.getSettings();
    var base = (settings.serverUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('未配置中继地址');

    var headers = {};
    if (settings.token) headers['Authorization'] = 'Bearer ' + settings.token;

    var url = base + '/links' + (refresh ? '?refresh=1' : '');
    var res = await fetch(url, { headers: headers, cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function render(data, note) {
    current = data;
    renderCounts(data.counts || {});
    renderRepos(data.repos || []);
    renderOthers(data.items || []);
    el('last-sync').textContent = fmtTime(data.receivedAt) + (note ? ' · ' + note : '');
  }

  async function load(refresh) {
    var btn = el('btn-sync');
    var label = btn.getAttribute('data-label') || btn.textContent;
    btn.textContent = refresh ? '采集…' : '读取…';
    el('status-dot').className = 'gb-led idle';

    try {
      var data = await fetchLinks(refresh);
      var note = '';
      if (data.stale) note = '扩展未响应 · 上次快照';
      else if (data.refreshed) note = '已重新采集';
      el('status-dot').className = 'gb-led ok';
      render(data, note);
    } catch (e) {
      el('status-dot').className = 'gb-led err';
      el('last-sync').textContent = '读取失败 · ' + String(e.message || e);
      // 兜底：直接从本机标签页采集一份
      try {
        var snap = await Collector.collect();
        if (snap) {
          current = { receivedAt: snap.generatedAt, counts: snap.counts, repos: snap.repos, items: snap.items };
          renderCounts(snap.counts || {});
          renderRepos(snap.repos || []);
          renderOthers(snap.items || []);
          el('last-sync').textContent = '中继不可用 · 本地采集';
        }
      } catch (e2) {
        /* ignore */
      }
    }
    btn.textContent = label;
  }

  el('btn-sync').addEventListener('click', function () {
    load(true);
  });

  el('btn-copy-md').addEventListener('click', function () {
    if (!current) return;
    copyText(GitHubTabs.toMarkdown(current), el('btn-copy-md'));
  });

  el('btn-copy-json').addEventListener('click', function () {
    if (!current) return;
    copyText(JSON.stringify(current, null, 2), el('btn-copy-json'));
  });

  el('open-options').addEventListener('click', function (e) {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  (async function init() {
    var settings = await Collector.getSettings();
    el('status-line').textContent = (settings.serverUrl || '').replace(/^https?:\/\//, '') + ' · 拉取';
    el('open-relay').href = settings.serverUrl ? settings.serverUrl.replace(/\/+$/, '') + '/' : '#';
    await load(false);
  })();
})();
