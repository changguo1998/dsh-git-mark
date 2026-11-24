# dsh-git-mark 插件实现方案（完整文档）

> 目标读者：在「创造模式」会话中接手本任务的 Agent。本文档自包含，无需依赖原始对话上下文。
>
> **现状说明**：下文是 v0.1 的设计草稿。实际实现后来改为「标注副本写入 `.dsh/git-mark/` 的镜像目录 +
> 副本就地刷新 + 自动刷新」，并以 README 为准；本文档只保留最初的调研结论与限制清单。

## 0. 一句话目标
在 DSH 的 **Markdown 文档预览**中，标注当前工作区文件**相对上次提交（HEAD）**的改动，全部实现在一个新插件包内，不改任何现有代码。

## 1. 视觉规格（已与用户确认，勿改）
| 情形 | 注入的 Markdown | 渲染成 | 最终视觉 |
|---|---|---|---|
| 删除的词/字 | `~~原词~~` | `<del>` | 红色删除线 |
| 新增的词/字 | `*新词*` | `<em>` | 绿色（**非斜体**，CSS font-style:normal） |
| 修改 | 同处 `~~删的~~` + `*加的*` 并排 | del + em | 红删绿增 |
| 整行删除 | 被删行原文注入为独立段 `~~原行内容~~` | `<del>` | 红色删除线行重现 |
| 未跟踪文件（??） | 整份按行标绿 | — | 全绿 |

- 数据语义：**磁盘上的当前文件 vs HEAD**（含已暂存+未暂存；未跟踪单独判定）。
- 磁盘上的 .md 文件**永不被修改**：注入只发生在「喂给 MarkdownText 的内存文本副本」上。

## 2. 实现机制（关键决策，已核实）
1. **数据获取（插件 host half）**：跑 `git diff HEAD --no-color --no-ext-diff --unified=0 -- <path>`，解析 `@@ -a,b +c,d @@` hunks，得到每个新行号的行级 kind（unchanged / modified / added / deleted）+ 新旧行文本；再跑 `git status --porcelain -- <path>` 判未跟踪。（说明：原草稿用 --word-diff=porcelain，实际改为**行级 diff + 客户端字符级 LCS** 生成增删范围，更稳。）
2. **渲染前注入（插件 client half）**：拿到 content.text 后，按行级信息做字符级 LCS 合并，产出带 `~~…~~` / `*…*` 的文本，再交给 MarkdownText 渲染。
3. **上色（插件注入 CSS）**：插件注入 `<style data-plugin>`，**引用宿主主题变量**（浅色 / .dark 两套自适应），不硬编码颜色：

```css
[data-document-markdown] del {
  color: var(--dsw-alias-file-diff-deleted-marker);
  text-decoration-color: var(--dsw-alias-file-diff-deleted-marker);
}
[data-document-markdown] em {
  font-style: normal;
  color: var(--dsw-alias-file-diff-added-marker);
}
```

