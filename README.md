# Neo

**一个替你干活、也能替你管设备的 AI 助手。** 你在桌面端、网页端或微信里说要做什么，它先判断该不该做、有没有关联历史任务，再为每件事分配独立的 Worker，在隔离的目录里写代码、跑命令、操作远程设备，做完把结果和文件直接回到你说话的那个对话里。

> 设计原则：**占用人的注意力尽量少，给出的价值尽量多。** 只在被明确请求时行动；只在需要你决定或有了结果时说话；失败如实说失败。

## 核心功能

### 1. 对话派活与智能调度

- **对话即派活**：在应用或微信里直接提出需求 → 主会话评估范围并确认收到 → 自动分配独立 Worker 与隔离工作目录（可配置准备命令，如自动 `git clone`）执行任务 → 完成后将结果直接送回原对话。
- **附件与多语言自适应**：应用内单条消息支持最多 3 个附件（单个最大 5 MiB），自动内联图片与文本文件、落盘大文件供 Worker 读取；自动沿用提问者的语言回复（中文提问中文回复，英文提问英文回复）。
- **历史任务智能召回与路由澄清**：内置零依赖的中英文混合历史任务检索索引（覆盖标题、摘要、工单目录、交付产物名与数值/版本冲突识别），在派单前自动关联既有任务或交付物；遇到指代不清或可能冲突时，先向用户给出简明编号选项确认，避免重复开单或误挂载。
- **旁路只读提问（Sidecar）**：任务进行中随时询问"现在怎么样了"、查看进展或对比细节，由独立只读会话直接查阅任务目录作答，不打断正在执行的 Worker。

### 2. 任务工作台、并发执行与看护体系

- **四页跨平台工作台**：内置「对话」「任务」「设备」「设置」四页，Apple 风格，自动跟随系统明暗，支持中英文双语，自适应宽屏侧边栏与窄屏底部标签栏；界面右下角常驻实时活动浮窗，展示主会话与各 Worker 当前正在做的事。
- **任务全程可视与一键停止**：在「任务」页查看每个任务的阶段状态、待回答的问题、后台进程、最新报告与最近活动；支持随时**一键停止**运行中的任务，同步终止其子代理与后台作业。
- **长任务后台化与多子代理并行**：运行超过 1 分钟的命令自动转入后台并在完成后唤醒 Worker；Worker 可按子任务拆分最多 8 个并发子代理（或运行并行工作流）协作提速，并通过设置控制全局最大并发 Worker 数（1–16）。
- **内置看护循环（Watchdog）**：每 3 分钟自动巡检一次——正常推进的任务绝不打扰，缺失队列自动补发，卡死的任务自动诊断并取消/唤醒恢复，漏发的回复自动补发；应用重启后自动恢复中断任务，并依靠请求 ID 幂等机制避免重复发消息。
- **独立守护与自动恢复（`neo-recovery`）**：完全解耦于 Neo 业务的零三方依赖独立守护进程（随 Linux 服务器包提供），支持 `proxy`（透明代理、零切换间隙）与 `takeover` 双模式。嗅探到 Neo 持续不可用后，自动拉起配置的修复 Worker 诊断并重启服务，同时在原访问入口通过 SSE 实时展示修复进度、工具调用详情与故障日志；可在 **设置 → 自动恢复** 中一键开关，无需重启。详见 [recovery/README.md](recovery/README.md)。

### 3. 微信深度集成

- **扫码即绑与权限隔离**：在 **设置 → 微信** 中扫码绑定单个微信号（基于 iLink 协议，支持手机验证码确认），绑定后自动加入允许发送者白名单；仅处理该绑定用户的私聊消息，群聊与其他发送者直接丢弃。
- **富媒体与消息聚合**：支持接收文本、语音转写、图片、文件和视频，自动合并短时间内连续发出的多条消息并解析引用文件；支持将最大 100 MiB 的本地文件、图片或视频直接发回微信（附带幂等回执，防重发）。
- **实时状态反馈**：主会话评估、旁路查询或 Worker 后台干活期间，微信端持续显示"正在输入"心跳状态，无需手动催问即可确认任务仍在推进。

