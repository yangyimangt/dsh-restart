# dsh-restart

在 DeepSeek Harness 桌面端加一个「重启应用」入口：**侧边栏 → 更多 → 重启应用**。

点一下，弹确认框；确认后应用自己关掉再重新打开，不用去任务管理器或者托盘。

## 为什么需要它

DSH 桌面端没有重启入口。窗口左上角「应用」菜单里只有「退出」，退出之后还得自己再双击图标。改完插件、改了 profile、装完东西要生效时，这个来回很烦。

## 它是怎么做的

Electron 主进程的「应用」菜单在 `app.asar` 里，Cordis 插件够不到，所以这个插件不去碰原生菜单，而是：

1. 浏览器侧往 `sidebar.panellist.actions`（侧边栏「更多」菜单）注册一行；
2. 点击后向 Host 路由 `POST /dsh-restart/api/restart` 发请求；
3. Host 起一个**完全 detached** 的守护进程（`restart-helper.js`），然后立刻返回 `202`；
4. 守护进程等页面把响应收完，用 `taskkill /F` 结束 Electron 主进程（不带 `/T`——它自己就是这棵树的子孙，树杀会把自己一起带走）；
5. Host 的 IPC 通道断开后自行优雅退出；守护进程等它真没了、等端口释放；
6. 用同一个可执行文件重新拉起应用（启动前删掉 `ELECTRON_RUN_AS_NODE`，否则拉起来的会是 Node 而不是 App）。

整个过程写进 `%TEMP%\dsh-restart.log`。重启失败时那个文件是唯一线索——失败的进程没控制台可留。

## 安装

```bash
# 在 DSH 里
plugin_manager install_bundle E:\path\to\dsh-restart-plugin
```

或者手动：

```bash
cd ~/.dsh/profiles/desktop
pnpm add /absolute/path/to/dsh-restart-plugin
# 再把 "dsh-restart" 加进 package.json 的 dsh.profile.bundles
```

装完侧边栏「更多」里就会出现「重启应用」。

## 限制

- **只在 Windows 桌面端生效**。`dsh web` 里调用会返回 `409`，而不是去杀一个无关进程。
- 重启会**中断正在运行的任务**，确认框里写明了。
- 重启后**不会自动回到原来的会话**，要从侧边栏重新点开。
- 侧边栏会出现「更多」这一行（因为这个插件往里面注册了东西）。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | Host 侧：`/dsh-restart/api/{status,restart}` 路由，跨站写入防护 |
| `client.js` | 浏览器侧：菜单行 + 确认对话框（挂在 `shell.overlay`） |
| `restart-helper.js` | 独立的守护进程，负责杀进程 → 等端口 → 拉起 |
| `cordis.patch.yml` | 插件行声明 |
| `locale/*.json` | 插件管理页里的显示名 |

## 许可

MIT
