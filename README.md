# dsh-plugin-session-purge-target

在 Harness Web / DSH Desktop 的会话「…」菜单中增加「删除会话」；点击后先确认，确认后永久删除该会话及其子会话。

## 行为

- 菜单项直接使用 Harness 原生 `MenuItemButton` 的 `danger` 变体与 `IconTrashOutlineRegular`：红色文字/图标，悬停使用原生 `--dsw-alias-interactive-bg-hover-danger` 浅红底，不使用灰色悬停。
- 如果某个宿主无法解析原生控件包，则退回到手写的同色菜单行。
- 插件不导出 `./icon`，插件列表使用 Harness 默认图标。
- 点击菜单项只打开确认框，不会直接删除；确认框显示会话标题，并说明子会话日志也会一并删除。
- 确认后由 Host 端执行删除：
  1. 会话必须存在；
  2. 不能有正在运行的 Agent/回合；仅驻留在内存但已空闲的 Agent 不阻止删除；
  3. 不能有进行中的回合、子代理、后台任务或定时提醒（Host 会列出具体活动）；
  4. 先把会话加入 Workspace 归档集合，使侧栏立即隐藏该行；
  5. 在 `$DSH_HOME/sessions/*/` 下按 `encodeSegment(sessionId)` 定位并删除会话目录，并递归删除 `origin: subagent` 且 `parentSession` 指向它的子会话目录（不删除 fork 等同辈谱系）；
  6. 删除对应的 `$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json` 派生投影缓存；
  7. 从每个 Workspace 的成员列表移除该 id，并从归档集合移除它；
  8. 只允许删除会话存储根目录内的目录，路径解析到根目录外时拒绝。
- 删除成功后会发出 `api-session/removed`；Workspace 成员变化与这个移除事件一起让行和它的驻留 Session 真正释放，已归档的会话也不会留下灰色空行。
- 删除失败且一个目录都没删掉时，会撤销第 4 步的归档，让会话重新可见。
- 删除成功或失败都会在确认框内给出结果；运行中的拒绝不会关闭对话框。对已经不存在但仍在列表里的灰色会话重试时，会清理 Workspace 成员/归档记账并发出移除事件，再显示「会话已不存在」。

## 为什么由插件删除文件

Harness 的 `sessionPersistence` seam 明确不提供删除 API（会话日志只追加，由带外维护清理）。因此本插件在 Host 进程里按 JSONL 后端的目录规则定位并删除会话自有目录，同时通过 `ctx.workspaceRegistry.archiveSession()` 让 UI 立刻反映删除。目录叶名使用与 `@deepseek-ai/dsh-session-persistence-jsonl` 相同的 `encodeSegment`；项目目录名不参与定位，因此即使日志头省略 `cwd` 也能找到实际目录。

## 安装与分享

本包没有构建步骤，也没有 npm 运行时依赖。DSH Desktop 的官方安装入口是侧栏 **插件 → 添加插件**：它接受 npm 包名、GitHub 仓库地址或本地目录路径。安装前请确认来源可信；插件在 Host 进程中以你的用户权限运行。

### GitHub（最简单）

把本目录作为仓库根（`package.json` 必须在根目录），提交并打 tag：

```sh
git init
git add .
git commit -m "dsh-plugin-session-purge-target v1.0.0"
git tag v1.0.0
git remote add origin git@github.com:uChyis/dsh-plugin-session-purge-target.git
git push -u origin main --tags
```

朋友在 Desktop 的插件页输入：

```text
github:uChyis/dsh-plugin-session-purge-target#v1.0.0
```

也可以直接输入 `https://github.com/uChyis/dsh-plugin-session-purge-target`。第三方 git 插件升级时，先在插件页卸载旧版，再安装新 tag。

Web/CLI profile 可以用命令行：

```sh
dsh plugin --profile <profile> add github:uChyis/dsh-plugin-session-purge-target#v1.0.0
```

DSH Desktop 不要使用 `dsh plugin --profile desktop`；Desktop 的包操作由客户端插件页负责。

### npm（更正式）

`dsh-plugin-session-purge-target` 目前查询未占用（`npm view dsh-plugin-session-purge-target` 返回 404）。发布前仍建议再确认一次：

```sh
npm publish --access public
```

朋友随后直接输入包名安装。如果发布前发现名字被占用，改用 scope；改名时必须同步修改三处：

- `package.json` 的 `name`
- `cordis.patch.yml` 中 `insert[0].name`
- `client.js` 中 `window.__ModuleLoader__.load({ id: ... })`

作用域名（如 `@YOURNAME/dsh-plugin-session-purge-target`）对 npm 和 Module Loader 都合法。

### 重名说明

- **GitHub 仓库名按 owner 唯一**：`uChyis/dsh-plugin-session-purge-target` 不会和别人的同名仓库冲突；安装时给朋友完整的 `github:uChyis/dsh-plugin-session-purge-target#v1.0.0`。
- **npm 包名是全局唯一的**：`dsh-plugin-session-purge-target` 当前未占用；发布前用 `npm view` 或插件页的检查确认。
- 旧的 `dsh-plugin-session-delete` 这个名字在 npm 上已被 [natsuki_cli 的插件](https://www.npmjs.com/package/dsh-plugin-session-delete)占用，不要再用它发布。

### 本地目录

把目录压缩后发给朋友，让他在插件页输入解压后的绝对路径；CLI profile 也可以用：

```sh
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-plugin-session-purge-target
```

本包声明了 `engines.dsh: ">=0.2.1-rc.3 <0.3.0"`，当前在 `0.2.1-rc.3` 上测试；朋友使用更老的 DSH 时需要先升级，使用 0.3 及以上版本时需要先确认兼容性（或用插件管理器的版本豁免）。

## DSH Desktop

DSH Desktop 使用同一个 `desktop` profile；窗口由 `dsh-app://app` 载入，除静态资源外的请求都会带上 Host 的 cookie 转发到同一个 Host，因此本插件的 Host 路由和客户端 bundle 在 Desktop 中同样可用。

如果插件是在 Desktop 进程启动之后才安装的，Desktop 的启动清单仍是旧快照：**完全退出并重新打开 DSH Desktop 一次**即可加载新客户端入口；不需要重新安装，也不需要改用 Web UI。

## 限制

- 附件（内容寻址、跨会话共享）不在此包里清理。
- 删除后 Workspace 成员与归档 id 会被主动移除；若某次写入失败，行仍会由移除事件去掉，残留 id 可在下一次重试或注册表剪除时清理。
- 不支持非 JSONL 的会话持久化后端；此时会明确返回 `unsupported-backend`。
- 仍需用户显式确认，属于用户操作，不提供 Agent 工具入口。

## License

MIT。`encodeSegment` 路径编码辅助函数源自 `@deepseek-ai/dsh-session-persistence-jsonl`（MIT，Copyright (c) 2026 DeepSeek），完整许可见 [LICENSE](LICENSE)。
