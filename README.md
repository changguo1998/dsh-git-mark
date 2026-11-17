# dsh-git-mark

在 DSH 的 **Markdown 文档预览**里，标注当前工作区文件**相对上次提交（HEAD）**的改动：

| 情形 | 视觉 |
|---|---|
| 改动的词/字 | 删掉的部分 `~~红删除线~~`，新增的部分 `绿色非斜体` |
| 新增的整行 | 绿色非斜体 |
| 删除的整行 | 该行原文以红色删除线重现为独立段落 |
| 未跟踪文件（`??`） | 整份按行标绿 |
| 无改动 / 非 git 仓库 / 没有 git | 不显示任何标注，也不报错 |

磁盘上的 `.md` **永远不会被改写**：标注只加在「交给渲染器的内存文本副本」上。

## 结构

- `lib/index.js` — **host half**（Node ESM）。注册认证只读路由 `GET /api/dsh-git-mark?sessionId=&path=`，
  解析 Session 当前工作目录 → 先按**文档自身所在目录**、再按工作目录向上找 Git 工作树（因此工作区不是仓库、
  或文档位于嵌套仓库里都能正确判断）→ 只跑 `rev-parse` / `status --porcelain` / `diff HEAD --unified=0`
  （argv 数组、不走 shell、8 秒超时、stdout 上限、`cache-control: no-store`），返回行级改动事实。
- `lib/client.js` — **browser half**（`__ModuleLoader__` 装载产物，由 `tools/build-client.mjs` 生成）。
  以 `priority: 'extension'` 注册 `.md/.markdown` 的文档预览实现，占用 `sidebar.right.tab.document` 的 keyed 座位，
  用宿主自己的 `MarkdownText` 渲染；取回行级事实后做**字符级 LCS**，把 `~~…~~` / `*…*` 注入文本副本。
- `src/client/inject-core.js` — 纯函数核心（地址解析、图片路径、围栏跟踪、LCS 合并、标注注入），
  同时被 `lib/client.js`（内联）与单测（`src/client/inject.mjs` 包装）使用。
- `src/diff-parse.mjs` — 纯函数：解析 `@@ -a,b +c,d @@` hunk 与 `??` 状态。
- `cordis.patch.yml` — **只 insert 一行** `id: git-mark`，不覆盖任何宿主共享条目。

## 构建与自测

本仓库没有打包链（运行时是 `app.asar`），client half 是手写产物的拼接，改完 `src/client/*.js` 要重新生成：

```
node tools/build-client.mjs      # 生成 lib/client.js 与 src/client/inject.mjs
node test/run.mjs                # 61 项自测：解析、LCS、围栏、整行删除、真仓库端到端、挂载路由
```

没有 `node` 在 PATH 时，可用运行时的 Node：
`ELECTRON_RUN_AS_NODE=1 "<DSH 安装目录>/DeepSeek Harness.exe" tools/build-client.mjs`

## 安装

在插件管理面板用 `install_bundle`，spec 指向本目录（`file:` 形式或绝对路径）；安装需 danger-full-access 审批，
装完重启 DSH 客户端。安装前请按 `pitfall-memory` 技能为 `cordis.patch.yml` 做体检（本包只 insert 独有行 id）。

## 与 dsh-better-sidebar 的配合

better-sidebar 用自己的 Markdown 渲染器展示 `.md`（原生右栏里它还会以扩展级抢占所有文件地址）。本插件采用
**“生成标注副本”**方案，完全不动 better-sidebar 的默认行为：

1. 在 better-sidebar 的编辑器标题栏有一个按钮 **「Git 标注副本」**（只对 `.md/.markdown` 显示）；
2. 点击后，宿主把当前文件的**纯文本**做 git 标注注入：标签写成**字符实体**（`&#60;del data-gm="del"&#62;`
   与 `&#60;span data-gm="add"&#62;`，内容按字符级 LCS 合并并转义），写成混合 Markdown/HTML 文档到
   `<工作区>/.dsh/git-mark/<名字>.git-marked.md`（固定一个文件、每次覆盖；不修改原文件）；
3. 自动用 better-sidebar 打开这个副本——由 **better-sidebar 自己的渲染器**显示，完整 Markdown 语法
   （表格/代码高亮/KaTeX/mermaid 等）全部保留。宿主 `MarkdownText` 用 micromark 的 `html: 'safe'` 模式，
   **会把行内裸 HTML 标签整个剥掉**，而字符实体会被解码成字面文本——于是标签以文本形式进入渲染结果，
   better-sidebar 的行内 HTML pass 再把它换回真实的 `<del>/<span data-gm>` 元素；
4. 上色靠插件注入的样式（`[data-gm="add"]` / `[data-gm="del"]`），颜色用宿主语义 token
   `--dsw-alias-state-success-primary`（新增绿）与 `--dsw-alias-state-error-primary`（删除红，
   better-sidebar 自己的 diff 面板用的也是这两个），浅/深色主题自动适配；想改色可直接在
   better-sidebar 的「自定义 CSS」里覆盖这两个选择器。

非 git 仓库 / 无 git / 文件过大时按钮点击会提示无法生成，不写任何文件。

## 局限（已知并接受）

- 文档作者自己写的 `~~` 与 `*` 也会共享这套颜色 / 被去掉斜体。
- 宿主 `MarkdownText` 会剥掉行内裸 HTML，标注只能靠字符实体 + better-sidebar 的渲染管线显示；在 GitHub 等
  普通 Markdown 渲染器里打开那份副本，会看到字面实体文本（`&#60;del …&#62;`），而不是删除线。
- 整行删除只在**空行边界**或**空行本身**处重现；找不到安全边界就跳过该行（宁缺不误植）。
- 代码围栏（``` / ~~~）内一律不标注。
- 纯 client 改动需重装插件并重启，没有热更新。
