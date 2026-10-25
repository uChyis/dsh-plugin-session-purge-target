# dsh-plugin-session-purge-target

**当前版本：`v1.0.1`**

在 Harness Web / DSH Desktop 的会话「…」菜单中增加「删除会话」；点击后先确认，确认后永久删除该会话及其记录的子会话。

## 安装

DSH Desktop 的官方入口是侧栏 **插件 → 添加插件**，支持 npm 包名、GitHub 仓库地址和本地目录。

**GitHub（当前）**

仓库：[uChyis/dsh-plugin-session-purge-target](https://github.com/uChyis/dsh-plugin-session-purge-target)

在插件页输入：

```text
github:uChyis/dsh-plugin-session-purge-target#v1.0.1
```

当前发布版本为 `v1.0.1`。npm 尚未发布；不要用裸包名安装。

**本地目录**

把仓库目录（或解压后的 zip）路径填入插件页：

```text
C:\path\to\dsh-plugin-session-purge-target
```

Web/CLI profile 也可以用：

```sh
dsh plugin --profile <profile> add github:uChyis/dsh-plugin-session-purge-target#v1.0.1
```

本包没有构建步骤和 npm 运行时依赖。安装后如果 Desktop 的启动清单还是旧快照，**完全退出并重开一次 Desktop**。

## 卸载

在插件页找到 `dsh-plugin-session-purge-target`，点卸载。Web/CLI profile 也可从 profile 的依赖和 `dsh.profile.bundles` 中移除该项目。

卸载插件不会恢复已经删除的会话，也不会自动删除会话数据；删除本身是不可逆的。

## 兼容性

- 声明：`engines.dsh: ">=0.2.1-rc.3 <0.3.0"`。
- 当前在 `0.2.1-rc.3` 上测试。
- 更老的 DSH 会被拒绝安装；`0.3.0` 及以上需要先确认兼容性，或在插件管理器里按版本做显式豁免。
- 只支持暴露 JSONL 会话目录的持久化后端；其他后端会返回 `unsupported-backend`。

## 不可逆警告

确认删除后会永久移除：

- 该会话的本地日志目录；
- 它在 `origin: subagent` 关系下记录的子会话日志；
- 对应的投影缓存；
- Workspace 成员关系和归档记录。

**没有撤销。** 附件是内容寻址、跨会话共享的，不会随会话删除；需要保留的内容请先备份。插件在 Host 进程中以你的用户权限运行，只从可信来源安装。

## 行为

- 会话行的「…」菜单使用宿主原生危险色菜单项和垃圾桶图标；插件列表使用默认图标。
- 点击菜单只打开确认框；在确认框中再次点「删除」才会调用 Host。取消或关闭确认框不会发送删除请求。
- 删除前检查：
  - 会话必须存在；
  - 不能有 `status === 'running'` 的 Agent；仅驻留内存但空闲的 Agent 不阻止删除；
  - 不能有进行中的回合、子代理、后台任务或定时提醒；Host 会列出具体活动。
- 删除顺序：先删除所有记录的后代子会话，最后删除用户选中的父会话。这样父会话不会在子会话失败前先消失。
- 删除成功后：
  - 清理已删除会话的投影缓存；
  - 从每个 Workspace 移除该会话成员，并移出归档集合；
  - 发出 `api-session/removed`，让侧栏行和驻留 Session 一起释放。
- 删除部分失败时：
  - 如果父会话的日志仍然存在，撤销本次归档（除非它删除前就已经在归档区），保留 Workspace 成员，不发移除事件；失败结果会列出已删除的会话/目录、失败的会话/目录和仍存在的父会话标记，用户可以直接重试。
  - 如果父会话日志已经不存在，则清理 Workspace 记账并发出移除事件，避免留下灰色幽灵行；失败结果仍会报告孤立的子会话。
  - 对已经不存在、但仍停留在列表里的会话重试时，会清理成员/归档记账、发移除事件，并返回 `session-not-found`。
- 文件名使用与 JSONL 持久化层相同的 `encodeSegment`；项目目录只用于定位，日志头省略 `cwd` 时也能找到实际目录。
- 只递归删除 `origin: subagent` 且 `parentSession` 指向父会话的后代；fork 等同辈谱系不会被误删。
- 会话目录是符号链接（包括 Windows junction）时会拒绝删除并恢复到删除前的归档/可见状态；解析到存储根目录外的路径也会被拒绝。

## 实现说明

Harness 的 `sessionPersistence` seam 不提供删除 API，会话日志只追加。因此本插件在 Host 进程里：

1. 用 `sessionPersistence.stat/list` 找到目标会话和记录的后代；
2. 把目标加入 Workspace 归档集合，让侧栏立即隐藏；
3. 在 `$DSH_HOME/sessions/*/` 下按 `encodeSegment(sessionId)` 定位目录，按后代优先的顺序删除；
4. 删除对应的 `$DSH_HOME/storages/session_projcache/sessions/<id>.json`；
5. 成功后从 Workspace 成员/归档集合移除，并用 `api-session/removed` 通知 Client。

Host RPC 通道为 `/dsh-plugin-session-purge-target`；Cordis loader 条目 id 为 `session-purge-target`。客户端 bundle 只从 `react` 和宿主提供的 UI primitives 取依赖。

## 测试

在仓库根目录运行（Node 20+）：

```sh
node test/delete.test.mjs
node test/client.test.mjs
```

或者：

```sh
pnpm test
```

Host 测试覆盖正常删除、父会话已归档、运行中 Agent 拒绝、空闲驻留 Agent 成功、活动拒绝、缺失会话清理、目录缺失、归档回滚、无 `cwd`、项目目录扫描、子会话递归但不误删 fork、路径穿越、符号链接防护，以及「子会话删除失败后父会话保持可见并可重试」。Client 测试覆盖菜单和确认框结构、取消不发 RPC、原生菜单项以及错误/成功状态。

## 分享与发布

- GitHub 仓库：`https://github.com/uChyis/dsh-plugin-session-purge-target`
- 当前标签：`v1.0.1`，包含本次质量修复；`v1.0.0` 保留为上一版。
- npm：**尚未发布**。发布前先确认 `dsh-plugin-session-purge-target` 仍未被占用；发布时不要把未发布的包名写成当前安装方式。
- 发布修复时：提交代码、打与代码对应的新 tag、推送后再更新安装示例。安装固定 tag 只包含打 tag 时的代码。
- 若发布到 npm 或改包名，必须同步三处：
  - `package.json` 的 `name`
  - `cordis.patch.yml` 中 `insert[0].name`
  - `client.js` 中 `window.__ModuleLoader__.load({ id: ... })`

## DSH Desktop

DSH Desktop 使用同一个 `desktop` profile；窗口由 `dsh-app://app` 载入，除静态资源外的请求都会带上 Host 的 cookie 转发到同一个 Host。插件是在 Desktop 启动之后安装的，启动清单仍是旧快照；**完全退出并重新打开一次**即可加载新客户端入口。

## 限制

- 附件（内容寻址、跨会话共享）不在此包里清理。
- 删除后 Workspace 成员与归档 id 会被主动移除；若某次写入失败，行仍会由移除事件去掉，残留 id 可在下一次重试或注册表剪除时清理。
- 失败后的归档回滚是 best-effort；如果 `unarchive` 本身失败，失败详情里的 `archiveRestored` 会是 `false`，行可能仍隐藏，需要重试或手动恢复。
- 不支持非 JSONL 的会话持久化后端；此时会明确返回 `unsupported-backend`。
- 仍需用户显式确认，属于用户操作，不提供 Agent 工具入口。

## License

MIT。`encodeSegment` 路径编码辅助函数源自 `@deepseek-ai/dsh-session-persistence-jsonl`（MIT，Copyright (c) 2026 DeepSeek），完整许可见 [LICENSE](LICENSE)。
