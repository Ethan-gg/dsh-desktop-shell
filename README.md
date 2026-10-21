# dsh Desktop Shell

一个很薄的 Electron 宿主：主进程负责启动/停止本地 dsh 后端、加载它带认证令牌的 Web UI、托盘生命周期和故障恢复；窗口里运行的是原封不动的 dsh Web 页面，壳不碰业务逻辑。

这个目录已经包含可运行实现、31 个单元测试、5 个真实启动/安装验证脚本，以及 NSIS/portable 打包配置。实现过程中修正了原方案里几个会直接导致“打不开”的问题，评审结论见 [DESIGN.md](./DESIGN.md)。

---

## 先看结论：原方案需要改的 6 个点

| 原方案 | 实际问题 | 本实现 |
|---|---|---|
| 窗口直接加载 `http://127.0.0.1:3080` | dsh 根路径需要 **每次进程启动生成的 token**，裸地址返回 401 | 捕获 stdout 的 `dsh web: http://127.0.0.1:<port>/?token=...`，加载完整认证 URL |
| 固定 3080，先探测再复用 | 端口冲突；别人的 dsh 实例没有 token，无法复用 | 始终 `--port 0` 让系统分配端口，只管理自己的子进程 |
| 蓝绿复制整个 appdata | 会复制会话、凭据、缓存；运行中切换也不原子 | 安装时创建 manifest-only canary，验证后才合并；另保留 profile 配置快照用于回滚 |
| `npx ... shell: true` | Windows 上会多一层 cmd.exe，`SIGTERM` 杀不干净 | 解析 npm shim 到真实 `lib/bin.js`，直接 `node bin.js`，失败时 `taskkill /T /F` |
| 后端重启后 `webContents.reload()` | 旧 URL 的端口和 token 都已失效，reload 只会 401 | 重启后加载新的认证 URL（`loadURL`） |
| `HOME` 注入 appdata | dsh 实际读 `DSH_HOME` | 启动子进程时注入 `DSH_HOME`，不改 `HOME` |

另外两个容易被忽略的问题也处理了：

- **工作区**：Electron 从开始菜单启动时 cwd 往往是 `System32`，直接 spawn 会让 dsh 把系统目录当工作区。壳默认把 cwd 设为“文档”目录，可用 `workspace` 配置覆盖。
- **日志泄密**：token 在启动 URL 里；壳在写日志和错误弹窗前统一 `token=<redacted>`，已验证日志中没有明文 token。

---

## 功能

- 自动查找 dsh（PATH、`dsh.cmd`、本地依赖或配置的 `lib/bin.js`），直接以真实 Node 进程启动。
- 随机端口 + 认证 URL 捕获，启动就绪后才显示窗口。
- 托盘：显示、重新加载、重启后端、回退配置、保存快照、打开配置/日志、开发者工具、退出。
- 关闭窗口只隐藏，托盘常驻；单实例锁，第二次启动会聚焦已有窗口。
- F5 / Ctrl+R 重载前端；Ctrl+Shift+R 重启后端；F12 / Ctrl+Shift+I 开发者工具。
- 后端崩溃自动退避重启：2s → 5s → 15s → 进入恢复流程。
- 启动连续失败时，自动回退到上次成功启动保存的 profile 快照，再重启。
- 后端健康检查（每 7.5s 一次，连续 3 次失败重启）。
- 页面渲染进程崩溃自动重载；页面无响应 10s 后自动重载。
- 导航围栏：只允许当前 dsh origin；普通外部链接交给系统浏览器；`about:blank` 登录 popup 使用受限子窗口；禁止 webview。
- 托盘“安全安装插件（Canary）…”：安装前快照 → canary profile 安装 → 独立端口验证 → 合并 → 重启 → 新快照；失败自动恢复。
- 启动时执行 `dsh --version` 并记录；0.2.x 为已验证范围，URL 行格式变化时给出带版本号的明确错误。
- 登录/OAuth popup：`nodeIntegration:false`、`sandbox:true`、无 preload，只允许 http/https。
- electron-builder：NSIS 安装包 + portable exe，支持 `CSC_LINK` 签名入口。
- 窗口位置/大小记忆；启动页、重启页、失败页都使用本地 CSP 页面。
- 详细日志：`%APPDATA%\dsh-desktop\logs`。

---

## 运行

要求：

