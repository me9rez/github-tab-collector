/* options.js —— 直接使用共享的 Collector，不依赖 service worker */
(function () {
  'use strict';

  var Collector = self.Collector;

  var FIELDS = [
    'serverUrl',
    'token',
    'autoSync',
    'heartbeatMinutes',
    'includeIssues',
    'includeOtherPages',
    'excludePatterns',
    'includeIncognito'
  ];

  /** 已保存的令牌：输入框留空时不覆盖它（避免误清空自动配对好的值） */
  var savedToken = '';

  function el(id) {
    return document.getElementById(id);
  }

  /**
   * 剪贴板写入。
   * 先走标准剪贴板 API，但加超时保护：某些环境（浏览器面板未聚焦、嵌入式窗口）
   * 下 writeText 会一直挂着不返回，那样按钮就永远卡在「复制中…」。
   * @returns {'clipboard'|'execCommand'|'failed'}
   */
  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        var how = await Promise.race([
          navigator.clipboard.writeText(text).then(function () {
            return 'clipboard';
          }),
          new Promise(function (resolve) {
            setTimeout(function () {
              resolve('timeout');
            }, 1500);
          })
        ]);
        if (how === 'clipboard') return 'clipboard';
      } catch (e) {
        /* 落到兜底 */
      }
    }
    // 兜底：隐藏 textarea + execCommand
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
    return ok ? 'execCommand' : 'failed';
  }

  /** 中继面板链接：跟着「服务地址」输入框实时走；用原生 <a target="_blank"> 让浏览器自己开标签页 */
  function syncRelayLink(base) {
    var a = el('open-relay');
    var url = (base || '').replace(/\/+$/, '');
    if (url) {
      a.href = url + '/';
      a.className = 'gb-btn';
      a.removeAttribute('aria-disabled');
    } else {
      a.href = '#';
      a.className = 'gb-btn off';
      a.setAttribute('aria-disabled', 'true');
    }
    el('relay-url').textContent = url ? url + '/' : '未配置';
  }

  function flash(text, ok) {
    var s = el('saved');
    s.textContent = text;
    s.className = 'gb-flash' + (ok ? '' : ' err');
    setTimeout(function () {
      s.className = 'gb-flash hide';
    }, 4000);
  }

  async function init() {
    var s = await Collector.getSettings();
    savedToken = s.token || '';
    FIELDS.forEach(function (f) {
      var input = el(f);
      if (!input) return;
      if (input.type === 'checkbox') input.checked = !!s[f];
      else if (s[f] !== undefined) input.value = s[f];
    });
    var base = (s.serverUrl || '').replace(/\/+$/, '');
    syncRelayLink(base);
  }

  function collectSettings() {
    var out = {};
    FIELDS.forEach(function (f) {
      var input = el(f);
      if (!input) return;
      if (input.type === 'checkbox') out[f] = input.checked;
      else if (f === 'heartbeatMinutes') out[f] = Math.max(1, parseInt(input.value, 10) || 1);
      else out[f] = input.value.trim();
    });
    // 令牌输入框留空时保留已存的令牌
    if (!out.token && savedToken) out.token = savedToken;
    return out;
  }

  el('save').addEventListener('click', async function () {
    var btn = this;
    var label = btn.textContent;
    btn.textContent = '保存中…';
    try {
      await Collector.setSettings(collectSettings());
      var settings = await Collector.getSettings();
      savedToken = settings.token || '';
      Collector.ensurePolling();

      // 端到端校验：让中继去要一次数据，确认扩展在线
      var base = (settings.serverUrl || '').replace(/\/+$/, '');
      var headers = {};
      if (settings.token) headers['Authorization'] = 'Bearer ' + settings.token;
      var res = await fetch(base + '/links?refresh=1', { headers: headers, cache: 'no-store' });
      var body = await res.json();
      if (res.ok && body.refreshed) {
        flash('已保存 · 扩展回传 ' + (body.repos || []).length + ' 个仓库 ✓', true);
      } else if (res.ok) {
        flash('已保存 · 但扩展没响应', false);
      } else {
        flash('已保存 · 校验失败 HTTP ' + res.status, false);
      }
    } catch (e) {
      flash('保存失败 · ' + String(e.message || e), false);
    }
    btn.textContent = label;
  });

  el('test').addEventListener('click', async function () {
    var s = collectSettings();
    var btn = this;
    var label = btn.textContent;
    btn.textContent = '测试中…';
    try {
      var res = await fetch(s.serverUrl.replace(/\/+$/, '') + '/health');
      var body = await res.text();
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + body.slice(0, 80));
      flash('连接正常 · ' + body.slice(0, 60), true);
    } catch (e) {
      flash('连接失败 · ' + String(e.message || e), false);
    }
    btn.textContent = label;
  });

  el('open-relay').addEventListener('click', function (e) {
    if (this.getAttribute('aria-disabled') === 'true') {
      e.preventDefault();
      flash('请先填写服务地址', false);
    }
  });

  // 服务地址一改，中继面板链接和提示就跟着变
  el('serverUrl').addEventListener('input', function () {
    syncRelayLink(this.value.trim());
  });

  el('copy-config').addEventListener('click', async function () {
    var btn = this;
    var label = btn.textContent;
    btn.textContent = '复制中…';
    try {
      var s = await Collector.getSettings();
      // 字段名与设置项一一对应，方便直接搬到另一台机器上
      var payload = {
        serverUrl: s.serverUrl,
        token: s.token,
        autoSync: s.autoSync,
        heartbeatMinutes: s.heartbeatMinutes,
        includeIssues: s.includeIssues,
        includeOtherPages: s.includeOtherPages,
        excludePatterns: s.excludePatterns,
        includeIncognito: s.includeIncognito,
        _exportedAt: new Date().toISOString(),
        _source: 'GitHub Tab Collector · 设置页'
      };
      var how = await copyText(JSON.stringify(payload, null, 2));
      if (how === 'clipboard') flash('配置 JSON 已复制到剪贴板 ✓', true);
      else if (how === 'execCommand') flash('配置 JSON 已复制到剪贴板 ✓（兼容模式）', true);
      else flash('复制失败 · 浏览器拒绝了剪贴板操作', false);
    } catch (e) {
      flash('复制失败 · ' + String(e.message || e), false);
    }
    btn.textContent = label;
  });

  el('pair').addEventListener('click', async function () {
    var btn = this;
    var label = btn.textContent;
    var msg = el('pair-msg');
    btn.textContent = '配对中…';
    msg.textContent = '';

    var base = el('serverUrl').value.trim().replace(/\/+$/, '');
    if (!base) {
      msg.textContent = '请先填写服务地址';
      btn.textContent = label;
      return;
    }

    // 优先走本地令牌文件：扩展可以读自身目录，不需要网络握手
    try {
      var local = await fetch(chrome.runtime.getURL('relay-token.txt'), { cache: 'no-store' });
      if (local.ok) {
        var token = (await local.text()).trim();
        if (token) {
          el('token').value = token;
          savedToken = token;
          msg.textContent = '已读取本地令牌文件，保存后生效';
          btn.textContent = label;
          return;
        }
      }
    } catch (e) {
      /* 落到 HTTP 配对 */
    }

    try {
      var res = await fetch(base + '/pair-token', { cache: 'no-store' });
      var body = await res.json();
      if (!res.ok || !body.token) {
        msg.textContent = '配对失败（' + (body.error || res.status) + '），请手动复制 data/relay-token.txt';
      } else {
        el('token').value = body.token;
        savedToken = body.token;
        if (body.serverUrl) el('serverUrl').value = body.serverUrl;
        msg.textContent = '已获取令牌，保存后生效';
      }
    } catch (e) {
      msg.textContent = '配对失败 · ' + String(e.message || e);
    }
    btn.textContent = label;
  });

  // 载入已保存的配置：表单必须回填，否则用户点一次「保存」就会把配置覆盖成空
  init();
})();
