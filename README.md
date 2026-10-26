# GitHub Tab Collector

把浏览器里打开的 GitHub 项目链接，实时同步给你的 Agent（我、Claude Code、Cursor 等），
从此不用再手动复制粘贴。

**拉取模式（默认）：扩展不主动推送，Agent 主动来取。**

```
┌──────────────┐   ① 长轮询挂起等待      ┌──────────────┐              ┌───────────┐
│ Chrome / Edge│ ─────────────────────► │ 本地中继 8788 │ ◄─────────── │  扩展      │
│  扩展         │   GET /poll            │  server.mjs   │  ② POST      │ (待命)    │
│              │ ◄───────────────────── │              │  /ingest     │           │
└──────────────┘   {action:"collect"}    └──────┬───────┘              └───────────┘
                                                │
                     ③ Agent 查询 /links?refresh=1 │
                                                ▼
                                   data/github-tabs.json
                                   data/github-links.md
```

流程：Agent 调 `/links?refresh=1` → 中继把一个"去采集"的指令交给正在长轮询的扩展 →
扩展扫描标签页并回传 → 中继把新快照返回给 Agent。全程只有 Agent 发起请求时才有流量。

## 目录结构

```
github-tab-collector/
├── extension/            # Chrome / Edge 扩展（Manifest V3）
│   ├── manifest.json
│   ├── theme.css         # 像素游戏主题（DMG 掌机配色 + 组件）
│   ├── popup.html/js/css # 悬浮窗：查看、复制、刷新（像素风）
│   ├── options.html/js   # 设置页：中继地址、令牌、采集范围（像素风）
│   ├── background.js     # 后台：轮询待命 + keepalive
│   ├── lib/collector.js  # 采集与推送核心（background 与 popup 共用）
│   ├── lib/github.js     # GitHub URL 解析与快照组装
│   ├── lib/opentime.js   # 标签页打开时间追踪（Chromium 没有这个 API，自己建）
│   ├── lib/preview-shim.js # 非扩展环境下的预览垫片
│   ├── fonts/            # Fusion Pixel 12px 像素字体（MIT + OFL）
│   ├── relay-token.txt   # 中继自动写入的令牌副本，扩展用它零握手自动配对
│   └── icons/
├── relay/
│   └── server.mjs        # 本地中继（零依赖，Node >= 18）+ 像素风面板
├── mcp/
│   └── github-links-mcp.mjs  # MCP stdio 服务（零依赖）
├── tools/
│   └── preview.mjs       # 预览服务器：不开扩展也能看 UI
├── data/                 # 运行时生成：JSON 快照 / Markdown / 令牌 / PID
├── test/                 # 冒烟测试（隔离中继，不污染真实数据）
├── start-relay.cmd       # Windows 一键启动中继
└── README.md
```

## 界面主题：掌机像素风

界面使用 **Fusion Pixel 12px**（缝合像素字体，MIT + OFL，可商用），配合 DMG-01 掌机配色：

| 变量 | 色值 | 用途 |
|---|---|---|
| `--gb-shell` | `#c4bfb0` | 外壳底色 + 网格底纹 |
| `--gb-panel` | `#dbd6c4` | 面板 |
| `--gb-light` | `#efecdc` | 高光 / 卡片 |
| `--gb-ink` | `#2b2a24` | 描边与正文（2px 实边 + 3px 硬投影，零圆角） |
| `--gb-green` | `#4d7c3f` | 主按钮 / 数值 |
| `--gb-gold` | `#c9a227` | 强调 / 标签 |
| `--gb-magenta` | `#a3346e` | 配对按钮 / 次级链接 |

想改配色或字号，直接改 `extension/theme.css` 顶部的 `:root` 变量即可。

### 滚动条（掌机风）

滚动条不复用浏览器默认样式，而是重画成 Game Boy 掌机样式：

- **轨道**：DMG 外壳底色 + 4px 抖动点阵纹理（`repeating-conic-gradient`），左侧与顶部带 2px 硬描边
- **滑块**：2px 硬描边 + 立体内阴影 + 横向抓握纹（`repeating-linear-gradient`）；悬停变亮，按下变绿
- **箭头**：20×20 硬描边按钮，图标是 4 段阶梯拼出的像素三角（`--gb-arrow`），悬停变白、按下变金
- **Firefox 回退**：`@supports (-moz-appearance: none)` 内声明 `scrollbar-color` / `scrollbar-width`