### 4. 跨网多设备控制与边缘协同

Neo 支持将控制范围从本机扩展到跨网络的个人电脑、服务器、Docker 容器与嵌入式单片机，并在同一中继上实现多主集群隔离（详见 [docs/011-multi-device.md](docs/011-multi-device.md)）：

- **三层设备架构**：
  - **主控 Neo（Master）**：持久化设备数字孪生（Device Twin）、动态选择链路（LAN / P2P / 中继 / 经 Tier 1 代理）、执行三级风险门禁（`safe_auto` 自动放行、`confirm_required` 人工审批、`forbidden` 禁止执行）与高风险操作审批队列。
  - **Tier 1 操作系统代理（`neo-agent-os`，Rust 原生）**：支持 Linux（x64 / arm64）、macOS（arm64 / x64）和 Windows（x64）；优先通过 RFC 5389 STUN 进行 P2P UDP 打洞直连，不通自动无缝回落 WSS 中继；所有远程能力（`exec`、`fs`、`transfer`、能力探测、Ed25519 验签 OTA 暂存）均受本机**只读 TOML 策略**硬约束，主控无法越权改写；可选开启 `--relay` 兼任局域网单片机网关。
  - **Tier 2 单片机 SDK（`neo-agent-mcu`，纯 C99 静态库）**：面向 ESP32 等受限设备，通过局域网 MQTT 或 COBS 帧 UART/RS485 经 Tier 1 网关接入主控；支持静态动作表、物理边界校验、Deep Sleep 期望状态影子队列（单调 `seq_id` 幂等）与 A/B 分区 OTA，主网关离线时自动抑制子设备重复告警并支持备用网关故障切换。
- **零信任一键纳管与设备管理**：在「设备」页选择目标平台（Linux / macOS / Windows / Docker）与安全策略预设（`personal` / `corp` / `readonly` / `desktop`），即可生成带有效期、阅后即焚、端到端加密（`0xE2` AES-256-GCM）的一键安装命令与二维码，自动完成注册、写入只读策略并安装原生系统服务（systemd / launchd / Windows 计划任务）；界面内实时追踪设备上线、查看延迟（Ping）、撤销票据、复制卸载命令，并支持通过在线 Tier 1 主机直接辅助配置和安装 Tier 2 单片机。
- **轻量零信任中继与四层隔离（`neo-relayd`）**：Go 编写的配套中继与 STUN 服务，采用 10 字节极简二进制帧透传且不接触内层端到端密文；内建单节点/集群令牌桶限流与超额惩罚限速（默认单节点 5 MiB/s，1 分钟流量超 200 MiB 自动限速至 128 KiB/s 持续 1 小时）；支持单中继服务多套独立主控（如个人与公司），通过中继鉴权、端到端加密、主机用户与 cgroup v2、S3 产物前缀实现四层隔离。
- **对话直接控设备**：主会话与 Worker 内置设备工具，可直接在对话或微信中查询在线设备、远程执行任务、审批高风险指令或部署 MCU。

### 5. 全界面配置、账号管理与安全边界

- **零配置文件管理**：所有业务设置均在界面中修改并按版本号持久化到 SQLite，包括调度与 Worker 各自的 Antigravity 模型、最大并发 Worker 数、任务工作目录与准备命令、命令黑名单（通过 `PATH` 替身在所有会话和准备命令中统一拦截）、主动评估与规则、白名单发送者、自动恢复开关、全局暂停开关（暂停期间仍接收消息不丢失）。
- **内置内核安装与账号登录**：自动发现本机 `agy`，缺失时可在 **设置 → 内核与模型** 一键运行官方安装脚本（装完即用，无需重启）；可在 **设置 → Antigravity 账号** 直接登录或登出 Google 账号（自动检测跨系统密钥链与登录文件）。
- **单实例保护与访问控制**：同一台电脑同一用户默认只运行一个 Neo（操作系统文件锁保护；重复打开桌面应用会直接唤起已有窗口）。服务器监听非回环地址时强制要求至少 16 位访问令牌（常量时间校验），无令牌回环访问也会执行严格 Host / Origin 检查；桌面端支持切换直连远程 Neo 服务器。

