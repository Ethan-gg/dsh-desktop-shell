# 方案评审与实现设计

本文回答两个问题：

1. 原方案哪里会直接不工作，哪里可以优化；
2. 最终实现为什么长成现在这样。

---

## 一、先给结论

原方案的产品方向是对的：**壳只做进程编排和故障恢复，不碰 dsh 业务**。这个边界应该保留。

但按原方案直接写，第一版大概率会卡在下面三个地方：

- 窗口加载 `http://127.0.0.1:3080` 会得到 401，因为 dsh 的根页面需要进程启动时生成的 token；
- 固定 3080 + “探测已有实例”无法复用一个没有 token 的 dsh；
- 蓝绿复制整个 appdata 既不安全，也没有真正接上 UI 的插件安装流程。

所以我没有照抄“整目录蓝绿”，而是保留了它的目标（插件装炸能回退），换成更小、更可验证的“profile 配置快照 + 启动失败自动回滚”。其余部分按原方案的生命周期模型实现，并补上了原方案漏掉的 Windows 进程树、工作区 cwd、token 脱敏、认证 URL 更新等问题。

---

## 二、逐项评审

### P0-1：dsh 不是裸 HTTP 页面，必须加载带 token 的 URL

实际启动 `dsh --profile web --no-open --host 127.0.0.1 --port 0`，stdout 只打印一行：

```text
dsh web: http://127.0.0.1:19828/?token=<process-token>
```

不带 token 请求 `/` 会得到 401；带 token 的请求会 303 到 `./` 并种下会话 cookie。这个 token 是**进程级**的，重启后就变了。

原方案写的是：

```js
mainWindow.loadURL('http://127.0.0.1:3080');
```

这会直接停在 401 页面。

**实现**：`DshBackend` 从 stdout 中解析这一行，校验 host 必须是回环地址、必须有 token，然后把完整 URL 交给 `BrowserWindow.loadURL`。日志里只写脱敏后的 URL。

对应代码：

- `src/backend/url.js`
- `src/backend/dsh-backend.js` 的 `_onLine`

### P0-2：固定 3080 的“复用已有实例”不可行

原方案先 `probeDsh(3080)`，如果已有 dsh 就直接加载。但即使端口上有 dsh，壳也没有它的 launch token；请求仍然 401。若端口被别的程序占用，探测还可能误判。

**实现**：

- 不探测、不复用任何外部 dsh；
- 每次 `--port 0`，由操作系统分配空闲端口；
- 从 stdout 拿到实际端口和 token；
- 单实例锁保证不会同时开两个壳。

这样 3080 上已有的 dsh 完全不受影响，壳也不会因为端口冲突而起不来。

### P0-3：Windows 上 `npx + shell: true` 会留下孙进程

原方案：

```js
spawn('npx', ['@deepseek-ai/dsh', 'web', '-no-open'], { shell: true });
```

Windows 上进程树通常是：

```text
Electron -> cmd.exe -> npx.cmd -> node.exe -> dsh
```

对 `cmd.exe` 发 `SIGTERM`，后面几个进程不保证退出；再启动一次就会出现端口/凭据/缓存竞争。

**实现**：

- 找到 npm 生成的 `dsh.cmd` 后，不执行 shim，而是推导出同级的 `@deepseek-ai/dsh/lib/bin.js`；
- 用真实 `node.exe` 直接 spawn `bin.js`；
- 停止时先 `SIGTERM`，5s 未退出再 `taskkill /PID <pid> /T /F`；
- 启动失败也走同一条停止路径。

对应代码：`src/backend/locator.js`、`src/backend/dsh-backend.js` 的 `stop`。

### P0-4：`webContents.reload()` 不能用于后端重启

原方案在后端重启后调用 `webContents.reload()`。但重启后：

- 端口可能变了；
- token 一定变了。

reload 会重新请求旧 URL，结果还是 401。

**实现**：

- 前端故障（F5 / 页面崩溃 / 无响应）：`reload` 或重新加载同一个认证 URL；
- 后端重启：等新进程打印新 URL，再 `loadURL(newUrl)`；
- 重启期间显示本地状态页，避免白屏。

对应代码：`src/main.js` 的 `loadAppUrl` / `manualRestart`。

### P1-1：`HOME` 不是 dsh 的数据目录开关

原方案用：

```js
env: { HOME: getActiveAppdataPath() }
```

在 Windows 上 `HOME` 本来就不是 Node 的 `os.homedir()` 唯一来源；dsh 实际使用的是 `DSH_HOME`。