- Windows 10/11（代码也兼容 macOS/Linux，但只在 Windows 实测）
- Node.js `^22.19.0 || >=24.0.0`
- 已安装 dsh：`npx @deepseek-ai/dsh --version` 或 `npm i -g @deepseek-ai/dsh`

```powershell
cd D:\path\to\dsh-desktop-shell
npm install
npm start
```

也可以直接双击 `start.cmd`（已安装 Electron 后）。

如果 npm 安装时跳过了 Electron 二进制下载：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
node node_modules/electron/install.js
```

启动后：

- 第一次会自动生成 `%APPDATA%\dsh-desktop\desktop-config.json`。
- 默认使用 `$DSH_HOME`（没有则 `~/.dsh`）里的 `web` profile。
- 默认工作区是“文档”目录；可在配置里改。
- 关闭窗口不会退出，点托盘图标可重新显示；托盘菜单“退出”才会停止后端并退出。

---

## 快捷键

| 快捷键 | 行为 |
|---|---|
| `F5` / `Ctrl+R` | 重新加载当前页面，不动后端 |
| `Ctrl+Shift+R` | 重启 dsh 后端，然后加载新的认证 URL |
| `F12` / `Ctrl+Shift+I` | 开关开发者工具 |

> 这里刻意使用**窗口内快捷键**，不是 `globalShortcut`。全局注册 F5 会劫持整个系统，和“壳只在自己窗口里工作”的边界冲突。

---

## 配置

文件：`%APPDATA%\dsh-desktop\desktop-config.json`。修改后重启应用。

```json
{
  "profile": "web",
  "dshHome": null,
  "workspace": "D:\\Documents",
  "dshBin": null,
  "nodePath": null,
  "startupTimeoutMs": 60000,
  "extraArgs": [],
  "env": {},
  "startHidden": false
}
```

| 字段 | 说明 |
|---|---|
| `profile` | dsh profile 名，默认 `web`。不能用保留名 `desktop` |
| `dshHome` | dsh 数据根目录；留空时依次用 `$DSH_HOME`、`~/.dsh` |
| `workspace` | dsh 的默认工作区（子进程 cwd）；留空用“文档” |
| `dshBin` | 可指向 `@deepseek-ai/dsh/lib/bin.js` 或 npm 的 `dsh.cmd`；留空自动查找 |
| `nodePath` | 指定启动 dsh 的 `node.exe`；留空自动查找 |
| `startupTimeoutMs` | 后端启动超时，5s–300s，默认 60s |
| `extraArgs` | 追加给 `dsh web` 的参数，例如 `["--trusted-host","..."]` |
| `env` | 追加给后端子进程的环境变量 |
| `startHidden` | 启动时不显示窗口，只留托盘 |

环境变量覆盖（适合便携/测试）：

- `DSH_DESKTOP_PROFILE`
- `DSH_DESKTOP_HOME`
- `DSH_DESKTOP_WORKSPACE`
- `DSH_DESKTOP_DSH`
- `DSH_DESKTOP_NODE`
- `DSH_DESKTOP_USER_DATA`（隔离配置、快照和日志目录）

---

## 故障恢复模型

### 前端故障

- `render-process-gone`：0.8s 后重新加载当前认证 URL；60s 内连续 4 次则重启后端。
- `unresponsive`：10s 后仍无响应则重新加载。
- `did-fail-load`：最多 3 次退避重载；仍失败则显示本地错误页，托盘可重启后端。
- `F5` / `Ctrl+R`：只重载页面。

### 后端故障

- 进程意外退出 → 2s 后重启；连续失败按 2s / 5s / 15s 退避。
- 3 次重启仍失败 → 尝试配置回退；没有可回退快照时弹出错误对话框（重启/回退/日志/退出）。
- 每次成功启动后立即保存对应 profile 配置的快照；稳定运行 60s 后重置退避预算。
- 托盘“回退到可用配置”可手动恢复最近一次快照。

### 插件装炸了：为什么不是原方案的“整目录蓝绿”

原方案想维护两份完整 appdata，先在绿色装插件、试启动，再切状态文件。实际有三个问题：

1. dsh 的插件市场和 `dsh plugin` 都安装到**当前启动的 profile**；壳没有拦截 UI 内的安装动作，准备一个“绿色目录”并不会让 UI 把插件装进去。
2. 复制整个 `DSH_HOME` 会把 `sessions/`、`.credentials.yaml`、缓存一起复制；体积大，凭据多份，运行中切换也没有真正的原子性。
3. Windows 上正在被 dsh 读取的 `node_modules` 可能被锁，整目录复制/切换容易半途失败。

本实现改为**配置快照 + 启动失败自动回滚**：

- 只保存 `profiles/<profile>/` 下的 `package.json`、`cordis.patch.yml`、`cordis.yml`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`。
- 这些文件决定哪些 bundle 被加载；把 `package.json` 里的 bundle 列表恢复，坏插件就不会再被加载。
- 会话、凭据、缓存、已安装的包字节都留在原处，不复制、不切换、不删除。
- 回滚后重启；如果仍然失败，进入错误对话框，不会无限循环。