## 它由什么组成

| 部分 | 技术 | 说明 |
| --- | --- | --- |
| 主控后端 `neo-agent` | TypeScript (Bun) | 零运行时三方依赖，可编译为单个可执行文件：领域引擎、SQLite 存储、HTTP API、历史召回、看护、微信桥与多设备控制面 |
| 客户端界面 | Flutter | 同一套代码出桌面应用（macOS / Windows / Linux）和网页版，Apple 风格，含对话 / 任务 / 设备 / 设置四页，跟随系统明暗 |
| 执行内核 | Antigravity CLI (`agy`) | 真正调用模型干活的代理运行时，作为子进程由纯 TypeScript 后端驱动 |
| 独立恢复守护 `neo-recovery` | TypeScript (Bun) | 零三方依赖单文件守护进程，持续健康监测并在长时故障时自动调用修复 Worker、实时广播恢复进度 |
| Tier 1 设备代理 `neo-agent-os` | Rust | Linux / macOS / Windows 原生边缘代理：P2P 打洞 + 中继回落、本地只读策略沙箱、一键零信任纳管与 MCU 桥接 |
| Tier 2 单片机 SDK `neo-agent-mcu` | C99 | 轻量嵌入式静态库：CBOR + HMAC-SHA256 端到端校验、MQTT / UART 传输、Deep Sleep 影子队列与 A/B OTA |
| 配套中继服务 `neo-relayd` | Go | 轻量零信任二进制转发中继与 RFC 5389 STUN 服务，支持多集群隔离、流控限速与一次性加密纳管票据托管 |

两种主控运行方式：

- **桌面应用**：安装后打开即用。应用自己启动并看护本机后端，数据留在这台电脑上；也可在设置里切换连接远程 Neo 服务器。
- **服务器**：`neo-agent serve`（或由 `neo-recovery` 托管）无界面运行，提供 HTTP API 并托管网页版；浏览器或别处的桌面应用连上来用。

## 安装

发行页通过 GitHub Actions 自动构建并发布多平台安装包（附 `SHA256SUMS.txt` 校验文件），主程序均自带后端；执行内核 Antigravity CLI（`agy`）不随包附带：

| 类别 | 平台与安装包 |
| --- | --- |
| macOS 桌面（Apple 芯片 / Intel） | `Neo-<版本>-macos-arm64.dmg` / `Neo-<版本>-macos-x64.dmg` |
| Windows x64 桌面（安装版 / 便携版） | `Neo-<版本>-windows-x64-setup.exe` / `Neo-<版本>-windows-x64-portable.zip` |
| Linux 桌面 x64（Debian/Ubuntu / 便携包） | `Neo-<版本>-linux-x64.deb` / `Neo-<版本>-linux-x64.tar.gz` |
| Linux 服务器（x64 / arm64，含 `neo-recovery` 与 Web 版） | `neo-agent-<版本>-linux-x64.tar.gz` / `neo-agent-<版本>-linux-arm64.tar.gz` |
| Tier 1 设备代理（Linux / macOS / Windows） | `neo-agent-os-<版本>-linux-{x64,arm64}.tar.gz` / `neo-agent-os-<版本>-macos-{arm64,x64}.tar.gz` / `neo-agent-os-<版本>-windows-x64.zip` |
| 中继服务与单片机 SDK | `neo-relayd-<版本>-linux-{x64,arm64}.tar.gz` / `neo-agent-mcu-<版本>-sdk.tar.gz` |

安装步骤、模型接入、服务器部署见 **[SETUP.md](SETUP.md)**；版本发布流程见 **[docs/010-packaging.md](docs/010-packaging.md)**。