**实现**：明确注入 `DSH_HOME`，并在 README 里写清楚优先级：`dshHome` 配置 > `$DSH_HOME` > `~/.dsh`。

### P1-2：健康检查不能只看“状态码 < 500”

原方案：

```js
resolve(res.statusCode < 500)
```

这会把 404、403、甚至任何本地 HTTP 服务都当成 dsh。

**实现**：健康探针只接受：

- `401`（无 cookie 的正常 dsh 根页面）；
- `2xx/3xx`（已有 cookie 或重定向）。

并且只用于**自己刚启动的子进程**，不用于判断“端口上有没有 dsh”。探针有硬超时，避免半开连接。

对应代码：`src/backend/health.js`。

### P1-3：工作区 cwd 被忽略

dsh 把启动时的当前目录作为默认 workspace。Electron 从开始菜单启动时 cwd 可能是 `C:\Windows\System32`，dsh 会把系统目录当成工作区，会话列表也会跟着跑偏。

**实现**：子进程 cwd 使用配置的 `workspace`，默认“文档”目录；不存在时回退到用户主目录。对应 `src/config.js` 和 `DshBackend`。

### P1-4：token 会进日志

启动 URL 的 token 一旦写进 `console.log` 或 `backend.log`，任何能读日志的本地进程都能拿到 UI 控制权。

**实现**：

- `redact()` 在日志、错误对话框、状态页、冒烟测试输出前统一替换 `token=...`；
- 后端 stdout/stderr 按行脱敏后再落盘；
- 实测 `logs/` 中没有明文 token。

### P1-5：蓝绿整目录复制接不上 UI 安装流程

原方案的流程是：

1. 复制 blue → green；
2. 在 green 里安装插件；
3. 用 green 起临时实例；
4. 探测通过后切换 active。

问题是：dsh 的 Web UI 插件市场/插件管理器安装到**当前启动的 profile**，不是壳准备好的绿色目录。壳没有拦截 UI 的“安装”动作，所以步骤 2 不会发生在 green 里。除非壳自己提供一套“安全安装插件”的 CLI 入口，否则这个蓝绿流程和 UI 是断开的。

另外，复制整个 `DSH_HOME` 会包含：

- `sessions/`（可能很大，且运行中还在写）；
- `.credentials.yaml`（多份凭据）；
- `cache/`、`logs/`、`storages/`；
- `profiles/.../node_modules`（可能几百 MB）。

Windows 上正在被 dsh 读取的文件还可能被锁，复制/切换会半途失败。

**实现**：改成“配置快照 + 启动失败自动回滚”：

- 只快照 profile 配置文件；
- 会话、凭据、缓存、包字节共享，不复制；
- 启动成功即保存快照；
- 连续启动失败且当前 hash 与最近快照不同 → 恢复快照 → 重启；
- 没有可回退快照时弹窗，不无限重启。

这样解决的是最常见的“插件把 `package.json` / `cordis.patch.yml` 写坏，导致 dsh 起不来”，而不是假装能原子回滚整个数据目录。

对应代码：`src/profile/snapshots.js`、`src/main.js` 的 `recoverOrFatal`。

### P2-1：`globalShortcut` 不应该注册 F5

原方案写“全局快捷键（F5 / 重启后端）”。如果真用 `globalShortcut.register('F5')`，用户在浏览器、编辑器里按 F5 都会被 Electron 抢走。

**实现**：用 `webContents.on('before-input-event')`，只在 dsh 窗口获得键盘事件时处理。托盘菜单也提供同样的动作。

### P2-2：托盘退出必须等待后端停止

原方案：

```js
click: async () => { isQuitting = true; await stopDsh(); app.quit(); }
```

Electron 的 `before-quit` 不会自动等待异步操作；如果别处再触发退出，可能留下子进程。

**实现**：

- `before-quit` 统一 `preventDefault`，进入 `shutdown()`；
- `shutdown()` 只执行一次，等待 `backend.stop()`，再 `app.exit(code)`；
- 托盘“退出”也走同一个 `shutdown()`。

### P2-3：导航围栏要按 origin，不是按字符串前缀

只判断 `url.startsWith('http://127.0.0.1:3080')` 会被 `http://127.0.0.1:3080.evil.com` 绕过。

**实现**：用 `new URL(url).origin === state.origin` 精确比较；外部链接只允许 http/https/mailto，并交给 `shell.openExternal`。

