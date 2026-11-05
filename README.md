# dsh-tray-flash

任务完成、或有人在等你审批/回答时，让 DeepSeek Harness 的**托盘图标像 QQ、微信收到消息那样隐显闪烁、任务栏按钮同时闪**。只要侧边栏还挂着黄点/绿点就一直闪，**点全部消失才停**；窗口本来就在前台时没有点可等，则闪到你动一下鼠标或切换会话。

一个插件，两半：

| 半 | 位置 | 作用 |
|---|---|---|
| Host | `lib/index.js` | 闪烁、托盘换图、收点状态 |
| Client | `lib/client.js` | 读浏览器里的点，上报给 Host |

## 它什么时候闪

| 触发 | 说明 |
|---|---|
| 一轮结束 | 任何会话的 `turn/end`，跳过被打断/取消的那一轮 |
| 等待审批 | 工具请求人工批准（`approval/asked`） |
| 等待回答 | 模型调用 `ask_user_question`（含计划审批） |

**不触发**：子代理会话（`ignoreSubagent`，默认开）、后台任务、定时任务。

## 它什么时候停

**点全部消失的时候。** 点是侧边栏会话行前面的那个小圆点：

| 点 | 含义 | 谁负责 |
|---|---|---|
| 🟡 黄点 | 有审批 / 计划审批 / 提问在等你 | Client 的 `pendingInteraction` |
| 🟢 绿点 | 后台会话跑完了一轮，你还没看 | Client 的 `completionUnread` |

除此之外：

1. 窗口被关闭/销毁 → 停；
2. Client 失联（页面没加载 / 超过 `dotsStaleSeconds` 没上报）→ 退回「窗口获得焦点就停」。

**没有时间上限。** 点挂着就一直闪，哪怕挂一小时。默认 `maxFlashSeconds: 0`（不超时）；如果你想要一个保险值，填正数即可，例如 `maxFlashSeconds: 600`。

> 早先的版本默认上限 120 秒，结果绿点挂了超过两分钟就永久停闪了——因为「点数量不变」不会重新触发闪烁（30 秒心跳报的也是同一个数字），提醒就此丢失。所以默认改成了不限时。

### 为什么主会话要「造一个点」

DSH 源码里主会话**永远不会**有绿点：

```js
// @deepseek-ai/dsh-client-ui-session/lib/client.js:953
else if ((previous === true || previous === void 0 && beforeBaseline) && !this.isMain(sessionId))
  this.completionUnread.add(sessionId);   // ← isMain 的就是不进去
```

所以主会话跑完一轮，没有任何点会出现，闪烁就永远停不下来。插件因此给主会话记一个**虚拟未读**（`virtualMainDot`），**窗口重新获得焦点时清掉**——这是「你看到这一轮了」最接近的等价物。

## 托盘图标怎么闪的

DSH 的托盘图标由 Electron 主进程持有，插件侧通过 `Shell_NotifyIconW(NIM_MODIFY)` 在**原图上就地换图**，不新建图标、不动 tooltip 和右键菜单（只设 `NIF_ICON`）。

闪烁是**原图标 ↔ 全透明**交替，就是 QQ 那种「消失又出现」。透明那张不是另画的图，而是一个 alpha 全 0 的图标：

```powershell
node scripts/build-icon.mjs        # 产物：assets/blank.ico
```

### 为什么是「透明」而不是别的做法

这几种写法我都在本机（Windows 11 26H2）实测过，不是查文档得出的：

| 写法 | 结果 |
|---|---|
| alpha 全 0 + AND 掩码全 1 | ✅ **整块变空白** |
| alpha 255 + AND 掩码全 1 | ❌ 渲染成**黑方块** |
| 1bpp 图标 | ✅ 也变空白（截图哈希与第一种完全一致） |

关键点：**shell 认的是 alpha 通道**，光靠 AND 掩码把不透明图遮住是不行的。

还有一条必须确认的性质：透明期间点击是否还能用。实测 `Shell_NotifyIconGetRect` 在透明帧期间**仍返回同一矩形**，所以图标只是「看不见」，槽位和点击都不受影响。

三条安全性质：

- `DesktopTray` 运行期只调用 `setToolTip` 和 `setContextMenu`，**从不改图标**，所以切换语言不会把透明刷回去；
- 图标 ID 是运行时探测的（用 `Shell_NotifyIconGetRect` 逐个数试），不硬编码；
- 应用重启必定重建托盘图标，**崩溃也不会留下永久空白的图标**。

托盘不可用（找不到宿主窗口、图标加载失败、shell 拒绝）时，自动降级为「只闪任务栏」，日志里只警告一次。

### 窗口在前台、当前会话完成时：闪到鼠标移动

有一类情况原来的规则覆盖不到：