## 3. 已核实的关键事实（避免重复调研）
- 文档预览渲染器 = dsh-client-ui-primitives 的 MarkdownText（编译进 @deepseek-ai/dsh-web-frontend bundle，未单独发布）。支持 `~~`→<del>、`*`→<em>、行内代码、表格、脚注、数学、shiki、KaTeX。
- **raw HTML 不会渲染成元素**：渲染器 case "html" 把字符串当 React 子元素 → 字面文本。因此**不能用 HTML 注入**做标注。
- 插件动态加载：client half 由 dsh-cordis-client-runner 在浏览器运行时评估；外部依赖按 external/redirect 解析。装插件**不用重建核心 bundle**。
- 主题 diff 语义色变量（dsh-client-ui-theme/src/styles/design-platform.css）：--dsw-alias-file-diff-added-marker、--dsw-alias-file-diff-deleted-marker、--dsw-alias-code-diff-added、--dsw-alias-code-diff-deleted（浅色+dark 两套）。
- 文档预览注册 API（镜像 dsh-client-ui-sidebar-documentpreview/src/client/markdown/index.ts）：ctx.documentPreviews.register({ id, extensions:['md','markdown'], priority:'extension', title, loading:'text-pages', wrap:false }) + ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({ name, key:<自己的id>, locale }, <Body>))。priority:'extension' 可压过内置 markdown 渲染器。
- 认证路由（镜像 dsh-client-ui-deliverables/src/present-open.ts）：ctx.connection.fetch.register({ path:'/api/git-mark', methods:['GET'], requestBody:'buffered', fetch })。
- 插件包格式：main: lib/index.js；exports 含 . / ./client / ./src/*；dsh.bundle.patch: ./cordis.patch.yml；dsh.client.inject 声明客户端依赖。**cordis.patch.yml 只 insert 自己的独特行 id，严禁覆盖宿主共享条目**（体检要求）。
- 当前运行环境 = 打包后的桌面运行时（app.asar），**无 esbuild/tsc 构建链**；v0.1 用**纯 ESM JS + React jsx() 手写**（不写 TSX），不需要构建。

## 4. 已建文件（骨架，位于工作区）
```
<workspace>/plugins/dsh-git-mark/
├─ package.json    包名 dsh-git-mark v0.4.0；main:lib/index.js；dsh.bundle.patch；dsh.client.inject
├─ cordis.patch.yml 只 insert 一行 id:git-mark name:dsh-git-mark
├─ README.md       安装/效果/局限简介
├─ PLAN.md         本文档
├─ lib/            待放产物：lib/index.js(host)、lib/client.js(client)
├─ src/            源码目录（host/ 与 client/ 子目录，见 §5）
└─ test/           自测脚本位置
```

## 5. 待实现代码要点
### 5.1 host half（src/host/ → lib/）
- resolveRepoRoot：从 session cwd 上溯找 .git（文件或目录，兼容 worktree）。
- 跑 git：**优先复用** @deepseek-ai/dsh-workspace-changes/src/git.ts 的 GitRunner（经 ./src/* 深度导入，已在依赖里声明）；或直接用 ctx.subprocess.spawn（argv 数组、timeout、stdout 上限，argv 不走 shell）。
- 解析 diff hunks → 每新行：{ line, kind, oldText?, newText? }。
- 未跟踪判定（git status --porcelain 输出 ??）。
- 路由 handler 入参：sessionId + workspace 相对 path；解析 session 工作区根（参考 deliverables 的 ctx.workspaceFiles.stat({ sessionId, workspaceRoot }, path) 模式，或 sessionQuery + fs）；返回 Response.json({ kind:'text', version, lines:[...] })；非 git/无 git → { kind:'not-git' }（cache-control: no-store）。
- 只读命令 + 路径限定在工作区/session 内 + timeout + 输出上限（安全要求）。

### 5.2 client half（src/client/ → lib/）
- apply(ctx)：注册 documentPreviews + slot body + 注入 CSS（作用域容器 [data-document-markdown]）。
- Body 组件（React jsx() 手写，不用 TSX）：接收 DocumentPreviewProps；用 content.text（累计文本）+ useResource 得 absolutePath；用 parseFileAddress 从 dsh-resource://file/session/<sid>/<path> 得出 sessionId+path；fetch /api/git-mark；调 inject() 生成注入文本 → 交给 MarkdownText（labels 提供最小集：copyLabel/copiedLabel/codeToolbar(标题/换行/取消换行)/footnotes）。
- inject.js（纯函数，可单测）：
  - 按 \n 分行；跟踪代码围栏状态（fence 内不注入）。
  - modified：oldText vs newText 做**字符级 LCS**（按 Unicode 码点，中文逐字）→ 合并文本：删除段 `~~…~~`、新增段 `*…*`、未变原样；用合并文本整行替换。**表格行例外**（行首 `|`）：先按 `|` 分段、逐段 del/add、`|` 分隔符保持裸奔（`mergeTableRow`）；**分隔行**（每段都是 `:?-+:?`）永不标注。这样加列/删列/改单元格都不会把 `|` 关进标记导致整表失效。
  - added：整行包 `*…*`；若行首像块语法（#、>、- 、列表序号、围栏等）则跳过该行（最小守卫）。
  - deleted（整行删）：在**空行分隔的安全边界**插独立段 `~~原行内容~~`；非安全边界跳过。
  - 刷新：content 文本变化重算注入；文件 version 变化重拉 git 数据。
  - 注入目标永远是「原始文本 + 行号信息」重算，不累计。

### 5.3 CSS（见 §2-3），作用域 [data-document-markdown]。

### 5.4 自测
- test/ 下用原生 node 跑：diff hunks 解析、LCS 合并（含中文）、fence 守卫、整行删除锚点。
- 需要 git：可在 test 下建临时仓库（git init + 提交 + 改文件）验证真实输出格式。

## 6. 安装与验证
1. **体检**：读本包 cordis.patch.yml——只 insert git-mark 一行，未覆盖任何共享条目 → 安全可装。
2. 安装：`plugin_manager install_bundle`，spec 用 file:<plugins/dsh-git-mark 的绝对路径>（或先打包 zip）；**需要 danger-full-access 审批**（装进 profile，宿主代码在沙箱外运行）。
3. 重启 DSH（client 动态插件加装后重启最稳）。
4. 验证清单：
   - 有 git 仓库 + 未提交改动：打开 .md 预览 → 删除词红删除线 / 新增词绿字非斜体 / 整行删除红删除线行 / 未跟踪全绿。
   - 无改动：不显示标注。
   - 非 git 仓库或没有 git：无标注、无报错。
   - 磁盘 .md 文件 hash 与打开前一致（未被修改）。
5. 若安装遇到格式问题：查 dsh-doc（dsh-agent-preset/skills）或镜像 @deepseek-ai/dsh-deepseek-chat-import（bundle patch 范例）与 @deepseek-ai/dsh-client-ui-message-feedback（dsh.client 范例）。

## 7. 已知限制（已与用户确认接受）
- 文档中作者自己写的 `~~` 与 `*` 会共享颜色 / 被去斜体（用户明确接受，这两种格式他很少用）。
- raw HTML 无法用于标注（渲染器不解析成元素）。
- client 改动需要重装插件 + 重启，没有热更新。
- 整行删除若锚点不在空行边界则跳过。
- 表格行按 `|` 分段标注；被删整列无位置可展示红色；只改分隔行（如列对齐）无任何标注。
- v0.1 为纯 JS 无 TS 类型；无 esbuild/tsc 构建链的环境下不需要构建。

## 8. 参考资料（源码位置，仅供实现比对，勿修改）
- MarkdownText 渲染逻辑（del/em/html 分支）：D:\Softwares\dsh\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-web-frontend\dist\assets\index-Ciz7DZxv.js
- 文档预览注册范式：…\dsh-client-ui-sidebar-documentpreview\src\client\markdown\index.ts 与 MarkdownBody.tsx
- 认证路由范式：…\dsh-client-ui-deliverables\src\present-open.ts
- GitRunner / 仓库定位：…\dsh-workspace-changes\src\git.ts
- 主题颜色变量：…\dsh-client-ui-theme\src\styles\design-platform.css
- 插件包格式范例：…\dsh-client-ui-message-feedback\package.json、…\dsh-deepseek-chat-import\cordis.patch.yml
- 插件体检验收要点：pitfall-memory 技能（只 insert 自己独特行 id）