### P2-4：状态页/preload 的安全边界

原方案说“preload 脚本会在每次新渲染上下文中重新执行，不会丢失特权桥接”。这本身没错，但如果 preload 暴露了 `restartBackend` 之类的桥，dsh 页面（包括第三方插件页面）就能调用壳的特权操作。

**实现**：干脆不使用 preload。启动/错误页是纯静态 HTML + CSP，没有任何脚本；所有恢复动作只从主进程的托盘/快捷键触发。

---

## 三、最终架构

```text
┌─────────────────────────────────────────────────────────────┐
│ Electron 主进程                                              │
│                                                             │
│  config ──> DshBackend ──> node.exe bin.js --profile web    │
│                │                --no-open --host 127.0.0.1  │
│                │                --port 0                    │
│                │                                            │
│                ├─ stdout: dsh web: http://...?token=...     │
│                ├─ health: GET / -> 401/2xx/3xx              │
│                └─ stop: SIGTERM -> taskkill /T /F           │
│                                                             │
│  state machine: starting -> running -> restarting -> ...    │
│  snapshots: profile config, not sessions/credentials        │
│  tray: show/reload/restart/rollback/logs/quit               │
└──────────────────────────┬──────────────────────────────────┘
                           │ loadURL(authenticated URL)
┌──────────────────────────▼──────────────────────────────────┐
│ BrowserWindow                                               │
│  sandbox: true, contextIsolation: true, no preload          │
│  dsh Web UI（原页面）                                       │
│  navigation fence: exact origin only                        │
└─────────────────────────────────────────────────────────────┘
```

---

## 四、状态机

```text
                 start()
                   │
                   ▼
              ┌─────────┐   URL + health OK   ┌─────────┐
              │ starting│ ───────────────────>│ running │
              └────┬────┘                     └────┬────┘
                   │ failure                       │ exit / health x3
                   ▼                               ▼
              ┌─────────┐    delay 2/5/15s     ┌─────────┐
              │ failed  │ <─────────────────── │restarting│
              └────┬────┘                      └─────────┘
                   │ 4th failure
                   ▼
           ┌───────────────┐
           │ recoverOrFatal│
           └───────┬───────┘
                   │ snapshot hash differs
                   ▼
           ┌───────────────┐
           │ rolling-back  │ -> starting
           └───────────────┘
                   │ no snapshot / same hash
                   ▼
              error dialog
```

---

## 五、快照算法

### 保存

```text
fingerprint = sha256(package.json + cordis.patch.yml + cordis.yml
                     + pnpm-workspace.yaml + pnpm-lock.yaml)

if profile 不可读 -> 不保存
if 最近快照 hash == 当前 hash -> 复用，不重复建目录
else:
  snapshots/<profile>/<ISO 时间>-<hash 前 8 位>/
    package.json
    cordis.patch.yml
    ...
    meta.json { profile, hash, createdAt, reason, files, source }
  只保留最近 8 份
```

### 恢复

- 逐文件复制回 profile；
- 快照里不存在的受管文件，从 profile 删除（例如插件新加的 `pnpm-lock.yaml`）；
- 不动 `node_modules`、`sessions`、`.credentials.yaml`、`cache`、`logs`；
- 恢复后重新启动 dsh，重新走 URL + health。

### 为什么是“配置”而不是“数据”

dsh 的插件选择由 `profiles/<name>/package.json` 的 `dsh.profile.bundles` 和 `cordis.patch.yml` 决定。把这两个恢复，坏插件就不会被加载，足以让 Web UI 重新起来。数据目录不在恢复范围内，避免把用户会话/凭据回滚到旧状态。

---

## 六、与原方案的功能对照

| 原方案 | 实现状态 |
|---|---|
| dsh 进程管理 | 完成 |
| 健康检查 | 完成，401 语义 |
| 崩溃退出自动重启 | 完成，2/5/15s |
| 托盘 + 关闭隐藏 | 完成 |
| F5 刷新 / Ctrl+Shift+R 重启 | 完成，窗口内快捷键 |
| 蓝绿 appdata | 完成：profile canary + 配置快照回滚 |
| 端口冲突处理 | 完成，`--port 0` |
| 安全边界 | 完成；远程页面无 preload，仅本地安装对话框有最小 preload |
| 优雅关闭 | 完成，SIGTERM + taskkill 兜底 |
| 插件安装事务 | 完成：安全安装对话框 + Canary + 自动恢复 |
| OAuth/登录 popup | 完成，受限子窗口 |
| dsh 版本/URL 兼容检查 | 完成 |
| NSIS/portable 打包 | 完成，签名入口已接好（需证书） |