**边界**：如果插件升级把共享依赖的旧版本从 `node_modules` 里删掉了，单纯恢复 `package.json` 不会把旧版本字节装回来。这时需要在托盘选择“回退到可用配置”后，再执行一次对应 profile 的 `dsh plugin ... install`，或重新安装旧版本。这个限制比“整目录复制”小，但确实存在；README 不把它说成万能回滚。

---

## 日志与排查

- 应用日志：`%APPDATA%\dsh-desktop\logs\desktop.log`
- 每次后端启动的完整 stdout/stderr：同目录 `backend-*.log`
- 快照：`%APPDATA%\dsh-desktop\profile-snapshots\<profile>\<时间>-<hash>\`
- 启动失败时，错误对话框可直接打开日志目录。

日志中的认证 token 会被替换为 `<redacted>`；不要把 `desktop.log` 之外自行抓取的 stdout 原样发出去。

---

## 验证

```powershell
# 31 个单元测试：URL、健康检查、退避、快照、canary、版本、插件参数、路径、配置
npm test

# 真实启动两次 dsh，验证随机端口、认证 URL、停止后无残留
node scripts/backend-smoke.js

# canary profile 真实启动、promote、remove
node scripts/canary-smoke.js

# 本地 bundle 安装进 canary，验证 dependency/bundle 激活和启动
node scripts/plugin-install-smoke.js

# 真实 Electron 安装对话框 + 完整安全安装事务
node scripts/install-ui-smoke.js

# 真实启动 Electron + dsh + 截图；再重启后端，验证换端口后重新加载
$env:DSH_DESKTOP_SMOKE='1'
$env:DSH_DESKTOP_SMOKE_RESTART='1'
$env:DSH_DESKTOP_SMOKE_OUT="$PWD\smoke.png"
npx electron .

# 登录 popup 的 sandbox / no-Node / no-preload 检查
$env:DSH_DESKTOP_SMOKE_OAUTH='1'
$env:DSH_DESKTOP_SMOKE_OUT="$PWD\smoke-oauth.png"
npx electron . --smoke-test

# 隔离环境注入损坏的 profile patch，验证连续失败后自动回退并恢复 UI
node scripts/rollback-smoke.js
```

本次实测结果（Windows，Node 24.19.0，dsh 0.2.1-rc.2，Electron 44.9.2）：

- 单元测试 31/31 通过。
- 后端冒烟：两次端口分别为 `34147` / `34149`，URL 均有 token，停止后无残留。
- Canary 冒烟：canary 端口 `49534`，promote/remove 成功。
- 插件安装冒烟：本地 bundle 以端口 `10574` 在 canary 启动，依赖和 bundle 激活。
- 安装 UI 冒烟：端口 `64837`（源码）/ `56686`（最终打包版），正式 profile 获得依赖，phase=`running`。
- Electron 冒烟：首次加载端口 `13514`，重启后 `29391`，两次截图都进入 `DeepSeek Harness` UI。
- OAuth popup：首次端口 `13514` 时创建，`sandbox=true`、`nodeIntegration=false`、`hasPreload=false`。
- 自动回滚：4 次启动失败后恢复快照，端口 `32215` 重新进入 UI，`cordis.patch.yml` 恢复为 `[]`。
- 打包：NSIS + portable + win-unpacked 构建成功；打包版也通过了冒烟和安装 UI 测试；未提供证书，Authenticode 为 `NotSigned`。

---

## 目录结构

```text
src/
  main.js                     Electron 主进程 / 生命周期 / 状态机
  config.js                   配置读取、校验、默认值
  logger.js                   日志与 token 脱敏
  backend/
    dsh-backend.js             单个 dsh 子进程的启动、URL 捕获、健康检查、停止
    dsh-locator.js             查找 node / dsh，解析 npm .cmd shim
    health.js                  401/2xx/3xx 健康探针
    version.js                 dsh --version 与 URL 行兼容检查
    plugin-command.js          dsh plugin add 子进程与安装日志
    restart-policy.js          2s/5s/15s 退避预算
    url.js                     认证 URL 解析与脱敏
  profile/
    snapshots.js               profile 配置快照、恢复、裁剪
    canary.js                  canary profile 创建、promote、清理
  ui/
    tray.js                    托盘菜单
    status-page.js             本地启动/错误页（CSP，无脚本）
    window-state.js            窗口位置与大小
    install-dialog.js          本地安装输入窗口（最小 preload）
    install.html / install-renderer.js / install-preload.js
