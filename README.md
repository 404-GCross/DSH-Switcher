# DSH Switcher

多服务器 DSH 桌面客户端。主体直接打开各服务器的 **DSH 原生网页**，左下角管理和切换连接；服务端无需安装额外插件。

[下载开发版（dev Pre-release）](https://github.com/404-GCross/DSH-Switcher/releases/tag/dev) · [GitHub Actions](https://github.com/404-GCross/DSH-Switcher/actions/workflows/desktop.yml)

## 下载与 Fedora 安装

开发版支持以下平台：

| 平台 | 架构 | 包格式 |
| --- | --- | --- |
| Fedora / Linux | x86_64 | **RPM**、tar.gz |
| Windows | x64 | ZIP |
| macOS | Apple Silicon arm64、Intel x64 | DMG、ZIP |

Fedora 优先使用 RPM。在开发版页面下载当前的 `linux-x64.rpm` 文件，在只包含该版本 RPM 的目录执行：

```sh
sudo dnf install ./DSH-Switcher-*.rpm
```

RPM 安装运行依赖、菜单入口和图标；安装后从应用菜单打开 **DSH Switcher**，或运行 `dsh-switcher`。下载新版 RPM 后用相同命令更新。卸载使用 `sudo dnf remove dsh-switcher`；个人连接和登录数据保留在用户目录。

Linux 原生支持 X11 / Wayland；CI 验证 Fedora 44 的安装、依赖与卸载，并在 Linux 图形测试环境运行桌面集成测试。Windows ZIP 解压后运行 `DSH Switcher.exe`；macOS DMG 将应用拖到 Applications。开发版 Windows 包未签名，macOS 包使用临时签名、未公证。

## 当前功能

- 添加、编辑、移除服务器，以及设置启动时使用的默认连接。
- 每台服务器独立的持久化 Cookie 和网页存储；切换时保留已打开网页。
- 左下角向上展开的服务器菜单，覆盖在原生网页上方。
- 登录链接认证、加载状态、401 / 403 / 网络错误页和重新加载。
- 原生文件选择、下载保存对话框、外部链接，以及客户端明暗主题。

## 运行桌面版

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
npm run package:linux
npm run package:win
npm run package:mac
```

桌面测试使用独立的临时用户目录和 HTTP 测试服务，验证真实 WebContentsView、401 登录、Cookie 隔离、菜单层级和重启恢复；需要图形显示服务，Linux CI 可用 `xvfb-run -a npm run test:desktop`。`SWITCHER_TEST_HEADLESS=1` 可以尝试 Chromium 的 headless 平台，取决于 Electron 和宿主支持情况。

`test:real-dsh` 需要已安装的 `dsh` 命令（也可通过 `DSH_BIN` 指定），使用隔离的 DSH home 启动真实 Web 服务，验证登录、官方首次启动页面与工作区选择入口。它不发送模型请求，也不需要 API key。

产物位于 `release/`。Linux 构建 RPM 需要 `rpmbuild`（Fedora 安装 `rpm-build`，Ubuntu 安装 `rpm`）。Windows 和 macOS 推荐在对应系统打包；Actions 使用各系统原生 runner。SVG 图标在构建时生成 PNG，并由打包器生成平台图标。

## 自动检查与 dev 发布

`.github/workflows/desktop.yml` 在 `main` 推送、PR 和手动触发时运行：

1. `npm ci` 使用锁文件安装；actionlint 检查工作流；运行单元测试、发布完整性测试、TypeScript 检查和生产构建。
2. 桌面集成测试验证原生网页、401 登录、Cookie 隔离、页面草稿、菜单层级和重启恢复。
3. Linux、Windows、macOS arm64 / x64 各自构建，并对打包后的应用运行同一套集成测试，检查实际进程架构。
4. Linux 额外在 Fedora 44 容器中安装 RPM，检查依赖、图标、desktop 文件、可执行文件和卸载。
5. 每个平台生成带 SHA256、大小、版本和源码提交的产物清单；发布前验证所有四个平台的完整性。

只有 `main` 的 push / 手动构建会发布。固定标签 **`dev`** 对应 Pre-release；版本形如 `0.1.0-dev.42.1`，末两段是工作流运行编号和重试次数，RPM 使用 `~dev` 版本排序。不同开发构建可以由 `dnf` 正确比较；稳定版版本号高于同基线的开发版。

所有检查、平台构建和 RPM 验证都成功后才更新发布。发布任务串行执行，并检查源码是否仍是最新 `main`，避免旧构建覆盖新开发版。产物使用带版本号的文件名，全部上传成功后才更新标签和发布说明，再清理旧构建资产。上传中断可能留下新版本的部分资产，但不会先删除上一版。PR 只运行检查和构建，不发布。

Release 包含全部安装包、SHA256 校验文件和构建清单。发布使用工作流自带 `GITHUB_TOKEN`；只有发布 job 获得 `contents: write`，无需额外 PAT。`test:real-dsh` 是独立的本地兼容性验证，不属于默认 CI，以免打包流程依赖模型凭据或额外 DSH 安装。

## 项目结构

- `src/main/`：Electron 主进程、原生网页容器、配置和 URL 校验。
- `src/renderer/`：客户端外壳、服务器菜单和浏览器预览。
- `src/shared/`：主进程与界面之间的 IPC 类型。
- `tests/`：配置事务和 URL / 登录凭据处理测试。
- `scripts/`：开发、构建和桌面集成验证。

配置保存在 Electron `userData` 目录中的 `settings.json`。远程网页不加载客户端 preload，不能调用连接管理 IPC；每个服务器使用独立 `persist:dsh-<id>` 分区。
