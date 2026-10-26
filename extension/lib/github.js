/**
 * GitHub URL 解析与快照组装。
 * 同时被 background service worker（importScripts）与 popup/options 页面使用，
 * 因此使用全局对象，不使用 ES module。
 */
(function (root) {
  'use strict';

  var GITHUB_HOSTS = {
    'github.com': 1,
    'www.github.com': 1,
    'gist.github.com': 1
  };

  /** 这些页面不是"项目链接"，默认不采集 */
  var NOISE_TYPES = {
    home: 1,
    settings: 1,
    notifications: 1,
    search: 1,
    explore: 1,
    trending: 1,
    marketplace: 1,
    sponsors: 1,
    topics: 1,
    collections: 1,
    pricing: 1,
    about: 1,
    features: 1,
    apps: 1,
    dashboard: 1,
    new: 1,
    codespaces: 1,
    org: 1,
    user: 1,
    login: 1,
    join: 1,
    site: 1
  };

  /** 值得交给 Agent 的"项目级"链接类型 */
  var PROJECT_TYPES = {
    repo: 1,
    issue: 1,
    pull: 1,
    gist: 1,
    project: 1,
    discussion: 1,
    wiki: 1,
    releases: 1,
    file: 1,
    actions: 1
  };

  function stripTrailingSlash(p) {
    return p.length > 1 && p.charAt(p.length - 1) === '/' ? p.slice(0, -1) : p;
  }

  /**
   * 解析一个 URL。
   * @returns {null | {type:string, url:string, owner?:string, repo?:string, number?:number, host:string, path:string}}
   */
  function parse(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    if (!/^https?:\/\//i.test(rawUrl)) return null;

    var u;
    try {
      u = new URL(rawUrl);
    } catch (e) {
      return null;
    }

    var host = u.hostname.toLowerCase();
    if (!GITHUB_HOSTS[host]) return null;

    var path = stripTrailingSlash(u.pathname || '/');
    var rel = path.replace(/^\/+/, '');
    var segs = path.split('/').filter(function (s) {
      return s.length > 0;
    });

    // gist.github.com/<user>/<hash>
    if (host === 'gist.github.com') {
      if (segs.length >= 2) {
        return {
          type: 'gist',
          url: 'https://gist.github.com/' + segs[0] + '/' + segs[1],
          owner: segs[0],
          repo: null,
          host: host,
          path: path
        };
      }
      return { type: 'gist', url: 'https://gist.github.com/', owner: null, repo: null, host: host, path: path };
    }

    if (segs.length === 0) {
      return { type: 'home', url: 'https://github.com/', host: host, path: path };
    }

    var first = segs[0].toLowerCase();

    // 顶层非仓库页面
    var topLevel = {
      orgs: 'org',
      users: 'user',
      settings: 'settings',
      notifications: 'notifications',
      search: 'search',
      explore: 'explore',
      trending: 'trending',
      marketplace: 'marketplace',
      sponsors: 'sponsors',
      topics: 'topics',
      collections: 'collections',
      pricing: 'pricing',
      about: 'about',
      features: 'features',
      apps: 'apps',
      dashboard: 'dashboard',
      new: 'new',
      codespaces: 'codespaces',
      login: 'login',
      join: 'join',
      pulls: 'dashboard',
      issues: 'dashboard'
    };
    if (topLevel[first]) {
      var t = topLevel[first];
      return { type: t, url: 'https://github.com/' + rel, host: host, path: path };
    }

    if (segs.length < 2) {
      // github.com/<owner> —— 组织/用户主页
      return { type: 'org', url: 'https://github.com/' + segs[0], owner: segs[0], host: host, path: path };
    }

    var owner = segs[0];
    var repo = segs[1];
    var third = (segs[2] || '').toLowerCase();
    var base = 'https://github.com/' + owner + '/' + repo;

    function withRest(type, canonical) {
      return {
        type: type,
        url: canonical || base,
        owner: owner,
        repo: repo,
        host: host,
        path: path
      };
    }

    switch (third) {
      case 'issues':
        if (segs[3] && /^\d+$/.test(segs[3])) {
          var r = withRest('issue', base + '/issues/' + segs[3]);
          r.number = parseInt(segs[3], 10);
          return r;
        }
        return withRest('repo');
      case 'pull':
        if (segs[3] && /^\d+$/.test(segs[3])) {
          var p = withRest('pull', base + '/pull/' + segs[3]);
          p.number = parseInt(segs[3], 10);
          return p;
        }
        return withRest('repo');
      case 'pulls':
        return withRest('repo');
      case 'discussions':
        if (segs[3] && /^\d+$/.test(segs[3])) {
          var d = withRest('discussion', base + '/discussions/' + segs[3]);
          d.number = parseInt(segs[3], 10);
          return d;
        }
        return withRest('repo');
      case 'wiki':
        return withRest('wiki', base + '/wiki');
      case 'projects':
        return withRest('project', base + '/projects');
      case 'releases':
        return withRest('releases', base + '/releases');
      case 'actions':
        return withRest('actions', base + '/actions');
      case 'blob':
      case 'tree':
        return withRest('file', 'https://github.com/' + rel);
      default:
        return withRest('repo');
    }
  }

  function isNoise(type) {
    return !!NOISE_TYPES[type];
  }

  function isProject(type) {
    return !!PROJECT_TYPES[type];
  }

  function repoFullName(item) {
    if (item.type === 'repo') return item.owner + '/' + item.repo;
    if (item.owner && item.repo && item.type !== 'org') return item.owner + '/' + item.repo;
    return null;
  }

  /**
   * 把采集到的原始 tab 列表整理成快照。
   * @param {Array} tabs chrome.tabs 的结果
   * @param {Object} opts { includeNonProject: boolean, includeIssues: boolean, openState: Object }
   *   openState 来自 lib/opentime.js，用来给每个条目补上「打开时间」
   */
  function buildSnapshot(tabs, opts) {
    opts = opts || {};
    var items = [];
    var seen = {};
    var openState = opts.openState || null;

    tabs.forEach(function (tab) {
      var info = parse(tab.url);
      if (!info) return;
      if (info.type === 'noise') return;
      if (!opts.includeNonProject && !isProject(info.type)) return;
      if (opts.includeIssues === false && (info.type === 'issue' || info.type === 'pull')) return;

      var key = info.url;
      if (seen[key]) {
        // 同一个 URL 开了多个标签页：合并标题
        var prev = seen[key];
        if (tab.title && prev.titles.indexOf(tab.title) === -1) prev.titles.push(tab.title);
        prev.tabCount += 1;
        // 取最早的那次打开时间
        var t = timingOf(tab, openState);
        if (t.openedAtMs !== null && (prev.openedAtMs === null || t.openedAtMs < prev.openedAtMs)) {
          prev.openedAtMs = t.openedAtMs;
          prev.openedAt = t.openedAt;
          prev.openedAtSource = t.openedAtSource;
        }
        return;
      }

      var timing = timingOf(tab, openState);

      var entry = {
        type: info.type,
        url: info.url,
        owner: info.owner || null,
        repo: info.repo || null,
        fullName: repoFullName(info),
        number: typeof info.number === 'number' ? info.number : null,
        titles: tab.title ? [tab.title] : [],
        tabCount: 1,
        tabId: tab.id,
        windowId: tab.windowId,
        incognito: !!tab.incognito,
        active: !!tab.active,
        lastAccessed: typeof tab.lastAccessed === 'number' ? tab.lastAccessed : null,
        // 打开时间：openedAt 是 ISO 字符串，openedAtMs 是 epoch 毫秒（便于排序）
        openedAt: timing.openedAt,
        openedAtMs: timing.openedAtMs,
        openedAtSource: timing.openedAtSource,
        tabIndex: typeof tab.index === 'number' ? tab.index : null,
        favIconUrl: tab.favIconUrl || null
      };
      seen[key] = entry;
      items.push(entry);
    });

    // 仓库聚合（Agent 最常要的东西）
    // 只要标签页落在某个仓库里（仓库主页、文件页、Issue、PR……）都计入该仓库，
    // 这样"只打开了一个文件页"也能被识别出对应仓库。
    var repos = {};
    var repoList = [];
    items.forEach(function (it) {
      if (!it.owner || !it.repo) return;
      if (it.type === 'org') return;
      var key = it.owner + '/' + it.repo;
      if (!repos[key]) {
        repos[key] = {
          fullName: key,
          owner: it.owner,
          repo: it.repo,
          url: 'https://github.com/' + key,
          titles: [],
          tabCount: 0,
          open: true,
          openedAt: null,
          openedAtMs: null,
          openedAtSource: 'unknown',
          tabIndex: null
        };
        repoList.push(repos[key]);
      }
      var r = repos[key];
      r.tabCount += it.tabCount;
      it.titles.forEach(function (t) {
        if (r.titles.indexOf(t) === -1) r.titles.push(t);
      });
      // 仓库的打开时间 = 它名下所有标签页里最早打开的那个
      if (it.openedAtMs !== null && (r.openedAtMs === null || it.openedAtMs < r.openedAtMs)) {
        r.openedAtMs = it.openedAtMs;
        r.openedAt = it.openedAt;
        r.openedAtSource = it.openedAtSource;
      }
      if (it.tabIndex !== null && (r.tabIndex === null || it.tabIndex < r.tabIndex)) {
        r.tabIndex = it.tabIndex;
      }
    });

    // 排序：最早打开的在前；同一时刻按窗口内位置；再相同则按名字
    repoList.sort(byOpenedAt);

    // 条目（其他类型的 GitHub 链接）同样按打开时间排
    items.sort(byOpenedAt);

    var counts = {
      githubTabs: items.length,
      repos: repoList.length,
      issues: items.filter(function (i) {
        return i.type === 'issue';
      }).length,
      pulls: items.filter(function (i) {
        return i.type === 'pull';
      }).length,
      gists: items.filter(function (i) {
        return i.type === 'gist';
      }).length,
      other: items.filter(function (i) {
        return ['repo', 'issue', 'pull', 'gist'].indexOf(i.type) === -1;
      }).length
    };

    return {
      generatedAt: new Date().toISOString(),
      source: 'github-tab-collector',
      sortBy: 'openedAt-asc',
      counts: counts,
      repos: repoList,
      items: items
    };
  }

  /** 取某个 tab 的打开时间信息 */
  function timingOf(tab, openState) {
    var at = null;
    var source = 'unknown';

    if (openState && root.OpenTime && typeof root.OpenTime.lookup === 'function') {
      var r = root.OpenTime.lookup(openState, tab);
      at = r && typeof r.openedAt === 'number' ? r.openedAt : null;
      source = (r && r.openedAtSource) || 'unknown';
    }

    if (at === null) {
      return { openedAt: null, openedAtMs: null, openedAtSource: 'unknown' };
    }
    return {
      openedAt: new Date(at).toISOString(),
      openedAtMs: at,
      openedAtSource: source
    };
  }

  /** 排序比较器：打开时间升序（最早在前） */
  function byOpenedAt(a, b) {
    var at = a.openedAtMs === null || a.openedAtMs === undefined ? Infinity : a.openedAtMs;
    var bt = b.openedAtMs === null || b.openedAtMs === undefined ? Infinity : b.openedAtMs;
    if (at !== bt) return at - bt;

    var ai = a.tabIndex === null || a.tabIndex === undefined ? 9999 : a.tabIndex;
    var bi = b.tabIndex === null || b.tabIndex === undefined ? 9999 : b.tabIndex;
    if (ai !== bi) return ai - bi;

    var an = (a.fullName || a.url || '').toLowerCase();
    var bn = (b.fullName || b.url || '').toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  }

  /** 本地时间格式化：2026-10-26 16:24 */
  function formatOpenedAt(ms) {
    if (ms === null || ms === undefined) return '未知';
    var d = new Date(ms);
    if (isNaN(d.getTime())) return '未知';
    function p(n) {
      return n < 10 ? '0' + n : '' + n;
    }
    return (
      d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    );
  }

  function toMarkdown(snapshot) {
    var lines = [];
    var generatedAt = snapshot.generatedAt || snapshot.receivedAt || '未知';
    lines.push('# GitHub 项目链接（来自浏览器已打开标签页）');
    lines.push('');
    lines.push('> 更新时间：' + generatedAt);
    lines.push('> 仓库 ' + snapshot.counts.repos + ' 个 / GitHub 标签页 ' + snapshot.counts.githubTabs + ' 个');
    lines.push('> 排序：按标签页打开时间从早到晚');
    lines.push('');
    lines.push('## 仓库');
    lines.push('');
    if (!snapshot.repos.length) {
      lines.push('_(没有打开的 GitHub 仓库标签页)_');
    } else {
      snapshot.repos.forEach(function (r) {
        lines.push('- **' + r.fullName + '** — ' + r.url);
        lines.push('  - 打开于：' + formatOpenedAt(r.openedAtMs) + openSourceNote(r.openedAtSource));
        if (r.titles.length) {
          lines.push('  - 标签页标题：' + r.titles.join(' / '));
        }
      });
    }
    lines.push('');
    lines.push('## 其他 GitHub 链接');
    lines.push('');
    var others = snapshot.items.filter(function (i) {
      return i.type !== 'repo';
    });
    if (!others.length) {
      lines.push('_(无)_');
    } else {
      others.forEach(function (i) {
        var label = i.type + (i.number ? ' #' + i.number : '');
        lines.push('- [' + label + '](' + i.url + ')' + (i.titles.length ? ' — ' + i.titles[0] : ''));
        lines.push('  - 打开于：' + formatOpenedAt(i.openedAtMs) + openSourceNote(i.openedAtSource));
      });
    }
    lines.push('');
    return lines.join('\n');
  }

  /** session-start 是在会话开始前就存在的标签页，时间只是估算，标注出来 */
  function openSourceNote(source) {
    if (source === 'session-start') return '（会话开始前已打开，时间为估算）';
    if (source === 'unknown') return '（未知）';
    return '';
  }

  root.GitHubTabs = {
    parse: parse,
    isNoise: isNoise,
    isProject: isProject,
    buildSnapshot: buildSnapshot,
    toMarkdown: toMarkdown,
    repoFullName: repoFullName,
    formatOpenedAt: formatOpenedAt,
    openSourceNote: openSourceNote,
    byOpenedAt: byOpenedAt
  };
})(typeof self !== 'undefined' ? self : this);