scripts/
  generate-icons.js            无依赖生成 tray.png / icon.png / icon.ico
  backend-smoke.js             真实后端启停测试
  canary-smoke.js              canary 启动/promote/remove
  plugin-install-smoke.js      插件安装到 canary
  install-ui-smoke.js          Electron 安装对话框端到端
  rollback-smoke.js            端到端自动回滚测试
test/                          31 个 node:test 单元测试
assets/                        tray.png / icon.png / icon.ico
dist/                          NSIS / portable / win-unpacked 构建产物
```

---

## 安全边界

- `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webviewTag: false`。
- dsh 远程页面没有 preload；只有本地“安全安装插件”对话框有一个只暴露 `submit`/`cancel` 的最小 preload。
- 只允许导航到当前后端 origin；普通外部 http/https/mailto 用系统浏览器打开。
- 仅 `about:blank` 登录 popup 进入 Electron 子窗口，子窗口无 Node、无 preload，只允许 http/https。
- `setWindowOpenHandler` 拒绝其余新建窗口。
- `will-attach-webview` 一律拒绝。
- 权限请求只允许当前 origin 的剪贴板和通知，其余拒绝。
- 本地 HTTP 只绑定 `127.0.0.1`，不使用 `0.0.0.0`。

---

## 已知限制

- 没有内置自动更新；当前提供 NSIS 安装包和 portable exe，签名与更新通道需要你提供证书/发布服务器（见下文“打包与签名”）。
- 外部 OAuth/登录 popup 会在一个无 Node、无 preload 的受限子窗口里打开；popup 机制已通过冒烟验证，实际平台账号授权仍需用真实账号走一遍。
- 配置快照只覆盖 profile 配置文件，不覆盖 `node_modules` 里的包字节（见上文边界）。
- 自动回滚只在“启动连续失败”时触发；如果插件能启动但运行中才出错，需要用户在托盘手动回退。
- 本壳不修改 dsh 本身，也不依赖 dsh 的私有 API；dsh 升级后如果 stdout 的 `dsh web:` 行格式变化，启动会明确报错，并显示检测到的 dsh 版本。

---

## 打包与签名

```powershell
npm run dist:dir   # 先验证解包目录
npm run dist       # dist\dsh Desktop Setup <version>.exe + portable exe
```

- 安装包是 NSIS（可选安装目录、桌面/开始菜单快捷方式），不写机器级目录。
- 未设置证书时产物是**未签名**的；Windows SmartScreen 会提示。
- 要签名，给 electron-builder 提供标准环境变量即可：

```powershell
$env:CSC_LINK = 'C:\path\to\certificate.pfx'
$env:CSC_KEY_PASSWORD = '...'
npm run dist
```

- 自动更新需要额外的发布通道（例如 GitHub Releases / 自有 HTTPS）和签名；当前没有假装配置一个不可用的更新地址。打包后的应用仍需要目标机器安装 Node 与 dsh，或在 `desktop-config.json` 中配置 `dshBin`。

---

## 安全、安装与兼容性

- 托盘“安全安装插件（Canary）…”：输入包名 → 创建 canary profile → `dsh plugin add` → 独立端口启动验证 → 合并回当前 profile → 重启并保存新快照；失败自动恢复安装前快照。
- Canary 只复制 profile manifest，不复制会话、凭据、缓存或整个 `node_modules`；包字节由 pnpm 的共享存储提供。这个取舍避免整目录蓝绿的体积和锁问题，但不提供 `node_modules` 的完全隔离。
- 启动时执行 `dsh --version` 并记录版本；0.2.x 为已验证范围，其他版本会给出警告，URL 行格式变化时超时错误会直接指出版本和预期格式。
- 登录/授权 popup 使用 `about:blank` 预开窗，再导航到授权站点；子窗口 `nodeIntegration: false`、`sandbox: true`、无 preload，只允许 http/https。

