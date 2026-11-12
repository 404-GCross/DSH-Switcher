# DSH Switcher

多服务器 DSH 桌面客户端。主体直接打开各服务器的 **DSH 原生网页**，左下角管理和切换连接；服务端无需安装额外插件。

本项目是独立第三方客户端。当前暂用 DSH 官方桌面图标，来源与说明见 [build/README.md](build/README.md)。

[下载开发版（dev Pre-release）](https://github.com/404-GCross/DSH-Switcher/releases/tag/dev) · [GitHub Actions](https://github.com/404-GCross/DSH-Switcher/actions/workflows/desktop.yml)

## 下载与 Linux 安装

开发版支持以下平台：

| 平台 | 架构 | 包格式 |
| --- | --- | --- |
| Fedora | x86_64 | **RPM** |
| Debian / Ubuntu / Linux Mint | x86_64 | **DEB** |
| Arch / Manjaro 及其他 glibc Linux | x86_64 | **AppImage**、tar.gz |
| Windows | x64 | ZIP |
| macOS | Apple Silicon arm64、Intel x64 | DMG、ZIP |

### Fedora

在开发版页面下载当前的 `linux-x86_64.rpm` 文件，在只包含该版本 RPM 的目录执行：

```sh
sudo dnf install ./DSH-Switcher-*.rpm
```

RPM 安装运行依赖、菜单入口和图标；安装后从应用菜单打开 **DSH Switcher**，或运行 `dsh-switcher`。下载新版 RPM 后用相同命令更新。卸载使用 `sudo dnf remove dsh-switcher`；个人连接和登录数据保留在用户目录。

### Debian / Ubuntu / Linux Mint

下载 `.deb`，在只包含该版本 DEB 的目录执行：

```sh
sudo apt install ./DSH-Switcher-*.deb
```

APT 自动安装所需依赖、菜单入口和图标。更新使用相同命令；卸载使用 `sudo apt remove dsh-switcher`，个人数据保留。依赖声明同时支持 Ubuntu 24.04 / Debian 13 的 `t64` 库命名。

### Arch / Manjaro 与其他 Linux

下载 `.AppImage`，赋予执行权限后直接运行，无需安装 DSH 或 Node.js：

```sh
chmod +x ./DSH-Switcher-*.AppImage
./DSH-Switcher-*.AppImage
```

AppImage 使用静态链接的运行时。系统不能挂载 FUSE 时，可使用免挂载启动：

```sh
./DSH-Switcher-*.AppImage --appimage-extract-and-run
```

更新时退出客户端并替换 AppImage；删除文件即可移除程序，个人配置继续保留。AppImage 不自动注册系统应用菜单。也可下载 `tar.gz`，解压后运行目录中的 `dsh-switcher`。

通用包面向带 GTK 3、NSS、ALSA、GBM 等图形运行库的 glibc 桌面系统。Arch 的精简安装可补齐 `gtk3 nss alsa-lib libxss libxtst libnotify libsecret mesa xdg-utils`。AppImage 不会自动关闭 Chromium sandbox；Ubuntu 24.04 等限制用户命名空间的系统优先使用 DEB，其安装脚本提供应用级 AppArmor 配置。

CI 验证 Fedora 44 RPM 的安装、依赖与卸载；Debian 12/13、Ubuntu 22.04/24.04 DEB 的安装、原生桌面集成和卸载；Ubuntu 22.04 与 Arch 的 AppImage 启动。Mint / Manjaro 使用对应上游兼容包，未单独运行发行版测试。Linux 窗口支持 X11 / Wayland，发行版容器测试使用 Xvfb，不代表真实桌面面板验证。

Windows ZIP 解压后运行 `DSH Switcher.exe`；macOS DMG 将应用拖到 Applications。开发版 Windows 包未签名，macOS 包使用临时签名、未公证。

## 当前功能

- 添加、编辑、移除服务器，以及设置启动时使用的默认连接。
- 每台服务器独立的持久化 Cookie 和网页存储；只保留当前一张 DSH 网页，切换会销毁旧网页，返回时重新加载。未保存草稿不会保留。
- 左下角向上展开的服务器菜单，覆盖在原生网页上方。
- 登录链接认证、加载状态、401 / 403 / 网络错误页和重新加载。
- 原生文件选择、下载保存对话框、外部链接，以及客户端明暗主题。
- 本机官方 DSH 一键安装：自动准备 Node.js 和 pnpm、独立更新、自动启动及登录。
- 复用已有官方 DSH CLI，查看本机进度、脱敏日志，启动、停止和重启。
- 默认使用官方数据目录和 `web` profile，与 CC Switch 共享提供商配置；旧独立环境可备份迁移或继续使用。
- 关闭窗口收起到系统托盘；托盘菜单支持显示窗口、切换服务器、本机控制、设置、关于和退出。
- F12 与右下角 `</>` 按钮打开当前网页的 Chromium 开发者工具；支持右键检查元素。
- 快捷操作面板、客户端更新中心，以及跨服务器后台任务通知。

### 开发者工具与快捷操作

右下角刷新按钮旁的 **开发者工具** 按钮与 **F12** 共用开关，打开时按钮高亮。Windows / Linux 也可用 `Ctrl+Shift+I`，macOS 可用 `⌘+Option+I`。开发者工具默认在独立窗口打开，包含 Elements、Console、Network、Application 等 Chromium 面板；加载中或报错的服务器网页也可检查。首页没有服务器网页时检查客户端外壳。切换服务器、收起到托盘或退出时关闭对应工具窗口。

**视图** 菜单和快捷操作面板还提供“客户端界面开发者工具”，用于检查客户端底栏和弹窗。网页右键菜单提供检查元素及适用的剪切、复制、粘贴和全选。

使用 `Ctrl/⌘+Shift+P` 或右下角快捷操作按钮打开命令面板，输入服务器名或操作名称，使用 ↑↓ / Enter 执行。最近使用的服务器优先显示；支持本机进程控制、数据目录、设置、通知和更新。设置中可改用 `Ctrl/⌘+Shift+K` 或 `Ctrl/⌘+Alt+P`。

### 客户端更新中心

通过设置、快捷操作或托盘打开更新中心。默认检查 `dev` 开发版，也可选择稳定版；稳定版尚未发布时会说明检查失败。启动自动检查默认关闭，可在界面启用。客户端升级与本机官方 DSH 的独立更新各有入口。

更新中心识别平台、架构和 RPM / DEB / AppImage 等安装来源，也可手动选择该平台支持的包格式。版本和包信息取自本仓库 GitHub Release 与构建清单；下载支持进度、取消、重试，大小和 SHA256 验证成功后才提供打开入口。RPM / DEB / DMG 交给系统安装工具，ZIP / AppImage / tar.gz 定位到下载目录，由用户替换程序。下载不自动退出客户端或停止本机任务。

### 任务通知中心

通过右下角铃铛、快捷操作或托盘打开通知中心，勾选需要监听的服务器。支持任务完成、失败和等待输入消息，提供声音、免打扰、未读标记、全部已读和清空记录。系统不支持原生通知时仍可查看通知历史。

后台通过已登录服务器的官方 `session/control`、`session/observeEvent` 和只读会话接口监听，已对 DSH `0.2.2-rc.1` 验证。仅明确的 `turn/end` 成功结果算完成，取消不会误报成功；等待审批和回答按服务端 `pendingInput` 状态检查。首次连接不弹出历史任务，重连对事件去重。不兼容或登录失效的连接会显示具体状态。

监听独立于网页生命周期：切换服务器销毁旧网页后、收起窗口后仍监听，退出客户端则结束。最多勾选 20 台服务器，每台跟踪最近 100 个活跃普通会话；每 10 秒发现会话并检查等待输入状态，历史保留最近 200 条。通知记录位于 `userData/notifications.json`。官方网页目前没有可用的会话深链接，点击通知会打开对应服务器并提示会话名称，也可复制会话 ID；等待输入是否持续保留取决于服务端和其他在线回答界面。

## 在本机安装 DSH

安装客户端后，首页选择 **使用本机 DSH**，或从左下角实例菜单打开 **本机 DSH → 管理**。点击 **安装官方 DSH 并启动**：

1. 从官方 npm 查询所选版本（`latest` 或精确版本号）的 Node.js 要求。
2. 优先使用本机兼容且带 npm 的 Node.js；缺少时优先下载兼容的官方 Node.js 24 LTS，只有 DSH 要求更高版本时才选择其他兼容 LTS，并核对官方 SHA256 清单。Node.js 和 DSH 均按本机架构安装。
3. 在用户目录安装官方 `@deepseek-ai/dsh` 和固定版本 pnpm，验证 CLI 后启用。无需 sudo，不修改系统全局 npm 安装。
4. 使用所选数据目录、标准 `web` profile 和系统分配的回环端口启动。只读取本次子进程返回的启动链接，自动认证后打开 DSH 原生网页。

本机管理页显示阶段、下载进度、错误和取消入口；安装期间可以继续切换远程连接或收起窗口。程序运行环境位于 Electron `userData/local-runtime/`，数据目录独立选择，默认遵循继承的 `DSH_HOME`，未设置时为 `~/.dsh`。**数据目录与 CC Switch 兼容** 区域显示实际路径和 profile，并可复制、打开或改用自定义绝对路径。

**使用本机已有的 DSH** 可自动检测或手动填写官方 CLI 与 Node.js 路径；客户端复用这个 CLI，并在自己目录准备 pnpm。该方式使用所选数据目录。仅选择 CLI 不会接管已经运行的其他 DSH 服务。

**更新官方 DSH** 查询官方 npm，安装新版本到新目录。安装验证成功后停止本机进程、切换运行环境并重启；正在执行的任务会中断。下载、安装或校验失败时保留当前配置和运行环境，旧安装目录保留供排查。新版本启用后的启动失败会显示日志；持久化数据可能已迁移，因此不自动降级，也不接受低于当前 DSH 的版本。

明确选择 **退出** 才会停止客户端托管的本机 DSH 和安装子进程；守护进程通过标准输入生命周期处理客户端异常退出。远程服务器由服务端管理。连接、运行环境和 DSH 数据在卸载客户端时保留。

下载遵循继承的代理变量，未设置时查询桌面系统代理。npm 包操作使用同一个代理选择。原始 npm 安装输出不向界面或日志转发；失败显示错误代码。DSH 运行日志对 token、Cookie 和常见认证字段脱敏并限量保留。

### CC Switch 与旧数据升级

让 CC Switch 的 DSH 数据目录与本机管理页显示的路径一致。客户端选用 `web` profile，读取 `profiles/web/cordis.patch.yml` 与共享 `.credentials.yaml`，提供商、模型和凭据由官方 DSH 解析。CC Switch 使用自定义目录时，在客户端选择同一路径；桌面菜单启动的应用不一定继承终端里的环境变量。修改后可重启本机 DSH 以重新读取配置。

升级旧客户端时，设置文件自动迁移到 v4，保留对应的 `settings.json.v1.bak`、`settings.json.v2.bak` 或 `settings.json.v3.bak`。发现旧 `local-dsh` 环境后先展示选择界面，确认前不自动启动：

- **备份迁移并启动**：仅允许空的官方目标目录；保留旧环境并备份到 `userData/backups/`，复制到临时目录，将 `switcher` profile 转为 `web`，恢复插件依赖并用官方 CLI 验证，再启用。不会覆盖已有官方数据。
- **使用官方目录**：直接使用现有 `DSH_HOME` / `~/.dsh`，保留旧环境。
- **继续旧环境**：沿用 `userData/local-dsh` 和 `switcher` profile；可稍后迁移，该 profile 不在 CC Switch 默认管理范围内。

迁移失败或取消时保留旧数据及已创建的备份，不切换数据环境。旧环境同时存在 `web` 和 `switcher`、目录互相包含、目录包含符号链接等情况会停止迁移；依赖目录 `node_modules` 不复制，由 pnpm 恢复。迁移需要一个已安装的官方 CLI；尚未安装时，可先选择继续旧环境完成安装。

### 托盘与桌面环境

点击 **×** 默认收起窗口，保留当前网页、本机 DSH 和后台安装。托盘右键菜单或再次启动应用可恢复窗口。客户端设置可改为最小化或退出；切换服务器只销毁网页，不停止本机服务。

Linux 通过会话 D-Bus 检测实际 StatusNotifier / AppIndicator watcher 和注册的托盘宿主，优先适配 Fedora KDE，同时适用于提供该服务的其他 X11 / Wayland 桌面。没有托盘时关闭窗口退化为最小化，并显示原因；托盘服务消失时会恢复隐藏窗口。GNOME 可启用 AppIndicator 扩展，平铺桌面需配置面板托盘（例如 Waybar）。Windows / macOS 使用 Electron 原生托盘。

自动化覆盖托盘探测、菜单状态、窗口收起/恢复和退出清理；Linux headless / Xvfb 测试不等同于实际 KDE、GNOME、Wayland 面板的人工验证。

## 从源码运行桌面版

需要 Node.js 22.12 或更新版本，以及 Windows、macOS 或 Linux 图形桌面。

```sh
npm ci
npm run dev
```

`dev` 为客户端界面提供热更新；主进程或 preload 修改后需要重新运行命令。

构建后运行：

```sh
npm run build
npm start
```

Linux 需要 Electron 所需的系统图形库和可用的显示服务。正常桌面运行不关闭 Chromium sandbox。

## 添加 DSH 服务器

1. 在服务器启动 `dsh --profile web --no-open`。
2. 确认 DSH Web 地址能从客户端访问。仅监听服务器回环地址时，先配置转发、SSH 隧道或受支持的远程部署。
3. 在客户端左下角选择“添加服务器”，填写名称和网页地址。
4. 首次访问出现“需要登录”时，填写 DSH 启动时给出的完整登录链接。添加连接时也可以直接使用启动链接。

支持 `http://`、`https://` 和路径前缀，例如 `https://example.com/dsh/`。登录链接只能属于同一个服务器和应用路径。客户端在该服务器独立的 Electron 会话中用启动 token 换取 Cookie，再用不含 token 的首页请求验证 Cookie，验证通过后才打开原生网页；连接配置和网页导航不包含 token。验证请求共用 15 秒超时，失败提示保留在表单中并区分 token 被拒绝、Cookie 验证失败、地址被拒绝及网络错误。诊断不会包含 token 或 Cookie 值。

切换服务器快捷键：**Ctrl / ⌘ + Shift + S**。

移除连接会关闭其网页并删除连接配置，不删除服务端会话或文件。旧的本地浏览器分区暂时保留，重新添加会使用新的分区。修改连接地址也使用新的登录分区。

## 浏览器界面预览

```sh
npm run preview
```

打开 `http://localhost:5178`。这是有明确标记的交互演示，连接列表使用示例数据，不访问填写的服务器，也不保存真实凭据。**只有 Electron 桌面版加载真实 DSH 网页。**

客户端界面的主题与 DSH 网页的主题独立；会话、工具、设置和插件均由服务器的网页管理。状态“网页已打开”表示页面加载完成，不代表所有模型和插件服务都健康。客户端不提供跨服务器会话聚合或自动 SSH 隧道。

## 验证与打包

```sh
npm test
npm run test:release
npm run build
npm run test:desktop
npm run test:real-dsh
npm run test:local-runtime
npm run package:linux
npm run package:win
npm run package:mac
```

桌面测试使用独立的临时用户目录、`DSH_HOME` 和 HTTP 测试服务，验证真实 WebContentsView 销毁与重建、Cookie 保留、单网页约束、F12/按钮开发者工具生命周期、快捷操作键盘交互、更新/通知界面、401 登录、关窗/恢复、明确退出和重启恢复；需要图形显示服务，Linux CI 可用 `xvfb-run -a npm run test:desktop`。`SWITCHER_TEST_HEADLESS=1` 可以尝试 Chromium 的 headless 平台，取决于 Electron 和宿主支持情况。

`test:real-dsh` 需要已安装的 `dsh` 命令（也可通过 `DSH_BIN` 指定），使用隔离的 DSH home 启动真实 Web 服务，验证登录、官方首次启动页面与工作区选择入口。它不发送模型请求，也不需要 API key。

`test:local-runtime` 从干净用户目录强制下载官方 Node.js，再安装指定官方 DSH，验证取消、关窗后台安装、切换网页不重启本机进程、CC Switch 配置读取、自动登录、真实外部插件、失败更新保留旧环境、已有 CLI 接入、旧 profile 备份迁移与依赖恢复，以及退出清理和客户端重启。本机模拟模型服务还让官方 DSH 实际执行成功和失败的轮次，验证页面销毁、窗口收起后收到通知及重启保留历史。测试使用虚构凭据，不调用真实模型，默认 DSH `0.2.2-rc.1`，可通过 `SWITCHER_TEST_DSH_VERSION` 指定。`SWITCHER_TEST_EXECUTABLE` 可指定打包后的应用；首次下载需要访问 Node.js 和 npm 官方站点。

产物位于 `release/`。`package:linux` 一次生成 RPM、DEB、AppImage 和 tar.gz。构建 RPM 需要 `rpmbuild`（Fedora 安装 `rpm-build`，Ubuntu 安装 `rpm`）；AppImage 使用固定版本工具集。Windows 和 macOS 推荐在对应系统打包；Actions 使用各系统原生 runner。打包器使用官方平台 PNG 生成平台图标。

## 自动检查与 dev 发布

`.github/workflows/desktop.yml` 在 `main` 推送、PR 和手动触发时运行：

1. `npm ci` 使用锁文件安装；actionlint 检查工作流；运行单元测试、发布完整性测试、TypeScript 检查和生产构建。
2. 桌面集成测试验证原生网页销毁/重建、401 登录、Cookie 隔离与保留、菜单层级、关窗/恢复和退出。
3. Linux、Windows、macOS arm64 / x64 各自构建，对打包后的应用运行桌面与本机安装集成测试，检查实际进程架构；本机安装测试强制使用下载的 Node.js，不复用 runner 的系统 Node。
4. Linux 额外验证 Fedora 44 RPM，以及 Ubuntu 上的 AppImage 实际启动入口。
5. 独立兼容性矩阵在 Debian 12/13、Ubuntu 22.04/24.04 中安装 DEB，检查依赖、图标、desktop 文件、实际 GUI 集成与卸载；Arch 容器验证 AppImage。容器以普通用户运行应用，使用隔离的 home、D-Bus 与 Xvfb；仅容器测试因命名空间限制传入 `--no-sandbox`，原生 runner 测试和发行包保持默认 sandbox。
6. 每个平台生成带 SHA256、大小、版本和源码提交的产物清单；发布前必须集齐四个平台的九个安装包/归档，缺少 DEB 或 AppImage 同样阻止发布。

只有 `main` 的 push / 手动构建会发布。固定标签 **`dev`** 对应 Pre-release；版本形如 `0.1.0-dev.42.1`，末两段是工作流运行编号和重试次数，RPM / DEB 使用 `~dev` 版本排序。不同开发构建可以由 `dnf` / APT 正确比较；稳定版版本号高于同基线的开发版。

所有检查、平台构建和 Linux 发行版兼容性验证都成功后才更新发布。发布任务串行执行，并检查源码是否仍是最新 `main`，避免旧构建覆盖新开发版。产物使用带版本号的文件名，全部上传成功后才更新标签和发布说明，再清理旧构建资产。上传中断可能留下新版本的部分资产，但不会先删除上一版。PR 只运行检查和构建，不发布。

Release 包含全部安装包、SHA256 校验文件和构建清单。发布使用工作流自带 `GITHUB_TOKEN`；只有发布 job 获得 `contents: write`，无需额外 PAT。`test:real-dsh` 是独立的本地兼容性验证，不属于默认 CI，以免打包流程依赖模型凭据或额外 DSH 安装。

## 项目结构

- `src/main/`：Electron 主进程、原生网页容器、配置和 URL 校验。
- `src/renderer/`：客户端外壳、服务器菜单和浏览器预览。
- `src/shared/`：主进程与界面之间的 IPC 类型。
- `tests/`：配置事务和 URL / 登录凭据处理测试。
- `scripts/`：开发、构建和桌面集成验证。

配置保存在 Electron `userData` 目录中的 `settings.json`。远程网页不加载客户端 preload，不能调用连接管理 IPC；每个服务器使用独立 `persist:dsh-<id>` 分区。