- **执行内核**：Neo 会自动发现本机已装的 `agy`（`PATH` 或官方安装器的默认目录）。没装的话，在 **设置 → 内核与模型** 里点「安装」，Neo 会运行 Antigravity CLI 的官方安装脚本，装好即可使用，不用重启。
- **模型接入**：使用 `agy` 已登录的 Google 账号（装好后可在 **设置 → Antigravity 账号** 中登录，或在终端运行一次 `agy` 登录）。Worker 要用 git 时，机器上需要装有 git。

## 从源码运行

主控后端与界面需要 Bun 1.4+ 和 Flutter 3.50（如需构建多设备组件，额外需要 Rust、Go 1.22+ 或 C99 工具链）：

```sh
cd backend && bun install && bun run build
cd ../app && flutter pub get && flutter build web --wasm --release --no-web-resources-cdn --csp --no-source-maps
cd .. && backend/dist/neo-agent doctor                 # 看这台机器具备什么
backend/dist/neo-agent serve --web-dir app/build/web   # 打开 http://127.0.0.1:3082/
```

桌面应用：`cd app && NEO_AGENT_BIN=../backend/dist/neo-agent flutter run -d macos`（或 `windows`、`linux`）。

测试与性能基准：

```sh
cd backend && bun run check && bun test                # 不需要模型、网络或运行时
cd backend && bun run bench                            # 后端核心热路径性能基准
cd ../app && flutter analyze && flutter test
cd ../recovery && bun run check && bun test            # 独立恢复守护测试
```

多设备组件测试（可选）：

```sh
(cd services/neo-relay && go test -race ./...)
(cd agents/neo-agent-os && cargo test)
(cd agents/neo-agent-mcu && make clean all test size-check)
```

用真实 `agy` 运行时的端到端测试、纯 TypeScript 模拟运行时的浏览器测试见 [docs/008-cookbook.md](docs/008-cookbook.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [SETUP.md](SETUP.md) | 各系统安装、模型接入、服务器部署 |
| [docs/000-philosophy.md](docs/000-philosophy.md) | 理念 |
| [docs/001-domain.md](docs/001-domain.md) | 领域概念 |
| [docs/002-authorization.md](docs/002-authorization.md) | 谁可以让它做什么 |
| [docs/003-execution.md](docs/003-execution.md) | 任务如何执行、后台任务与看护、Antigravity 内核 |
| [docs/004-prompts.md](docs/004-prompts.md) | 各会话的提示词与工具 |
| [docs/005-sessions.md](docs/005-sessions.md) | 会话、对话与微信 |
| [docs/006-deployment.md](docs/006-deployment.md) | 两种运行方式、单实例、数据目录、访问控制、排障 |
| [docs/007-architecture.md](docs/007-architecture.md) | 代码地图与测试地图 |
| [docs/008-cookbook.md](docs/008-cookbook.md) | 构建、运行、测试 |
| [docs/009-reference.md](docs/009-reference.md) | 命令行、环境变量、设置项、API |
| [docs/010-packaging.md](docs/010-packaging.md) | 安装包的构成与制作 |
| [docs/011-multi-device.md](docs/011-multi-device.md) | 跨网多设备控制面、四层隔离与一键纳管 |
| [recovery/README.md](recovery/README.md) | 独立守护与自动恢复进程 `neo-recovery` |

## 从旧版（TypeScript）升级

这是一次重写，旧版的状态目录不能打开，也不会迁移：请使用新的数据目录。旧版的 GitHub 集成（Issue / PR 来源、`gh` 封装、CI 观察）已移除；`config.json` 不再使用，原来写在里面的内容现在在应用的设置里。

## 许可

[MIT License](LICENSE)（Copyright (c) 2026 xbhuang1994）。Antigravity CLI 是第三方程序，遵循其各自条款；Web 内嵌字体遵循各自开源许可，见 [docs/010-packaging.md](docs/010-packaging.md)。
