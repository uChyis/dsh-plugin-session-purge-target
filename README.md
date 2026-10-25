# dsh-plugin-session-purge-target

为 DSH / Harness 的会话菜单添加「删除会话」功能。

在会话「…」菜单中选择「删除会话」，并在确认框中再次确认，即可删除所选会话及其记录的子会话。

## 安装

### DSH Desktop

打开侧栏 **插件 → 添加插件**，输入：

```text
github:uChyis/dsh-plugin-session-purge-target
```

### Web / CLI

```sh
dsh plugin --profile <profile> add github:uChyis/dsh-plugin-session-purge-target
```

如果安装后功能没有出现，请完全退出并重新启动 DSH Desktop。

## 注意事项

- **删除不可撤销。** 会永久删除所选会话及其子会话的日志，请先备份需要保留的内容。
- 正在运行或存在活动任务的会话不能删除。
- 跨会话共享的附件不会随会话删除。
- 插件在 Host 进程中以当前用户权限运行，请只从可信来源安装。

## 兼容性

- 声明支持的 DSH 版本：`>=0.2.1-rc.3 <0.3.0`
- 已测试版本：`0.2.1-rc.3`
- 仅支持 JSONL 会话持久化后端。

## 卸载

在 DSH Desktop 的插件页面找到 `dsh-plugin-session-purge-target`，选择卸载。

## License

[MIT](LICENSE)
