# Neo 独立守护与自动恢复进程 (`neo-recovery`)

一个**完全独立于 Neo 业务逻辑**的轻量守护进程与自动恢复系统。零三方运行时依赖，可编译为单个可执行文件独立运行，由它启动并看护目标 Neo 服务；当嗅探到 Neo 长时间不可用时，自动进入恢复模式，读取 Neo 后端配置的 Worker 执行修复并重启，同时直接通过 Neo 原有入口实时展示整个修复过程细节。

## 核心设计

1. **完全解耦与零三方依赖**
   - 不引用 Neo 仓库中的任何业务代码、框架或 `node_modules`，仅使用 Bun / Node 内置标准库与只读 `bun:sqlite`。
   - 拥有独立的状态与日志目录（默认 `~/.local/state/neo-recovery`），即使 Neo 源码、构建产物或运行环境受损，守护进程依然稳定运行。
   - 仅以只读短连接读取 `<dataDir>/orchestrator.sqlite` 中最新一版 `settings-version:<rev>`，获取后端当前配置的 `kernel`、`models.<kernel>.executor` 以及 `recoveryMode` 开关；若数据库损坏或缺失，自动降级为默认 `agy` 运行时并保持恢复启用，不会影响恢复启动。
   - **在 Neo 中一键开关**：可在 Neo 界面 **设置 → 自动恢复 → 开启恢复模式**（或 `PUT /api/settings/general {"recoveryMode": true|false}`）实时开启或关闭恢复模式，守护进程在下一次探测周期内自动生效，无需重启；关闭后仅保留常规监测与重启，不自动调用修复 Worker。

2. **由守护进程启动目标 Neo 服务，并无缝接管入口可见性**
   - **默认 `proxy` 模式（推荐，零切换间隙）**：
     - 守护进程监听 Neo 对外入口（如 `0.0.0.0:3082`），以子进程组方式启动 `neo-agent serve --host 127.0.0.1 --port <internalPort>`。
     - **正常运行期间**：透明转发所有 `/`, `/api/*` 与静态资源流量给 Neo（并自动将 `Transfer-Encoding: chunked` 规范化为 `Content-Length` 兼容 Neo HTTP 服务）；同时始终保留 `/_recovery` 路径用于查看守护状态与历史恢复记录。
     - **故障 / 修复 / 重启验证期间**：用户访问 Neo 入口（`http://<host>:3082/`）直接看到实时**自动恢复控制台**；已打开的 Neo 页面轮询 `/api/*` 会收到明确的 `503` 恢复提示；修复并验证健康后，页面自动倒计时返回 Neo 主界面。
   - **可选 `takeover` 模式（正常期零代理）**：
     - 守护进程直接让 Neo 监听对外入口（`0.0.0.0:3082`）；仅在进入恢复模式并停止故障 Neo 进程后接管 `3082` 端口提供实时恢复控制台，修复结束后释放端口并重新拉起 Neo。

3. **稳健的状态机与防抖动保护**
   - 持续嗅探 `/api/health`（支持 `NEO_TOKEN`、超时检测与进程存活检测）。
   - 短暂崩溃先做常规快速重启；仅在**持续不可用达到阈值**（默认 `60s` 且至少连续 `3` 次探测失败）后才自动进入恢复模式，避免误触发。
   - 自动按指数退避冷却（默认最多连续 3 次高频尝试，随后降频为 15 分钟重试，并支持在入口页手动触发或中止），防止死循环消耗额度。
   - 自动复用 Neo 网页端保存在 `localStorage["neo-agent"]` 的访问令牌，且对所有日志、诊断文件和 SSE 事件流自动脱敏 `NEO_TOKEN`。

4. **修复过程细节实时可见**
   - 恢复模式实时解析 Antigravity CLI（`agy --output-format stream-json`）事件流，并通过 SSE（`/_recovery/events`）推送到 Neo 入口页：
     - 阶段进度条（嗅探异常 → Worker 诊断修复 → 重启与健康验证 → 服务正常运行）
     - 当前使用的后端 Worker 配置（kernel、model、配置版本、运行时路径）
     - Worker 实时分析输出、每一次工具调用（命令/文件/参数、运行状态、耗时及可展开输出）
     - Neo 故障日志尾与历史恢复记录

## 快速开始

### 构建独立二进制

```bash
bun run build
# 产出单文件可执行程序：dist/neo-recovery
```

### 环境自检（`doctor`）

```bash
./dist/neo-recovery doctor \
  --target-bin /nvme/workspace/neo/backend/dist/neo-agent \
  --repo-dir /nvme/workspace/neo \
  --web-dir /nvme/workspace/neo/app/build/web
```

### 前台独立启动

```bash
NEO_TOKEN="<your-token>" ./dist/neo-recovery start \
  --mode proxy \
  --host 0.0.0.0 \
  --port 3082 \
  --internal-port 13082 \
  --target-bin /nvme/workspace/neo/backend/dist/neo-agent \
  --web-dir /nvme/workspace/neo/app/build/web \
  --repo-dir /nvme/workspace/neo \
  --data-dir ~/.local/state/neo-agent \
  --state-dir ~/.local/state/neo-recovery \
  --unhealthy-after 60
```

也可通过 JSON 配置文件启动（见 `config.example.json`）：

```bash
NEO_TOKEN="<your-token>" ./dist/neo-recovery start --config ./config.example.json
```

### 查询状态

```bash
NEO_TOKEN="<your-token>" ./dist/neo-recovery status --url http://127.0.0.1:3082
```

### 部署为 systemd 用户服务（替换直接运行 `neo-agent.service`）

```bash
chmod +x systemd/install-user-service.sh
./systemd/install-user-service.sh
# 按输出提示执行切换：
systemctl --user disable --now neo-agent.service
systemctl --user enable --now neo-recovery.service
```

## 运行测试

```bash
bun test
```
