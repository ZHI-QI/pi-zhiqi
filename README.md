# pi-zhiqi

**中文** ｜ [English](#english)

> 在 pi 里搜 pi.dev 的插件：**中文关键词能搜，描述是中文，↑↓ 选，回车装进当前项目。**

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19-brightgreen.svg)](package.json)
[![CI](https://github.com/ZHI-QI/pi-zhiqi/actions/workflows/ci.yml/badge.svg)](https://github.com/ZHI-QI/pi-zhiqi/actions/workflows/ci.yml)
[![pi-package](https://img.shields.io/badge/pi--package-F09082.svg)](https://pi.dev/packages)

---

## pi.dev 有 5600+ 个包，你怎么知道该装哪个？

`pi install` 要的是**包名**。可名字从哪来？于是你离开 pi → 打开浏览器 → 翻目录 → 读英文描述 → 判断 → 复制包名 → 切回终端 → 敲命令。装一个包，来回七八步。

`/zhiqi` 把整条链路收进 pi：

| 原来的麻烦 | 现在 |
|---|---|
| 要开浏览器翻 pi.dev | 在 pi 里直接搜 |
| 想不起英文关键词 | **输入中文就行** —— 「流程图」自动翻成 `flowchart` 再搜 |
| 描述全是英文，看不懂 | **描述自动翻成简体中文**，永久缓存 |
| 要手打 `pi install npm:…` | ↑↓ 选、**回车即装** |
| 装哪了？会不会污染全局？ | 只写**当前项目**的 `.pi/settings.json`，随时 `pi remove` 撤回 |

## 30 秒上手

```bash
pi install npm:pi-zhiqi                          # 或：pi install git:github.com/ZHI-QI/pi-zhiqi
```

```
/zhiqi 流程图
```

```
────────────────────────────────────────────────────────────────────────────────────
 pi.dev · 流程图 → flowchart
 2 命中 / 共 5647 个包 · 1-2 / 2 (of 5647)
→ @senad-d/drawme        244/mo · extension · 16d ago · 用自然语言生成、校验并导出可编辑的 draw.io 图表
  @walterra/pi-graphviz  216/mo · extension · 20d ago · 把 Graphviz 的 DOT 图表渲染成内联图片
 ↑↓ 选择 · 直接输入可过滤 · enter 装到当前项目 · esc 取消
────────────────────────────────────────────────────────────────────────────────────
```

回车 → 执行 `pi install npm:@senad-d/drawme -l` → `/reload` 生效。

## 三条硬指标

**① 零运行时依赖。** 只用 Node 内建 + 全局 `fetch`，没有 cheerio / jsdom / axios。发布产物就是 **28.8 kB / 6 个文件**（两个 `.ts` + 文档）。

**② 零启动开销。** pi 的扩展在启动时加载，所以这里刻意做到极致：工厂函数里**只有一次 `registerCommand()`** —— 没有顶层 IO、没有定时器、没有网络，**不注册 tool**（tool 会进 system prompt，等于给**每一轮对话**都加 token）。

```
jiti 冷转译 + 加载两个文件              1 - 2.8ms
解析 202KB 目录页（50 条卡片）          0.86ms
装了它 vs 不装扩展（各 8-10 次）         差异落在噪声内
                                        不装        0.575s
                                        装了本插件  0.603s
                                        装个 200 字节的空扩展 0.645s ← 比本插件还慢
```

**③ 网络与模型只在按键之后。** 搜索结果缓存 10 分钟、译文永久缓存 —— 重复搜索的成本 ≈ 一次 `readFile`。

## 中文支持

pi.dev 目录**只索引英文** name/description/keywords，这是硬约束，所以两个方向都做了适配。

**关键词方向**：中文关键词在 pi.dev 上必然 0 命中（实测「流程图」→ `0 / 5647`）。所以「含中文 + 命中 0 条」时，先用当前模型翻成英文（最多 3 个候选，取命中最多的一次）再搜。

```
$ pi -p "/zhiqi 收集资料 --limit=3"
pi.dev 目录 · "收集资料" → research · 显示 50 / 109 命中 / 共 5647 个包
```

**描述方向**（默认开启）：一次模型调用把待展示的条目翻成中文。

```
$ pi -p "/zhiqi mermaid --limit=1"
 1. pi-mermaid  [extension]  2.2K/mo  6mo ago
    在 TUI 里把 Mermaid 图表渲染成 ASCII
    EN: 🧜‍♀️ Pi extension that renders Mermaid diagrams as ASCII in the TUI
    pi install npm:pi-mermaid -l
```

**译文按「包名 + 描述哈希」永久缓存**在 `~/.pi/agent/zhiqi-zh.json`：同一个包一辈子只花一次 token —— 之后不管搜多少次、换什么关键词、换哪个项目，都是缓存命中、零模型调用。不想要中文加 `--en`。

速度说实话（都是实测，不是估算）：

| 场景 | 耗时 |
|---|---|
| 已缓存（109 条） | **7.5s**（全是 pi 启动 + 页面下载，翻译为 0） |
| 首次翻 4-25 条 | ~4-5s |
| 首次翻 ~50 条（默认） | ~7-10s |
| 首次翻 109 条（`--limit=109`） | ~22-30s（随 provider 负载波动） |

- 单次模型调用有 **~4-5s 固定延迟**，所以翻 4 条和翻 22 条总耗时差不多；成本主要在**条数**（≈0.3s/条），不在并发。
- 同一批 109 条：并发 1 = **52.6s**，并发 6 = **30.2s** —— 并行有效但被 provider 排队限流，只有 ~1.7x。
- 兜底：模型不可用 / 没登录 / 25 秒超时 / 模型少给几条 → 一律回退显示英文原文，**绝不阻断搜索**。
- 解析模型回复是**宽容三轮降级**：整段 JSON → 逐对正则（JSON 被写坏时）→ 编号行。全部失败就回退英文。

## 用法

```
/zhiqi <关键词> [选项]

  --type=extension|skill|theme|prompt   只看某一类资源
  --sort=downloads|recent|name          排序（默认 downloads）
  --page=N                              第 N 页（服务端每页 50 条）
  --limit=N                             展示条数，默认 50（= 1 页），上限 200（超过一页自动翻页）
  --en                                  不翻译，直接看英文原文（不调模型）
  --fresh                               跳过缓存，强制重新拉取
  --dry                                 只打印安装命令，不真的执行
  --json                                print 模式下输出 JSON（含中文译文）
  --clear                               清空缓存（含译文）
```

- 不带关键词会弹输入框。
- 选择器里**直接打字就能过滤**（增量搜索）。
- 搜索结果缓存在 `$PI_CODING_AGENT_DIR/zhiqi-cache.json`，TTL 10 分钟，可用 `ZHIQI_CACHE_TTL_MS` 覆盖。

### 命中 109 条，为什么只显示 50 条？

pi.dev 服务端**一页最多 50 条**。标题会明写「展示了多少 / 命中多少」，不让你猜：

```
pi.dev 目录 · "收集资料" → research · 显示 50 / 109 命中 / 共 5647 个包
                                        └─ 想全要就 --limit=109
```

- `--limit` 默认 = **50（正好一整页）**，所以默认不会偷偷截掉一半。
- 要更多用 `--limit=200`（上限 4 页）。实现上是**先读第 1 页拿到命中数、再算要翻几页** —— 命中很少时仍然只请求一次。
- 多页之间按包名去重，并**先合并原始页、再整体重排一次**（否则第 3 页的强匹配会永远排在第 1 页弱匹配后面 —— 这是修过的真 bug）。
- 选择器底部的 `(4/25)` 是**滚动位置**（当前停在第 4 条、共 25 条），不是"只剩 25"，`↑↓` 能翻。

## 常见问题

**装到哪了？会不会动我的全局配置？**
只写**当前项目**的 `.pi/settings.json`（底层执行 `pi install npm:<包> -l`），包装在 `.pi/npm/` 下。不动全局。

**怎么撤掉？**
`pi remove npm:<包名>`（或删掉 `.pi/settings.json` 里那一行）。

**装完为什么没生效？**
新装的包**当前会话看不到**，敲 `/reload` 或开新会话。

**选择器里看到的是 pi.dev 的公开包名，安全吗？**
pi 包以你的完整系统权限运行 —— **装之前请自己确认来源**。想只看不装，加 `--dry`，它只打印命令。

**必须联网吗？**
搜索必须（要拉 pi.dev）；翻译要模型；但这两者都有缓存，命中后就是纯本地。

## 已知边界（都是有意选的，不是没做）

- **非 TUI 模式没有选择器**：`print` 模式打印纯文本清单（可 `--json`），`rpc`/`json` 模式只发一条通知（避免污染 stdout 上的协议流）。中文翻译三种模式都生效。
- **服务端过滤是模糊匹配**：搜 `diagram` 会混进只在描述/关键词里命中的包，所以本地做了一次重排 —— 名字里真含关键词的排前，同桶内再按下载量。
- **依赖 pi.dev 的 HTML 结构**：它没有 JSON API（`/packages.json`、`/api/packages` 都不存在），只能解析服务端渲染的 HTML。改版时 e2e 里的「改版哨兵」会先炸，**不会安静地返回 0 条**。
- 单次解析只取 `?page=` 一页（最多 50 条）。

## 它是怎么做到的

```
extensions/catalog.ts   零 import 纯逻辑层：URL 构建 / HTML 解析 / 重排 / 多页合并 / 译文 prompt 与宽容解析
extensions/zhiqi.ts     入口：命令注册 + 网络 + 两级缓存 + TUI + 安装
```

- **解析不用 DOM**：一次 `indexOf` 切卡 + 预编译正则逐卡提取。既没有解析树的内存峰值，也没有第三方依赖的加载成本。
- **缓存两级**：搜索结果 10 分钟 TTL + 译文永久，都是原子写（tmp + `rename`），写失败静默（缓存不是关键路径）。
- **模型调用有超时保险**：25 秒不动就回退英文，不会把 `/zhiqi` 挂死。

## 验证情况（哪些验了、哪些没验）

| 层 | 覆盖 | 结果 |
|---|---|---|
| 真实类型对账 | `tsc --noEmit`，对真实 `@earendil-works/pi-coding-agent@0.85.1` 类型 | 0 错 |
| 单元测试 | 44 个，全部打在**真实抓取的 pi.dev 页面**上（`test/fixtures/`） | 44/44 |
| 负向对照 | 故意改坏解析器（卡片标记 / 下载量属性名 / 描述节点）、给译文解析喂垃圾 | 改卡片标记 → 8 个失败、`exit 1`；喂垃圾 → 一条都解析不出来；恢复 → 全绿 |
| 端到端（网络） | 真拉 pi.dev、真解析、`type=extension` 过滤、中文 0 命中的前提 | 4/4 |
| 端到端（真 pi + 真 pty） | 真的把 pi 跑起来 → 输入 `/zhiqi` → 选择器画出来 → 回车选中 → 出安装命令 | 1/1 |
| **真模型**（手工） | 真模型会不会给出可解析的中文（**mock 永远测不出来**）：关键词翻译、描述翻译、译文缓存、109 条多页 | 通过 |
| 发布产物 | `npm pack` 真打包 → 解压 → 真 pi 加载 | 28.8 kB / 6 文件，通过 |
| 用户视角安装 | `pi -e git:github.com/ZHI-QI/pi-zhiqi` | 真 clone + 真加载，通过 |
| **未验** | **真的执行 `pi install` 并落盘 `.pi/settings.json`** | e2e 用 `--dry` 验到「选中 → 正确的安装命令」为止 |

```bash
npm install          # devDependencies 会拉真实 pi 包（约 184MB，仅开发者需要）
npm test             # typecheck + 44 个单测（离线，秒级）
npm run test:e2e     # 真实网络 + 真实 pty（约 70 秒）
npm run bench        # 性能数字
```

真模型那几条只能手工验（会花少量 token，详见 `test/e2e/README.md`）：

```bash
pi -p "/zhiqi 流程图 --limit=2"          # 期望标题是 "流程图" → <英文关键词>
pi -p "/zhiqi mermaid --limit=3"         # 期望中文说明 + EN: 原文
pi -p "/zhiqi mermaid --limit=3"         # 第二次：命中译文缓存，明显更快
pi -p "/zhiqi 收集资料 --limit=109"      # 期望真给 109 条（自动翻 3 页）
```

> devDependencies 里装的是**真实** `@earendil-works/pi-coding-agent@0.85.1`（约 184MB）。
> 它同时出现在 `peerDependencies`（`*`）与 `devDependencies`（`^0.85.1`）：运行时由 pi 提供，开发时用来对**真实类型**做对账。
> 从 npm 装 pi-zhiqi 的用户不会拿到这 184MB —— pi 用生产安装（`npm install --omit=dev`）。

## 发布到 npm

发布由 `.github/workflows/npm-publish.yml` 负责，认证走 **Trusted Publishing(OIDC)—— 不需要任何 npm token**。

- 打 GitHub Release → 自动发布（先跑 typecheck + 44 个单测，再校验 tag/版本一致、防重复发布、校验包内容含 `extensions/*.ts` 与 `NOTICE`）
- 手动 `workflow_dispatch` → 默认只做 `npm publish --dry-run`

**首次使用前**在 npmjs.com 配一次 Trusted Publisher：<https://www.npmjs.com/package/pi-zhiqi/access> → GitHub Actions，填 `ZHI-QI` / `pi-zhiqi` / `npm-publish.yml`（只填文件名），勾上 `npm publish`。这个动作需要 2FA，只能人工在网页上做；配好后 workflow 里的 `id-token: write` 就是全部所需权限（故意不存 `NPM_TOKEN`）。

发版：

```bash
npm version minor          # 只改 package.json 版本 + 打 tag，不发布
git push && git push --tags
# 然后在 GitHub 上基于该 tag 建 Release → workflow 自动发布
```

## 许可

[Apache-2.0](LICENSE) © 2026 王智琪 (ZHI-QI)

---

<a name="english"></a>

# English

**English** ｜ [中文](#pi-zhiqi)

> Search the pi.dev catalog from inside pi: **Chinese queries work, descriptions are Chinese, pick with ↑↓, press Enter to install into the current project.**

`pi install` needs a **package name**. Where do you get one? So you leave pi → open a browser → browse the catalog → read English descriptions → decide → copy the name → switch back → type the command.

`/zhiqi` collapses all of that into one step inside pi:

| The old way | With pi-zhiqi |
|---|---|
| Leave pi, browse pi.dev in a browser | Search right where you are |
| Can't recall the English keyword | **Type Chinese** — 「流程图」is auto-translated to `flowchart` |
| Descriptions are English-only | **Descriptions are translated to Simplified Chinese**, cached forever |
| Type `pi install npm:…` by hand | Pick with ↑↓, **Enter installs** |
| Where did it go? Global pollution? | Writes only **this project's** `.pi/settings.json`; undo with `pi remove` |

## Quick start

```bash
pi install npm:pi-zhiqi                          # or: pi install git:github.com/ZHI-QI/pi-zhiqi
```

```
/zhiqi flowchart
```

```
────────────────────────────────────────────────────────────────────────────────────
 pi.dev · flowchart
 2 hits / 5647 packages · 1-2 / 2 (of 5647)
→ @senad-d/drawme        244/mo · extension · 16d ago · Author, validate and export editable draw.io diagrams from natural language
  @walterra/pi-graphviz  216/mo · extension · 20d ago · Render Graphviz DOT diagrams as inline images
 ↑↓ select · type to filter · enter installs into this project · esc cancel
────────────────────────────────────────────────────────────────────────────────────
```

Press Enter → runs `pi install npm:@senad-d/drawme -l` → `/reload` to activate.

## Three hard guarantees

**① Zero runtime dependencies.** Node built-ins plus global `fetch` only — no cheerio, no jsdom, no axios. The published artifact is **28.8 kB across 6 files**.

**② Zero startup cost.** pi loads extensions at startup, so the factory function does exactly **one `registerCommand()`** — no top-level IO, no timers, no network, and deliberately **no tool registration** (tools go into the system prompt, i.e. they'd tax *every* turn).

```
jiti cold-transpile + load both files     1 - 2.8ms
Parse a 202KB catalog page (50 cards)     0.86ms
With vs without the extension (8-10 runs) delta is inside the noise
                                          without       0.575s
                                          with pi-zhiqi 0.603s
                                          a 200-byte stub extension 0.645s ← slower than this
```

**③ Network and model calls only happen after a keypress.** Search results cached for 10 minutes, translations cached forever — a repeat search costs about one `readFile`.

## Chinese support

The pi.dev catalog indexes **English only**, so both directions are adapted:

- **Query direction** — a Chinese query always returns 0 hits on pi.dev (measured: 「流程图」→ `0 / 5647`). So when the query contains CJK *and* yields nothing, the current model translates it into up to 3 English keywords and re-searches with the best-yielding one.
- **Description direction** (on by default) — one model call translates the items about to be displayed.

**Translations are cached permanently** (keyed by package name + description hash) in `~/.pi/agent/zhiqi-zh.json`: each package costs tokens exactly once, ever. Use `--en` to skip translation entirely.

Honest numbers, all measured:

| Scenario | Time |
|---|---|
| Cached (109 items) | **7.5s** (all pi startup + page download; translation is 0) |
| First translation, 4-25 items | ~4-5s |
| First translation, ~50 items (default) | ~7-10s |
| First translation, 109 items | ~22-30s (varies with provider load) |

A single model call has **~4-5s of fixed latency**, so translating 4 items costs about as much as 22; the real cost driver is **item count** (≈0.3s/item), not concurrency. For the same 109 items: concurrency 1 = 52.6s vs concurrency 6 = 30.2s — parallelism helps ~1.7x, throttled by the provider.

Fallbacks: model unavailable / not logged in / 25s timeout / model returns fewer items → the affected rows fall back to English. **Search is never blocked by translation failure.** Parsing model output degrades in three tolerant rounds (whole JSON → key-value regex → numbered lines).

## Usage

```
/zhiqi <query> [options]

  --type=extension|skill|theme|prompt   restrict to one resource type
  --sort=downloads|recent|name          sort order (default: downloads)
  --page=N                              page N (the server caps pages at 50 items)
  --limit=N                             items to show; default 50 (= 1 page), max 200 (auto-pages)
  --en                                  skip translation (no model call)
  --fresh                               bypass cache
  --dry                                 print the install command instead of running it
  --json                                JSON output in print mode (includes translations)
  --clear                               clear caches (search + translations)
```

- No query → an input dialog opens.
- Type inside the picker to filter incrementally.
- Search cache lives in `$PI_CODING_AGENT_DIR/zhiqi-cache.json` (TTL 10 min, override with `ZHIQI_CACHE_TTL_MS`).

## FAQ

**It says 109 hits but only shows 50?** The pi.dev server pages at 50. The header always states shown vs. hits, so nothing is hidden: `showing 50 / 109 hits`. Ask for more with `--limit=200` (it auto-pages, and reads page 1 first to know how many pages are needed).

**Will it touch my global config?** No. It runs `pi install npm:<pkg> -l`, which writes this project's `.pi/settings.json` only.

**How do I undo?** `pi remove npm:<pkg>`, or delete that line from `.pi/settings.json`.

**Installed but not working?** Newly installed packages are invisible to the current session — run `/reload` or start a new session.

**Is it safe?** pi packages run with your full system privileges. Use `--dry` to print the command without running anything, and verify sources yourself.

## Known boundaries (intentional, not missing)

- **No picker outside the TUI**: `print` mode prints a plain list (`--json` available); `rpc`/`json` emit a notification only, to avoid corrupting the protocol stream on stdout. Translation works in all three modes.
- **Server-side filtering is fuzzy** (searching `diagram` also returns packages that merely mention it), so results are re-ranked locally: names containing the query first, then by downloads.
- **It depends on pi.dev's HTML structure** — there is no JSON API (`/packages.json` and `/api/packages` both 404/501). A redesign trips a "sentinel" test in the e2e suite instead of silently returning zero results.
- One page per request (max 50 items), with optional auto-paging.

## Under the hood

```
extensions/catalog.ts   Pure logic, zero imports: URL building / HTML parsing / re-ranking / page merging / translation prompts
extensions/zhiqi.ts     Entry point: command registration + network + two caches + TUI + install
```

Parsing avoids a DOM entirely: one `indexOf` splits the cards, pre-compiled regexes extract each one. Two atomic caches (search + permanent translations), and a 25-second timeout guard on every model call.

## Verification

44 unit tests run against **real captured pi.dev pages** (never hand-written HTML), plus negative controls that must fail when the parser is deliberately broken, plus a real-pi real-pty end-to-end test. See the run commands above. The only untested path is the actual `pi install` execution — the e2e suite uses `--dry` and asserts on the generated command.

## License

[Apache-2.0](LICENSE) © 2026 王智琪 (ZHI-QI)