> ⚠️ 那个 `@supports` 必须用 `-moz-appearance` 限定，不能用 `@supports (scrollbar-color: auto)`。
> Chromium 121+ 同样支持 `scrollbar-color`，一旦声明就会整体接管滚动条渲染并**丢弃所有
> `::-webkit-scrollbar-*` 伪元素样式**，掌机风会静默退化成 Chrome 原生圆角滚动条。

同一套样式在 `relay/server.mjs` 的中继面板里也有一份（改完记得重启中继）。

### 不装扩展也能预览

```bash
node tools/preview.mjs
# → http://127.0.0.1:8899/popup.html
# → http://127.0.0.1:8899/options.html
```

预览模式会加载 `lib/preview-shim.js`，用模拟的 chrome API 和示例数据渲染，不会连真实中继。

## 一、安装扩展

**Chrome**
1. 地址栏打开 `chrome://extensions/`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择本项目里的 `extension` 文件夹

**Edge**
1. 地址栏打开 `edge://extensions/`
2. 左下角打开「开发人员模式」
3. 点「加载解压缩的扩展」，选择本项目里的 `extension` 文件夹

装好后工具栏会出现 GitHub Tab Collector 图标。

## 二、启动中继服务

```bash
# Windows
start-relay.cmd

# 或任意平台
node relay/server.mjs
```

首次启动会生成访问令牌并写到 `data/relay-token.txt`，控制台也会打印：

```
  GitHub Tab Collector · 中继服务已启动
  监听      http://127.0.0.1:8788
  面板      http://127.0.0.1:8788/
  JSON      http://127.0.0.1:8788/links
  Markdown  http://127.0.0.1:8788/links.md
  数据文件  .../data/github-tabs.json
  令牌      xxxx（也写在 data/relay-token.txt）
```

## 三、连接扩展与中继

**不需要手工填令牌。** 中继启动时会把令牌多写一份到 `extension/relay-token.txt`，
扩展可以直接读取自己目录里的这个文件完成配对（零握手，无网络握手、无需复制粘贴）。

打开扩展的「设置」页确认一下：

| 字段 | 值 |
|---|---|
| 服务地址 | `http://127.0.0.1:8788`（默认值，已经正确） |
| 访问令牌 | 留空即可，扩展会自动读取 `relay-token.txt` |

点「保存并校验」即可看到绿色状态（保存后会自动做一次端到端校验：
让中继去要一次数据，确认扩展在线）。

拉取模式下扩展不会主动推数据，它只是挂在中继上待命；Agent 查询时才会去采集。
扩展弹窗里的「刷新数据」按钮走的就是同一条链路。

### 设置页的实用入口

设置页分三块：中继服务、采集范围、实用入口。

| 入口 | 作用 |
|---|---|
| **打开中继面板** | 在新标签页打开中继的网页面板（`http://127.0.0.1:8788/`），能看当前快照、仓库列表（含打开时间）和 Agent 接口。链接跟着「服务地址」输入框实时走，地址没填时按钮置灰 |
| **复制配置 JSON** | 把当前设置（含访问令牌）导出成一段 JSON 贴到剪贴板，方便备份或搬到另一台机器。字段名与设置项一一对应，可以直接改好贴回设置页 |
| 一键配对 | 自动读取 `extension/relay-token.txt` 填好令牌 |
| 保存并校验 / 测试连接 | 保存后自动做一次端到端校验（让中继去要一次数据，确认扩展在线） |

> 复制用的剪贴板接口带 1.5 秒超时保护：某些环境下 `navigator.clipboard.writeText()`
> 会一直挂着，超时后自动退回 `textarea + execCommand`，不会让按钮永远卡在「复制中…」。

### 停止服务

前台运行时 `Ctrl+C` 即可。若是后台启动的，运行时会把自己的 PID 写进 `data/relay.pid`：

```powershell
Stop-Process -Id (Get-Content .\data\relay.pid) -Force
```

## 四、Agent 怎么用

### 方式 A：HTTP 接口（推荐，最通用）

```bash
# 拉取最新数据：通知扩展重新采集，等它回传（扩展待命时通常 <1s）
curl "http://127.0.0.1:8788/links?refresh=1&token=<TOKEN>"

# 只要上次快照，立即返回
curl "http://127.0.0.1:8788/links?token=<TOKEN>"

# 只要 owner/repo 列表
curl "http://127.0.0.1:8788/repos?token=<TOKEN>"

# Markdown
curl "http://127.0.0.1:8788/links.md?token=<TOKEN>"

# 状态
curl "http://127.0.0.1:8788/health"
```