---

## 七、第七点：五项都已完成

### 7.1 壳内“安全安装插件”入口

托盘菜单“安全安装插件（Canary）…”打开一个本地模态窗口：

1. 用户输入包名/路径/git/tarball 地址；
2. 主进程校验参数（拒绝空值、`-` 开头、控制字符、超长）；
3. 创建安装前 profile 快照（强制，reason=`pre-plugin-install`）；
4. 停止正式后端；
5. 从当前 profile 创建 `web-canary`（只复制 manifest）；
6. 执行 `dsh plugin --profile web-canary add <spec>`；
7. 用 `DshBackend` 在随机端口启动 canary，确认 URL + 健康检查通过；
8. 把 canary 的 manifest 合并回正式 profile；
9. 重启正式后端，检查进入 `running`；
10. 保存 `post-plugin-install` 快照，清理 canary。

失败路径：

- `dsh plugin add` 失败、canary 启动失败、合并后正式后端失败，都会恢复 `pre-plugin-install` 快照；
- 恢复后重新启动原配置；
- 最后才向用户显示错误和日志；
- 托盘/快捷键在安装期间被禁用，避免并发重启。

输入窗口是本地 `loadFile` 页面，使用最小 preload（只有 `submit`/`cancel` 两个 IPC），无 Node、无远程导航；dsh 远程页面本身仍然没有 preload。

验证脚本：`scripts/install-ui-smoke.js`（真实 Electron + 真实 dsh + 本地 bundle）。

### 7.2 真正的 Canary profile

实现比“复制整个 appdata”小得多：

- canary 目录：`$DSH_HOME/profiles/<active>-canary`；
- 只复制 `package.json`、`cordis.patch.yml`、`cordis.yml`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`；
- 不复制 `sessions/`、`.credentials.yaml`、`cache/`、`logs/`、`node_modules`；
- canary 用 `--port 0` 独立启动验证；
- 验证通过前，正式 profile 的 manifest 不变；
- 验证通过后 `promoteCanaryProfile()` 逐文件合并；
- 结束后删除 canary，`removeCanaryProfile()` 先处理可能存在的 `node_modules` 链接，再删目录。

**明确边界**：这个 canary 是“manifest 隔离”，不是“包字节隔离”。canary 通过 Node 的父目录查找/pnpm 共享存储看到同一批包；如果插件升级改变了共享包字节，正式 profile 的旧版本也可能受影响。真正的 `.pnpm` 内容寻址复制或 junction 共享是下一步，不在本轮冒充成已完成。

### 7.3 登录/OAuth popup

DSH 的浏览器登录会先 `window.open('about:blank')`，再把这个 tab 导航到平台授权地址。现在：

- `setWindowOpenHandler` 只对 `about:blank` 返回 `allow`；
- `did-create-window` 把子窗口配置成 `nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`、无 preload；
- 子窗口只允许 http/https 导航，禁止 webview；
- 子窗口内的新弹窗交给系统浏览器；
- 普通的外部链接仍然交给系统浏览器，不进入 Electron；
- 主窗口关闭时子窗口随父窗口生命周期结束。

冒烟测试确认：popup 存在、`sandbox=true`、`nodeIntegration=false`、`hasPreload=false`。

### 7.4 打包与签名

- `electron-builder@26.15.3` + `asar`；
- Windows 目标：NSIS 安装包 + portable exe；
- NSIS 非 one-click、允许选安装目录、创建桌面/开始菜单快捷方式；
- 图标由 `scripts/generate-icons.js` 生成 PNG + ICO（16/24/32/48/64/128/256）；
- 签名使用 electron-builder 标准环境变量 `CSC_LINK` / `CSC_KEY_PASSWORD`；
- 没有证书时产物是未签名，SmartScreen 会提示；本轮没有伪造签名；
- 自动更新仍需要发布通道（GitHub Releases/自有 HTTPS），当前没有配置一个不可用的更新地址。

产物：

```text
dist\dsh Desktop Setup 0.1.0.exe
dist\dsh-Desktop-0.1.0-portable.exe
dist\win-unpacked\dsh Desktop.exe
```

### 7.5 dsh 版本 / URL 行兼容检查

启动时在启动正式后端之前执行：

```text
dsh --version
```

- `parseDshVersion()` 解析裸 semver 或带前缀的版本；
- 0.2.x 标记为 `supported`；
- 0.1.x 标记为 `too-old`；
- 0.3+ / 1.x 标记为 `untested`；
- 版本写入日志、托盘状态和 `DshBackend`；
- 如果等待认证 URL 超时，错误会明确写出：
  - 当前 dsh 版本；
  - 期望的 `dsh web: http://127.0.0.1:<port>/?token=...` 行；
  - 可能是 URL 格式变化；
  - 最近 12 行输出。

