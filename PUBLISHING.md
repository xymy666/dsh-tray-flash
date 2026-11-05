> **状态（2026-11-05 完成）**：仓库已建、PR #12057 已提交且 CI 全绿、npm 0.5.0 已发布。
> 以下步骤保留作为记录。

# 发布步骤（需要你的账号）

仓库已经准备好，两个 commit 都在本地。剩下三步都要用你的 GitHub / npm 身份，
我无法代做。

## 1. 建 GitHub 仓库并推送

需要先装 GitHub CLI（当前机器没有）：

```powershell
winget install --id GitHub.cli
gh auth login
```

然后：

```powershell
cd "E:\0_opencode\.00工作空间\dsh-tray-flash"

# 建公开仓库并推送（仓库名用 dsh-tray-flash）
gh repo create dsh-tray-flash --public --source=. --push `
  --description "Blinks the Windows tray icon and taskbar button while a DSH session waits for you"
```

推完立即做两件事：

```powershell
# 1. 加 topic（规范要求）
gh repo edit --add-topic dsh-plugin,deepseek-harness,windows,tray

# 2. 把 package.json 里的 OWNER 换成你的用户名
#    见下面第 3 节
```

> ⚠️ **仓库必须满 1 天**才能过 CI 的年龄门槛。刚建的仓库会被拒，
> 第二天重新推一次即可（规范明确说重新提交没有影响）。

## 2. 发布到 npm

```powershell
cd "E:\0_opencode\.00工作空间\dsh-tray-flash"

# 先确认包名没被占
npm view dsh-tray-flash version

npm login
npm publish
```

如果 `dsh-tray-flash` 已被占用，改名后同步改 `package.json` 的 `name`
和 `cordis.patch.yml` 里的 `name:` 两处。

## 3. 把占位符换成真实值

`package.json` 里现在是占位符：

```json
"repository": { "type": "git", "url": "https://github.com/OWNER/REPO.git" }
```

改成你的真实地址。npm 包的 `repository` 必须指回被收录的那个仓库，
否则市场不会把两者关联起来。

## 4. 提交到插件列表

```powershell
# 克隆列表仓库
git clone https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
cd awesome-dsh-plugin

# 复制条目，去掉占位符
copy "E:\0_opencode\.00工作空间\dsh-tray-flash\scripts\submit-entry.yml" `
     "data\plugins\<你的用户名>__dsh-tray-flash.yml"

# 编辑那个文件：把每一处 <owner> 换成你的用户名，删掉文件顶部的注释块
```

然后提 PR。规范要点：

- **一个 PR 最多 3 条**（你只提交 1 条，没问题）
- **不要手工编辑 README**，它们由 `data/plugins/*.yml` 生成
- `url` 必须与仓库完全一致，CI 会比对
- 描述里**不能有营销词**

## 提交的条目长这样

```yaml
url: https://github.com/<owner>/dsh-tray-flash
name: <owner>/dsh-tray-flash
category: notify
description:
  en: Blinks the Windows notification-area icon between the app's own icon and a fully transparent frame, and flashes the taskbar button, when a turn finishes or a session waits for an approval or an answer. Keeps going while the session list still shows an unread or waiting dot.
  zh: 任务完成、或有会话在等你审批或回答时，让 Windows 通知区域的图标在「原图标 ⇄ 全透明」之间闪烁，同时闪任务栏按钮；侧边栏还挂着未读或等待的圆点就一直闪，点全部消失才停。
icon: https://raw.githubusercontent.com/<owner>/dsh-tray-flash/main/assets/icon-256.png
```

## 已核对的合规项

| 规范要求 | 状态 |
|---|---|
| `package.json` 声明 `dsh.bundle.patch` | ✅ |
| `cordis.patch.yml` 在仓库根 | ✅ |
| 有真实可用代码 | ✅ 157 测试 |
| 图标是 GitHub 托管的方形位图 | ✅ `icon-256.png` |
| `private` 已移除 | ✅ |
| `repository` 字段 | ⚠️ 占位符待填 |
| 仓库满 1 天 | ⚠️ 建完要等 |
| `dsh-plugin` topic | ⚠️ 推送后加 |

## 已知会被问到的两点

1. **koffi 依赖**：已改成真正的 `dependencies`（3.3.6，有 Windows 预编译包，
   不需要构建授权）。源码里保留的 `app.asar` 锚点有注释说明是给
   `link:` 安装兜底的，不是主要路径。

2. **前台不闪任务栏**：README 已写明这是 Windows 行为
   （`FLASHW_TIMERNOFG` 对已激活窗口立即满足），不是功能缺失。
   维护者读代码时会看到 `flashFlags()` 的实现与说明一致。