`refresh=1` 的响应里：

| 字段 | 含义 |
|---|---|
| `refreshed` | `true` 表示扩展刚刚回传了新快照 |
| `stale` | `true` 表示扩展没响应（没装/没运行），返回的是上一次快照 |
| `waitedMs` | 等扩展响应的耗时 |
| `repos` / `items` / `counts` | 仓库列表、全部 GitHub 链接、统计 |

> 扩展没装或没运行时不会报错——`stale: true` + 上次快照，Agent 能自己判断。

需要令牌时加 `?token=<TOKEN>` 或 `Authorization: Bearer <TOKEN>` 头。

PowerShell：

```powershell
$r = Invoke-RestMethod "http://127.0.0.1:8788/links?refresh=1&token=c07eb28283c71039113b1649386f24dbcfaa72b903b6a2dc"
$r.repos | Select-Object fullName, url
```

### 方式 B：直接读文件（零依赖，最省事）

```bash
cat data/github-links.md          # Markdown，可读性最好
cat data/github-tabs.json         # 完整 JSON
```

文件是最近一次成功采集的结果；想要最新的，用上面的 `refresh=1`。

### 方式 C：MCP（推荐给 Claude Code / Cursor / 本工具链）

`mcp/github-links-mcp.mjs` 是零依赖的 MCP stdio 服务，提供三个工具：

| 工具 | 说明 |
|---|---|
| `list_github_repos` | 列出打开的仓库（可传 `q` 过滤） |
| `search_github_links` | 在所有 GitHub 链接里做子串搜索 |
| `get_github_snapshot` | 统计快照与数据来源 |

MCP 配置示例：

```json
{
  "mcpServers": {
    "github-links": {
      "command": "node",
      "args": ["<仓库绝对路径>/mcp/github-links-mcp.mjs"],
      "env": {
        "GITHUB_LINKS_URL": "http://127.0.0.1:8788/links",
        "GITHUB_LINKS_TOKEN": "<把 data/relay-token.txt 的内容填这里>"
      }
    }
  }
}
```

MiniMax Code 里也可以直接加：

```bash
mavis mcp create github-links --transport stdio \
  --command node \
  --args "<仓库绝对路径>/mcp/github-links-mcp.mjs"
```

MCP 服务优先读中继（带 `refresh=1`，即每次都向扩展要最新数据）；
中继不可用时自动回退到 `data/github-tabs.json` 文件。

### 方式 D：粘贴板兜底

扩展弹窗里有「复制 Markdown」「复制 JSON」，中继起不来时用这个。

## 拉取模式的行为

- 扩展**不做任何主动推送**。它只是挂在 `/poll` 上等着。
- Agent 调 `/links?refresh=1` 时，中继才会通知扩展去采集。
- 扩展被浏览器回收后，由 `keepalive` alarm（默认 1 分钟）把轮询重新拉起来。
- 扩展没装 / 没运行 / 没响应：Agent 拿到 `stale: true` + 上一次快照，不会卡死（最多等 25 秒）。
- popup 打开时只**读取**中继的数据；点「刷新数据」会走一次 `refresh=1`。

## 采集规则

**会被采集**（GitHub 项目级链接）：

| 类型 | 例子 |
|---|---|
| 仓库 | `github.com/owner/repo` |
| Issue | `github.com/owner/repo/issues/123` |
| PR | `github.com/owner/repo/pull/123` |
| Discussion | `github.com/owner/repo/discussions/1` |
| Gist | `gist.github.com/user/hash` |
| Wiki / Projects / Releases / Actions | `github.com/owner/repo/wiki` 等 |
| 文件页 | `github.com/owner/repo/blob/main/README.md` |

**默认忽略**：首页、设置、通知、搜索、趋势、市场、组织/用户主页等非项目页面
（可在设置里勾选「包含其他 GitHub 页面」打开）。
同一仓库开多个标签页会自动合并；仓库列表按**标签页打开时间**排序；Issue/PR 数量单独统计。

## 排序：按标签页打开时间

仓库列表、Markdown 输出、MCP 工具结果**统一按标签页打开时间从早到晚**排序，
每条都带 `openedAt` / `openedAtMs` / `openedAtSource` 三个字段。

### 为什么自己追踪