```
窗口本来就在前台 + 刚完成的就是你正在看的那个会话
  → 没有点可等（主会话永远不产生真实圆点）
  → 「窗口在前台」在回合结束前就已经成立，不能当作"你看过了"
  → 结果是闪一下就停，盯着屏幕的人反而毫无反馈
```

`flashUntilMouseMoves`（默认开）把确认信号从「窗口获得焦点」换成「**鼠标动了**」：

| 情况 | 停止条件 |
|---|---|
| 窗口在**后台**时开始闪 | 切回窗口即停（切回本身就是动作） |
| 窗口在**前台**、当前会话完成 | **鼠标移动**、切换会话、或窗口失焦才停 |

鼠标检测走已有的 1 秒轮询，不新增定时器。任意 1 像素的移动都算——要求移动距离反而会让小幅度的、明确的动作失效。

注意 `GetCursorPos` 必须传 8 字节缓冲区：声明成 koffi 的 `POINT` 结构体再传指针，会静默读回 `0,0`（坐标永远是 0,0 就不会有"移动"），而同样的调用换成缓冲区就正常。这个坑已写在 `src/win32.mjs` 里。

关掉它就回到旧行为（前台时闪一下就停）：

```yaml
flashUntilMouseMoves: false
```

## 安装

包目录：`E:\0_opencode\.00工作空间\dsh-tray-flash`

`desktop` profile 由 Electron 应用独占，`dsh plugin --profile desktop` 会直接报错，插件管理器的 `install_bundle` 也不一定可用。因此安装等价于 pnpm 的 `link:`：

```powershell
# 1. 备份
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\package.json" `
          "$env:USERPROFILE\.dsh\profiles\desktop\package.json.bak-tray-flash"

# 2. 在 dependencies 里加一行，并在 dsh.profile.bundles 末尾追加名字
#    "dsh-tray-flash": "link:E:/0_opencode/.00工作空间/dsh-tray-flash"

# 3. 建目录联接（与 pnpm link: 的产物等价）
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-tray-flash" `
  -Target "E:\0_opencode\.00工作空间\dsh-tray-flash"
```

**不需要**改 `~/.dsh/profiles/desktop/cordis.patch.yml`：本包自带的 `cordis.patch.yml` 会插入自己的行。

然后**重启 DeepSeek Harness**（desktop profile 未开 patchReload，Host 代码必须重启才生效）。

### 回滚

```powershell
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\package.json.bak-tray-flash" `
          "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Force
Remove-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-tray-flash" -Force
```

## 配置

在 `cordis.patch.yml`（任意一层）覆盖同名行即可：

```yaml
- insert:
    - id: tray-flash
      name: dsh-tray-flash
      config:
        stopWhenDotsClear: true   # 点全消失才停（核心行为）
        virtualMainDot: true      # 给主会话造虚拟未读（焦点时清）
        dotsStaleSeconds: 60      # Client 多久没上报就算失联
        trayBlink: true           # 托盘图标隐显闪烁（false 只闪任务栏）
        trayBlinkIntervalMs: 600  # 托盘闪烁半周期（100–5000）
        flashCaption: true        # 标题栏也闪（false 只闪任务栏按钮）
        maxFlashSeconds: 0        # 0 = 跟随点，永不超时（默认）；正数 = 保险上限
        onlyWhenUnfocused: true   # 前台就不闪（只在点状态未知时生效）
        flashUntilMouseMoves: true # 前台+当前会话完成时，闪到你动鼠标才停
        ignoreInterrupted: true   # 被打断的一轮不闪
        ignoreSubagent: true      # 子代理不闪
        flashTimeout: 0           # FlashWindowEx 的 dwTimeout(ms)
        flashCount: 0             # FlashWindowEx 的 uCount
        pollIntervalMs: 1000      # 轮询间隔（200–5000）
        allowTestFlash: true      # 注册自检路由
        enabled: true             # 总开关
```

非法值不会让插件激活失败：会被替换成默认值并在日志里告警一次。

## 自检（不需要等真实事件）

插件默认注册三个只允许本机同源访问的路由：

| 路由 | 方法 | 作用 |
|---|---|---|
| `/__tray-flash/self-test` | POST | 立刻闪一次，返回命中的窗口句柄与配置 |
| `/__tray-flash/state` | GET / POST | 读状态 / 停止闪烁 |
| `/__tray-flash/dots` | POST / DELETE | Client 上报点数量 / 清零 |

看点的实时状态：

```powershell
Invoke-RestMethod http://127.0.0.1:20120/__tray-flash/state | Select-Object -ExpandProperty state |
  Select-Object flashing, lastStop, dots
