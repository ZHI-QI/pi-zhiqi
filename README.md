# pi-zhiqi

把 [pi.dev 的包目录](https://pi.dev/packages)搬进 pi 的 TUI：搜 → 选 → 装到当前项目，一条命令一步到位。
**结果描述自动翻成简体中文**，中文关键词也能用。

```
/zhiqi 流程图
/zhiqi mermaid --type=extension
```

```
────────────────────────────────────────────────────────────
 pi.dev · mermaid
 16 命中 / 共 5643 个包 · 1-16 / 16 (of 5643)
→ pi-mermaid            2.2K · extension · 6mo ago · 在 TUI 里把 Mermaid 图表
  pi-obsidian           1.4K · package   · 4mo ago · 读写搜索 Obsidian 库，可
  visual-explainer      1.1K · package   · 18d ago · 生成 HTML 页面展示图表、di
 ↑↓ 选择 · 直接输入可过滤 · enter 装到当前项目 · esc 取消
────────────────────────────────────────────────────────────
```

回车 = `pi install npm:<包名> -l`（写进当前项目的 `.pi/settings.json`，pi 负责装到 `.pi/npm/` 并注册资源）。
装完执行 `/reload` 或重启 pi 生效。

---

## 性能：三条硬约束怎么做到的

你的要求是「性能要强、内存要极小、不影响 pi 打开速度」。对应的取舍：

| 约束 | 做法 | 实测 |
|---|---|---|
| **不影响启动速度** | 工厂函数里**只有一次 `pi.registerCommand()`**。没有顶层 IO、没有定时器、没有网络、不注册 tool/shortcut/event | jiti 冷转译 + 加载两个文件 = **2.8ms** |
| ^ | **不注册 tool** 是刻意的：tool 会进 system prompt，等于给**每一轮对话**都加 token | — |
| **内存极小** | 零运行时依赖，只用 `node:*` 内建 + 全局 `fetch`；解析完立刻丢掉 HTML，只留必要字段 | 常驻就是一份模块，缓存文件 12KB |
| ^ | 解析用「一次 `indexOf` 切卡 + 预编译正则逐卡提取」，不引 cheerio/jsdom（省掉几十 MB node_modules 与解析树） | 解析 202KB 页面 = **0.86ms** |
| **网络/模型只在按键之后** | 搜索、翻译、安装全部发生在命令 handler 里；结果与译文都落盘缓存 | 缓存命中时一次 `/zhiqi` 的本地成本 ≈ 一次 `readFile` |

进程级对照（`pi -ne -p "/zhiqi …"`，各 8–10 次）：

```
不装扩展                         min=0.556s  median=0.575s
装 pi-zhiqi（缓存命中）          min=0.581s  median=0.603s
装一个 200 字节的空扩展          min=0.606s  median=0.645s   ← 比本插件还慢
```

结论：**本扩展的加载成本落在 pi 进程启动时间（约 0.6s）的噪声里，测不出来**。冷启动那次 2.2s 全是 pi.dev 的页面下载。

自己复现：`npm run bench`

---

## 安装

```bash
pi install npm:pi-zhiqi                      # 从 npm（推荐）
pi install git:github.com/ZHI-QI/pi-zhiqi    # 从 GitHub
pi install /path/to/pi-zhiqi                 # 从本地 checkout
pi -e /path/to/pi-zhiqi/extensions/zhiqi.ts  # 试用，不写配置
```

默认装到**用户级**（所有项目都能用 `/zhiqi`）；加 `-l` 装到**当前项目**（写 `.pi/settings.json`，可随仓库共享）。

`npm:` 与 `git:` 两种装法功能一致 —— 本包**没有构建产物**，`extensions/*.ts` 就是运行时（pi 用 [jiti](https://github.com/unjs/jiti) 直接加载 TypeScript）。
运行时零第三方依赖：`@earendil-works/pi-*` 在 `peerDependencies` 里声明为 `*`，由 pi 自己提供，**不随包分发**。

> 用国内 npm 镜像时，安装不会计入官方下载量：
> ```bash
> npm_config_registry=https://registry.npmjs.org pi install npm:pi-zhiqi
> ```

## 用法

```
/zhiqi <关键词> [选项]

  --type=extension|skill|theme|prompt   只看某一类资源
  --sort=downloads|recent|name          排序（默认 downloads）
  --page=N                              第 N 页（每页 50 条，服务端上限）
  --limit=N                             展示条数，默认 50（= 1 页），上限 200；超过一页会自动翻页
  --en                                  不翻译，直接看英文原文（不调模型）
  --fresh                               跳过缓存，强制重新拉取
  --dry                                 只打印安装命令，不真的执行
  --json                                print 模式下输出 JSON（含中文译文）
  --clear                               清空搜索结果缓存与译文缓存
```

- 不带关键词会弹输入框。
- 选择器里**直接打字就能过滤**（SelectList 自带增量搜索）。
- 搜索结果缓存：`$PI_CODING_AGENT_DIR/zhiqi-cache.json`（默认 `~/.pi/agent/`），TTL 10 分钟，可用 `ZHIQI_CACHE_TTL_MS` 覆盖。

### 命中 109 条，为什么只看到 50 条？

pi.dev 服务端**一页最多 50 条**。所以：

```
pi.dev 目录 · "收集资料" → research · 显示 50 / 109 命中 / 共 5645 个包
                                        └─ 标题会明写「展示了多少 / 命中多少」

/zhiqi 收集资料 --limit=109     # 自动顺序读 3 页（约多花 2-3 秒网络）
/zhiqi 收集资料 --page=2        # 或者自己翻页
```

- `--limit` 默认 = **50（正好一整页）**，所以默认不会再有“偷偷截掉一半”的感觉。
- 要更多就 `--limit=200`（上限 = 4 页），实现上会**先读第 1 页拿到命中数、再算要翻几页**——命中很少时依旧只请求一次。
- 多页之间按包名去重，并且是**先合并原始页、再整体重排一次**（否则第 3 页的强匹配会永远排在第 1 页弱匹配后面——这是修过的真 bug）。
- 选择器底部那个 `(4/25)` 是**滚动位置**（当前停在第 4 条，共 25 条），不是“只剩 25”。`↑↓` 可以翻。

### 中文

pi.dev 目录**只索引英文** name/description/keywords，所以插件在**两个方向**都做中文适配。

**① 关键词方向**：中文关键词在 pi.dev 上必然 0 命中（实测「流程图」→ `0 / 5643`）。
所以「含中文 + 命中 0 条」时，先用模型把关键词翻成英文（最多 3 个候选，取命中最多的一次）再重搜：

```
$ pi -p "/zhiqi 流程图 --limit=2"
pi.dev 目录 · "流程图" → flowchart · 2 命中 / 共 5643 个包
```

**② 描述方向**：结果里的英文描述会被翻成简体中文再展示（**默认开启**）。

```
$ pi -p "/zhiqi mermaid --limit=1"
pi.dev 目录 · "mermaid" · 16 命中 / 共 5643 个包
 1. pi-mermaid  [extension]  2.2K/mo  6mo ago
    在 TUI 里把 Mermaid 图表渲染成 ASCII
    EN: 🧜‍♀️ Pi extension that renders Mermaid diagrams as ASCII in the TUI
    pi install npm:pi-mermaid -l
```

关键点：**译文按「包名 + 描述哈希」永久缓存**在 `~/.pi/agent/zhiqi-zh.json`。
同一个包一辈子只花一次 token —— 之后不管搜多少次、换什么关键词、换哪个项目，都是缓存命中、零模型调用。
描述变了（包更新了简介）会自动换 key，不会串用旧译文。

代价与兜底（数字都是实测，不是估算）：

| 情况 | 行为 | 实测 |
|---|---|---|
| 已缓存 | 零模型调用 | 109 条 → **7.5s**（全部是 pi 启动 + 页面下载） |
| 首次翻译 ~4-25 条 | 1 块 | ~4-5s |
| 首次翻译 ~50 条（默认） | 2 块并发 | ~7-10s |
| 首次翻译 109 条（`--limit=109`） | 5 块，4 并发 | ~22-30s（随 provider 负载波动） |
| 模型不可用 / 没登录 | 回退显示英文原文 + 提示一句，**不阻断搜索** | — |
| 模型卡住 | 25 秒超时后回退英文，不会把 `/zhiqi` 挂死 | — |
| 模型少给几条 | 缺的那几条显示英文，其余照常显示中文 | — |
| 不想要中文 | `--en` | — |

关于速度的三个实测结论：

1. **单次调用有 ~4-5s 固定延迟**，所以翻 4 条和翻 22 条的总耗时差不多。
2. **成本主要在条数上**（≈0.3s/条），不是并发上：同一批 109 条，并发 1 = **52.6s**，并发 6 = **30.2s** —— 并行有效但被 provider 排队限流，只有 ~1.7x。所以当前取 25 条/块 × 4 并发（比 12 条/块 × 6 并发更快，因为少了很多次固定开销）。
3. 所以**译文永久缓存**才是关键：同一个包一辈子只翻一次。日常重复搜索成本 = 0。

解析模型回复是**宽容三轮降级**：整段 JSON → 逐对正则（JSON 被写坏时）→ 编号行；任何一轮拿到就用。
全部失败就回退英文 —— 宁可不翻，不能让「翻译失败」变成「什么都搜不到」。

## 已知边界（都是有意选的，不是没做）

- **非 TUI 模式没有选择器**：`print` 模式打印纯文本清单（可 `--json`），`rpc`/`json` 模式只发一条通知（避免污染 stdout 上的协议流）。中文翻译三种模式都生效。
- **服务端过滤是模糊匹配**：搜 `diagram` 会混进只在描述/关键词里命中的包。所以本地做了一次重排 —— 名字里真含关键词的排前，同桶内再按下载量。
- **依赖 pi.dev 的 HTML 结构**：没有 JSON API（`/packages.json`、`/api/packages` 都不存在），只能解析服务端渲染的 HTML。改版时 e2e 里的「改版哨兵」会先炸，不会安静地返回 0 条。
- 解析只取 `?page=` 单页（最多 50 条）。

## 验证情况（哪些验了、哪些没验）

| 层 | 覆盖 | 结果 |
|---|---|---|
| 真实类型对账 | `tsc --noEmit`，对真实 `@earendil-works/pi-coding-agent@0.85.1` 类型 | 0 错 |
| 单元测试 | 44 个，全部打在**真实抓取的 pi.dev 页面**上（`test/fixtures/`） | 44/44 |
| 负向对照 | 故意改坏解析器（卡片标记 / 下载量属性名 / 描述节点）、给译文解析喂垃圾 | 改卡片标记 → 8 个失败、`exit 1`；喂垃圾 → 一条都解析不出来；恢复 → 全绿 |
| 端到端（网络） | 真拉 pi.dev、真解析、`type=extension` 过滤、中文 0 命中的前提 | 4/4 |
| 端到端（真 pi + 真 pty） | 真的把 pi 跑起来 → 输入 `/zhiqi` → 选择器画出来 → 回车选中 → 出安装命令 | 1/1 |
| **真模型**（手动） | 真模型会不会给出可解析的中文（**mock 永远测不出来**）：关键词翻译、描述翻译、译文缓存、109 条多页自动翻页 | 通过 |
| **未验** | **真的执行 `pi install` 并落盘 `.pi/settings.json`** | e2e 用 `--dry` 验到「选中→正确的安装命令」为止，**装机动作本身没有自动化测试** |

跑法：

```bash
npm install          # devDependencies 会拉真实 pi 包（约 184MB，仅开发者需要）
npm test             # typecheck + 44 个单测（离线，秒级）
npm run test:e2e     # 真实网络 + 真实 pty（约 70 秒）
npm run bench        # 性能数字
```

真模型那两条手工验法（会花少量 token，见 `test/e2e/README.md`）：

```bash
pi -p "/zhiqi 流程图 --limit=2"          # 期望标题是 "流程图" → <英文关键词>
pi -p "/zhiqi mermaid --limit=3"         # 期望看到中文说明 + EN: 原文
pi -p "/zhiqi mermaid --limit=3"         # 第二次：应命中译文缓存，明显更快
pi -p "/zhiqi 收集资料 --limit=109"      # 期望真给 109 条（自动翻 3 页）
```

> devDependencies 里装的是**真实** `@earendil-works/pi-coding-agent@0.85.1`（约 184MB）。
> 它同时出现在 `peerDependencies`（`*`）与 `devDependencies`（`^0.85.1`）：运行时由 pi 提供，开发时用来对**真实类型**做对账。
> 从 npm 装 pi-zhiqi 的用户不会拿到这 184MB —— pi 用生产安装（`npm install --omit=dev`）。

## 目录

```
extensions/catalog.ts   纯逻辑层：零 import，URL 构建 / HTML 解析 / 重排 / 译文 prompt 与宽容解析 / 文本处理
extensions/zhiqi.ts     扩展入口：命令注册 + 网络 + 两级缓存 + TUI + 安装
test/                   单测 + 真实页面 fixture
test/e2e/               真实网络 / 真实 pty 端到端（含踩坑记录）
bench/                  性能基准
.github/workflows/      发布到 npm（Trusted Publishing，免 token）
```

## 发布到 npm

发布由 `.github/workflows/npm-publish.yml` 负责，认证走 **Trusted Publishing(OIDC)—— 不需要任何 npm token**。

- 打 GitHub Release → 自动发布（先跑 typecheck + 44 个单测，再校验 tag/版本一致、防重复发布、校验包内容含 `extensions/*.ts`）
- 手动 `workflow_dispatch` → 默认只做 `npm publish --dry-run`

### 首次使用前：在 npmjs.com 配一次 Trusted Publisher

打开 <https://www.npmjs.com/package/pi-zhiqi/access> → Trusted Publisher → GitHub Actions，填：

| 字段 | 值 |
|---|---|
| Organization or user | `ZHI-QI` |
| Repository | `pi-zhiqi` |
| Workflow filename | `npm-publish.yml`（只填文件名，不带路径） |
| Allowed actions | 勾上 `npm publish` |

这个动作本身需要 2FA，**只能人工在网页上做**。配好之后 workflow 里的 `id-token: write` 就是全部所需权限 —— 故意不存 `NPM_TOKEN`。

### 发一个版本

```bash
npm version minor          # 只改 package.json 版本 + 打 tag，不发布
git push && git push --tags
# 然后在 GitHub 上基于该 tag 建 Release → workflow 自动发布
```

## 安全

安装动作执行的是 `pi install npm:<包名> -l`，即在当前项目下装第三方代码。
pi 包以你的完整系统权限运行 —— 选择器里看到的是 pi.dev 上的公开包名，**装之前请自己确认来源**。
带 `--dry` 可以只看命令不执行。