这样 dsh 升级导致协议变化时，不会只得到一个无信息的 60 秒超时。

---

## 八、还可以继续优化

按价值排序，这些是下一轮而不是本轮已完成的：

1. **把 Node + dsh 打进安装包**：目前目标机器仍需 Node 和 dsh，或手配 `dshBin`。最彻底的做法是随包携带固定 dsh 版本和 Node 运行时，安装即用。
2. **包字节级 canary 隔离**：复制 pnpm 的 `.pnpm` 内容寻址结构（或硬链接克隆 + 原子 junction 切换），让插件升级不能影响正式 profile 的旧包字节。
3. **安装事务的取消/进度/构建批准**：当前 `dsh plugin add` 超时或结束前不能从 UI 取消，也没有逐包 build approval 的界面；可以接 dsh 的取消信号和 `approvedBuilds` 流程。
4. **签名 + 自动更新发布链**：配置证书、时间戳、GitHub Releases/HTTPS feed、`latest.yml` 和回滚策略；目前只做到“可打包 + 签名入口”。
5. **Windows Job Object**：Electron 自身崩溃时，当前只能保证正常退出/托盘退出会杀后端；用 Job Object 让内核在父进程死亡时一起结束子进程。
6. **机器可读的启动握手**：继续依赖 stdout 的 `dsh web:` 行是最大的版本耦合点；最好给 dsh 增加 `--print-url-json` 或通过继承 fd 传 token。
7. **下载/打印/外链策略**：当前外链统一交系统浏览器，下载走 Electron 默认；可以增加下载目录、文件名净化和打印隔离。
8. **诊断包**：一键导出脱敏日志、版本、profile manifest、快照列表；方便用户报障。
9. **多 profile / 多窗口**：每个窗口一个独立后端和 profile；当前是单实例、单后端。
10. **E2E 覆盖失败安装**：现有 E2E 覆盖成功安装、Canary 启动、自动回滚；还应覆盖“插件安装中途失败”“合并后启动失败”“用户取消”三条路径。
11. **启动性能**：`dsh --version` 每次启动多起一个 Node 进程，可缓存到配置并按 mtime 失效。
12. **国际化/可访问性**：当前界面文案中文硬编码，托盘/对话框可做 locale 与键盘可访问性。

---

## 九、验证记录

日期：2026-10-20/21（Asia/Shanghai）

环境：

- Windows，Node `v24.19.0`
- `@deepseek-ai/dsh` `0.2.1-rc.2`
- Electron `44.9.2`
- electron-builder `26.15.3`

结果：

- `node --test`：31/31 通过（新增 canary、版本、插件参数校验）。
- `node scripts/backend-smoke.js`：两次启动端口 `34147`、`34149`，均返回认证 URL，停止后无残留。
- `node scripts/canary-smoke.js`：canary 以端口 `49534` 启动，promote/remove 成功。
- `node scripts/plugin-install-smoke.js`：本地 bundle 安装到 canary，依赖和 bundle 激活，canary 端口 `10574`，清理成功。
- `node scripts/install-ui-smoke.js`：真实 Electron 安装对话框自动提交，正式 profile 获得依赖，源码版端口 `64837`、最终打包版 `56686`，phase=`running`。
- Electron 冒烟（含重启）：首次端口 `13514`，重启后 `29391`，两次都加载到 `DeepSeek Harness`。
- OAuth popup 冒烟：首次端口 `13514` 时创建，子窗口 `sandbox=true`、`nodeIntegration=false`、`hasPreload=false`。
- 自动回滚（隔离 DSH_HOME）：注入损坏的 `cordis.patch.yml` 后连续失败 4 次，自动恢复快照并以端口 `32215` 重新进入 UI，`cordis.patch.yml` 恢复为 `[]`。
- 打包：NSIS + portable + win-unpacked 均构建成功；打包版也通过冒烟和安装 UI 测试；未提供证书，Authenticode 状态为 `NotSigned`。
- 日志脱敏：`logs/` 中未出现明文 `token=`。