```

`dots` 里能看到 `counts`（黄/绿点各几个）、`virtualMainUnread`（主会话虚拟未读是否挂着）和 `status`（`live` / `stale` / `absent`）。

配合 `scripts/selftest.mjs`：

```powershell
node scripts/selftest.mjs            # 默认 http://127.0.0.1:36001
node scripts/selftest.mjs 36001
```

脚本会：触发闪烁 → 连拍任务栏 12 帧 → 逐像素比对 → 停止 → 打印判定。

## 工作原理（给维护者）

- **发现窗口**：Host 进程是 Electron 主进程的直接子进程，所以 `process.ppid` 就是持有主窗口的进程。`EnumWindows` + `GetWindowThreadProcessId` + 类名 `Chrome_WidgetWin_1` + 可见 + 有标题，过滤掉 Electron 的隐藏辅助窗口（`Chrome_WidgetWin_0`、`Electron_NotifyIconHostWindow` 等）。
- **闪烁**：`FlashWindowEx`，`FLASHWINFO` 在 x64 上是 **32 字节**（`uint32` + 4 字节对齐 + 指针 8 + `uint32` ×3 + 尾部 4 字节对齐）。`dwFlags = FLASHW_CAPTION|FLASHW_TRAY|FLASHW_TIMERNOFG`。
- **托盘**：`EnumWindows` 找 `Electron_NotifyIconHostWindow`，用 `Shell_NotifyIconGetRect` 逐个 id 试探（`NOTIFYICONIDENTIFIER` 必须 **40 字节**，尺寸错了会返回 `E_INVALIDARG` 让所有 id 都像不存在），找到后 `NIM_MODIFY` 换图（`NOTIFYICONDATAW` 必须 **976 字节**）。
- **图标编码**：`LoadImageW` 对 DIB 帧和 PNG 帧都能加载（实测 4 种编码全部渲染成功），本插件用 DIB 帧，避免旧版 Windows 对 PNG 帧的兼容差异。
- **FFI**：从 `app.asar` 里的 dsh 安装解析 `koffi` 绝对路径（`link:` 安装的插件解析不到 profile 的 `node_modules`，实测 `MODULE_NOT_FOUND`）。全部兜底失败时插件静默降级，绝不影响 Host。
- **koffi 类型名是进程级全局的**：同名 `struct`/`proto` 二次声明会抛 `Duplicate type name`，所以声明结果按名字缓存复用（热重载、二次激活、测试重复 apply 都靠这个）。
- **`FlashWindowEx` 的返回值不可信**：同一次成功调用，koffi 读回 `32768` 或 `0` 都可能出现。**不要用它判断成败**，真伪只以"屏幕是否在闪"为准。

## 测试

```powershell
node --test test/*.test.mjs
```

156 个用例，覆盖点跟踪（计数、虚拟未读、失联降级、Client 重启）、**点触发闪烁**（绿点晚于 `turn/end` 出现时仍能启动、只在数量增加时启动、已在闪时不重启、**点长期不变仍持续闪**）、状态机（点消失才停、焦点回退、超时仅在手配时生效、去重、子代理与打断过滤、托盘联动）、Client 半（点数、节流、未变化不重发、30 秒心跳、卸载清空、失败静默）、托盘闪烁（id 探测、透明帧、图标生命周期、恢复、降级）、Win32 绑定、配置归一化、koffi 兜底链、本机围栏与路由，以及 Host 入口的激活/释放。

### 真实环境验证脚本

这几个脚本需要 DSH 正在运行，会短暂改动真实托盘图标，不在单元测试里：

```powershell
$exe = "D:\DSH\DeepSeek Harness.exe"
$pid = (Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
        Where-Object { $_.CommandLine -notlike '*--type=*' }).ProcessId

# 托盘图标能否加载、id 能否找到、start/stop 是否成功
$env:ELECTRON_RUN_AS_NODE=1; & $exe "E:\0_opencode\.00工作空间\dsh-tray-flash\scripts\probe-tray.mjs" $pid

# 两个状态是否真的长得不一样（截图像素差）
& $exe "...\scripts\probe-tray-visual.mjs" $pid

# 哪种 ICO 编码能被 shell 渲染
& $exe "...\scripts\probe-tray-encoding.mjs" $pid
```

## 已知边界

- 只在 Windows 上有效；其他平台插件静默不动作。
- 托盘图标闪烁依赖「图标 ID 探测」：如果同一个进程里有多个托盘图标，只会取探测到的第一个。
- 若 Host 与窗口不在同一进程树（未来架构改动），`process.ppid` 的假设需要重新验证。
- **没有时间上限**（默认 `maxFlashSeconds: 0`）。所以 Client 半如果彻底失联（页面崩溃 / 加载失败）而窗口又不在前台，闪烁会持续到你回到窗口为止。觉得吵就设一个 `maxFlashSeconds`。