Chromium **没有提供标签页的创建时间**。`chrome.tabs.Tab` 上跟时间沾边的只有：

| 字段 | 版本 | 语义 | 能不能当「打开时间」 |
|---|---|---|---|
| `lastAccessed` | Chrome/Edge 121+ | 上一次**变为活动状态**的时刻 | ❌ 是「最后活跃」不是「打开」 |
| `index` | 全部 | 在窗口中的位置序号 | ⚠️ 只是顺序的近似 |
| `openerTabId` | 全部 | 打开它的父标签页 id | ⚠️ 是关系不是时间 |

`chrome.sessions.getRecentlyClosed()` 的 `lastModified` 是**关闭**时刻，而且只覆盖已关闭的标签页。

所以扩展自建了一套追踪（`extension/lib/opentime.js`）：后台 service worker 监听
`tabs.onCreated` / `tabs.onUpdated` / `tabs.onRemoved`，把时刻记进 `chrome.storage.local`
的 `tabOpenTimes`，采集时合并进快照。

### 时间的三种来源

| `openedAtSource` | 含义 |
|---|---|
| `tracked` | 精确值，事件记录下来的真实打开时间 |
| `session-start` | 该标签页在本次会话开始**之前**就存在（浏览器重启恢复的），拿不到真实打开时间，用会话开始时刻兜底，界面上带 `≈` 前缀 |
| `unknown` | 完全没有信息，排序时排在最后 |

同一个标签页导航到新 URL 时，`pageAt` 会刷新——所以「这个仓库是什么时候打开的」按**当前这个页面**算。

### 注意

- **重载扩展后追踪才开始计时**。升级/重载前就开着的标签页只能记成 `session-start`（估算值）。
- 浏览器重启后旧 tabId 全部作废，`onStartup` 会重置会话；重启前打开的标签页都是 `session-start`。
- 仓库的打开时间 = 它名下所有标签页里**最早**打开的那个。
- 时间完全相同的（同一秒打开的）按标签页在窗口里的位置 `index` 排，再相同才按名字。

## 常见问题

**扩展连不上中继 / 报 network error**
- 确认中继窗口还开着，`curl http://127.0.0.1:8788/health` 有输出
- 新版 Chrome/Edge 对「访问本地网络」有额外提示；扩展在 `manifest.json` 里已声明
  `http://127.0.0.1/*` 权限，若浏览器弹出授权，请允许
- 端口被占用时用 `PORT=9000 node relay/server.mjs`，并同步改扩展里的服务地址

**`/links?refresh=1` 返回 stale: true**
- 扩展没运行：去 `edge://extensions/` 确认扩展是「已启用」，必要时点「重新加载」
- 扩展刚装好还没进入过页面：点一次扩展图标让 service worker 启动
- 也可以直接点弹窗里的「刷新数据」

**service worker 是不是会休眠导致不同步？**
拉取模式下不用操心：service worker 一启动就进入长轮询待命；即使被回收，
`keepalive` alarm 也会在 1 分钟内把它重新拉起来。

**想同步到另一台机器 / 局域网**
中继默认只监听 127.0.0.1。用 `HOST=0.0.0.0 PORT=8788 node relay/server.mjs` 可对外监听，
但请自行评估暴露风险并配置好令牌与防火墙。

## 测试

```bash
node test/smoke.mjs       # URL 解析 + 快照组装 + 中继
node test/pull-smoke.mjs  # 拉取模式端到端（模拟扩展）
node test/mcp-smoke.mjs   # MCP 协议 + 工具调用
```

三个测试都会**启动独立的中继实例**（独立端口、数据目录、令牌），不会污染你正在跑的中继，
也不会和真实浏览器扩展抢响应。

## 隐私

所有数据都留在你自己的机器上：中继只监听 `127.0.0.1`，快照写到本地 `data/` 目录，
没有任何外发请求。扩展只读取 GitHub 标签页的 URL 与标题（这也是 `tabs` 权限的唯一用途），
并在设置页里可用「排除规则」按行过滤不想采集的 URL。

像素字体为 Fusion Pixel（MIT + OFL），许可文件在 `extension/fonts/OFL.txt` 与 `extension/fonts/LICENSES/`。

## License

本项目代码以 [MIT](LICENSE) 许可发布。内置像素字体适用各自的第三方许可（OFL / 随附许可），
不适用本项目的 MIT，详见 `extension/fonts/` 下的许可文件。
