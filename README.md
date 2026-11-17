# Neo

**一个替你干活的 AI 助手。** 你在应用里（或微信里）说要做什么，它先判断该不该做，然后给每件事开一个独立的 Worker，在单独的目录里写代码、跑命令，做完把结果回到你说话的那个对话里。

> 设计原则：**占用人的注意力尽量少，给出的价值尽量多。** 只在被明确请求时行动；只在需要你决定或有了结果时说话；失败如实说失败。

## 它由什么组成

| 部分 | 技术 | 说明 |
| --- | --- | --- |
| 后端 `neo-agent` | Rust | 一个可执行文件：领域引擎、SQLite 存储、HTTP API、看护与微信桥 |
| 界面 | Flutter | 同一套代码出桌面应用（macOS / Windows / Linux）和网页版，苹果风格，跟随系统明暗 |
| 执行内核 | Claude Code、Oh My Pi、Antigravity CLI 或 Hermes Agent | 真正调用模型干活的代理运行时，作为子进程由后端驱动，在设置里切换 |

两种用法：

- **桌面应用**：安装后打开即用。应用自己启动并看护本机后端，数据留在这台电脑上。
- **服务器**：`neo-agent serve` 无界面运行，提供 API 并托管网页版；浏览器或别处的桌面应用连上来用。

同一台电脑同一用户默认只运行一个 Neo：第二次打开桌面应用会把已开的窗口带到前面；第二个后端会直接退出并说明。

## 能做什么

- **对话派活**：说出需求 → 确认收到 → Worker 在自己的目录里执行 → 结果回到对话。附件每条最多 3 个、每个 5 MiB。
- **任务视图**：每个任务的状态、等待你回答的问题、后台任务、最新报告和最近活动。
- **微信**：在设置里扫码绑定一个微信号，直接在微信里发需求、收结果和文件。
- **长任务与看护**：超过一分钟的命令自动转后台，跑完唤醒 Worker；Worker 可并行派子代理。独立的看护（Watchdog）定时巡检：正常推进的不打扰，卡死的任务取消并唤醒恢复，漏发的回复补发。
- **只读提问**：任务进行中问"现在怎么样了"，由旁路会话回答，不打断 Worker。
- **全部在界面里配置**：调度与 Worker 各自的内核与模型（可以混搭，例如调度用 Oh My Pi、Worker 用 Claude Code）、同时运行的 Worker 数、任务目录、准备命令、屏蔽的命令、暂停开关——不需要手写配置文件。

## 安装

发行页提供三种安装包，都自带后端；执行内核（Claude Code、Oh My Pi、Antigravity CLI、Hermes Agent）不随包附带：

| 系统 | 安装包 |
| --- | --- |
| macOS（Apple 芯片 / Intel 各一个） | `Neo-<版本>-macos-arm64.dmg` / `-x64.dmg` |
| Windows x64 | `Neo-<版本>-windows-x64-setup.exe` |
| Linux 服务器 | `neo-agent-<版本>-linux-x64.tar.gz` |

安装步骤、模型接入、服务器部署见 **[SETUP.md](SETUP.md)**。

执行内核：Neo 会自动发现本机已装的 `claude`、`omp`、`agy`、`hermes`（`PATH` 或各自安装器的默认目录）。没装的话，在 设置 → 内核与模型 里点「安装」，Neo 会运行该内核的官方安装脚本，装好即可选用，不用重启。

模型接入：Claude Code 内核读取 `ANTHROPIC_*` 环境变量或你已有的 Claude Code 登录；Oh My Pi 内核使用它自己目录里的 provider 配置；Antigravity 内核使用 `agy` 已登录的 Google 账号（装好后在终端运行一次 `agy` 登录）；Hermes Agent 内核使用 `~/.hermes` 里的模型与提供商配置（装好后运行 `hermes setup` 配置），Worker 启用跨会话记忆与技能演进。Worker 要用 git 时，机器上需要装有 git。

## 从源码运行

需要 Rust 1.89+ 和 Flutter 3.50。

```sh
cd backend && cargo build -p neo-agent
cd ../app && flutter pub get && flutter build web --release --no-web-resources-cdn --csp --no-source-maps
cd .. && backend/target/debug/neo-agent doctor                 # 看这台机器具备什么
backend/target/debug/neo-agent serve --web-dir app/build/web   # 打开 http://127.0.0.1:3082/
```

桌面应用：`cd app && NEO_AGENT_BIN=../backend/target/debug/neo-agent flutter run -d macos`（或 `windows`、`linux`）。

测试：

```sh
cd backend && cargo test --workspace     # 不需要模型、网络或运行时
cd ../app && flutter analyze && flutter test
```

用真实运行时对本机假模型端点的端到端测试、浏览器测试见 [docs/008-cookbook.md](docs/008-cookbook.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [SETUP.md](SETUP.md) | 各系统安装、模型接入、服务器部署 |
| [docs/000-philosophy.md](docs/000-philosophy.md) | 理念 |
| [docs/001-domain.md](docs/001-domain.md) | 领域概念 |
| [docs/002-authorization.md](docs/002-authorization.md) | 谁可以让它做什么 |
| [docs/003-execution.md](docs/003-execution.md) | 任务如何执行、后台任务与看护、四种内核 |
| [docs/004-prompts.md](docs/004-prompts.md) | 各会话的提示词与工具 |
| [docs/005-sessions.md](docs/005-sessions.md) | 会话、对话与微信 |
| [docs/006-deployment.md](docs/006-deployment.md) | 两种运行方式、单实例、数据目录、访问控制、排障 |
| [docs/007-architecture.md](docs/007-architecture.md) | 代码地图与测试地图 |
| [docs/008-cookbook.md](docs/008-cookbook.md) | 构建、运行、测试 |
| [docs/009-reference.md](docs/009-reference.md) | 命令行、环境变量、设置项、API |
| [docs/010-packaging.md](docs/010-packaging.md) | 安装包的构成与制作 |

## 从旧版（TypeScript）升级

这是一次重写，旧版的状态目录不能打开，也不会迁移：请使用新的数据目录。旧版的 GitHub 集成（Issue / PR 来源、`gh` 封装、CI 观察）已移除；`config.json` 不再使用，原来写在里面的内容现在在应用的设置里。

## 许可

MIT。安装包内附带的执行内核是各自作者的程序，遵循它们自己的条款，见 [docs/010-packaging.md](docs/010-packaging.md)。
