# GPUStatus

多机 GPU / CPU / 内存监控看板。**中心主动采集**、**目标机器零安装**、**轻量 SQLite 留存用量记录**。

- 纯 SSH 轮询采集，客户机上不装 agent、不装 Python、不开端口
- 后端依赖极少（`better-sqlite3` + `jsonc-parser` + `zod`），HTTP 用 Node 内置 `node:http`
- 按用户名展示：哪台机器、哪张卡、占多少显存、GPU 利用率多少
- 状态灯 **绿 → 黄 → 红**，上下线进事件表
- 每小时用户用量汇总**永久保留**，原始采样可定期清理
- 要统计哪些机器，只改 `config/hosts.json`

贡献者 / Agent 请先读 [AGENTS.md](AGENTS.md)。详细规范：[docs/ui.md](docs/ui.md)、[docs/data.md](docs/data.md)、[docs/ops.md](docs/ops.md)。

---

## 1. 架构

```
config/hosts.json ──► Collector ──ssh(复用)──► 目标机 remote-probe.sh
                           │                    (sh/awk/nvidia-smi，零安装)
                           ▼
                     State（状态灯 + events）
                           ▼
                     SQLite（原始采样保留期清理 · 用量汇总永久）
                           ▼
                     HTTP API + SSE ──► React 前端 (web/dist)
```

数据流是**中心拉取**：目标机完全被动，新增机器不需要在客户侧做任何配置。

每次采集每台机器 1 条 SSH 命令（`ssh <host> sh -s < remote-probe.sh`），CPU 用相邻两次 `/proc/stat` 差值计算，不在目标机 sleep。

---

## 2. 环境要求

**部署机**：Node.js ≥ 20、免密 SSH 到所有被监控机器、首次构建需要 npm。

**被监控机器**：不需要安装任何东西。只需免密 SSH、系统自带 `sh`/`awk`/`ps`/`df` 等、以及 `nvidia-smi`。探针只读、不联网、不需要 root。

```bash
ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519   # 若还没有
ssh-copy-id gpu19
ssh gpu19 'nvidia-smi --query-gpu=index --format=csv,noheader'  # 验证免密
```

---

## 3. 快速开始

```bash
npm --prefix web install && npm run build

cp config/hosts.example.json config/hosts.json
cp config/prices.example.json config/prices.json
vi config/hosts.json

node server/index.js --once   # 单次试跑，确认能采到数据
npm start                     # http://<部署机IP>:8787
```

> `config/hosts.json` 含真实机器名与管理密码哈希，**不进版本库**。忘了复制也能启动（用示例配置并提示），只是示例里的机器连不上。
>
> `--once` 下 CPU 显示 `-` 是正常的：CPU 依赖两次采集差值。

开发模式：

```bash
node server/index.js --no-poll   # 只跑 API，不采集
npm --prefix web run dev         # Vite，自动代理 /api 到 8787
```

---

## 4. 配置说明

`config/hosts.json` 支持注释（JSONC）和尾逗号。字段摘要：

```jsonc
{
  "site": "NPUCVR",                 // 顶栏站点名；空则显示 GPUStatus
  "server": { "port": 8787, "bind": "0.0.0.0", "web_dist": "web/dist" },
  "poll": {
    "interval_ms": 15000,           // 采集间隔
    "timeout_ms": 12000,
    "stale_after_ms": 45000,        // 超时未成功 → 黄灯
    "down_after_failures": 3        // 连续失败 → 红灯
  },
  "ssh": {
    "user": "",
    "control_persist_s": 60,
    "connect_timeout_s": 6,
    "extra_options": []
  },
  "db": { "path": "data/gpustatus.db", "raw_retention_hours": 168 },
  "naming": { "strip_domain": true, "capitalize": true },
  "disk_exclude": ["/", "/boot/efi"],
  "gpu_names": { "NVIDIA GeForce RTX 3090": "RTX 3090 (24G)" },  // 键=nvidia-smi 原始名
  "announcement": { "enabled": false, "level": "info", "title": "", "body": "" },
  "admin": { "password_sha256": "…", "session_hours": 12 },       // 不设则管理页不可用
  "hosts": [
    {
      "id": "gpu19",                // 唯一标识（改 id = 换机器，历史断开）
      "ssh": "gpu19",               // 只是「怎么连」，不是显示名
      "group": "NPUCVR",            // 仅当与 site 不同才显示
      "expect_gpus": 8,             // 可选；没配则跟机器自身近期基线比
      "label": "自定义名",           // 可选；否则从 hostname 解析显示名
      "disks": ["/", "/home"],      // 留空 = 自动发现挂载点
      "net_mounts": ["/share"],     // NFS：只判断是否挂上，不算容量
      "note": "本机维护公告"
    }
  ]
}
```

显示名优先级：`label` > hostname 解析 > `id`。

### 价目表 `config/prices.json`

与机器配置解耦，可单独改价（热生效）：

```jsonc
{
  "label": "2026 对标国内租卡价",
  "rates": {
    "NVIDIA GeForce RTX 3090": 1.2,   // 键必须是 nvidia-smi 原始名
    "NVIDIA L40": 3,
    "NVIDIA RTX 5880 Ada Generation": 3,
    "NVIDIA RTX 6000D": 10
  }
}
```

成本按**当前价目 × 占用卡时**在查询时换算，改价即整段历史重算；未定价不按 0 计。口径详见 [docs/data.md](docs/data.md)。

配置改动**自动热重载**（约 0.4s），写坏不会打挂服务（保留旧配置并记日志）。

---

## 5. 功能一览

| 页签 | 内容 |
|---|---|
| 总览 | 机器摘要 + GPU/进程表、磁盘、网络挂载、温度余量、降频提示、机器详情趋势 |
| 用户 | 按人聚合占用、利用率效率、已运行时长 |
| 用量 | 占用 GPU 时 / 有效 GPU 时 / 显存积分 / 占用成本（按当前价目） |
| 价目表 | 静态卡型价目 |
| 事件 | 状态灯变化、卡数变化等 |
| 管理 | 增删机器、磁盘目录、采集参数（需密码） |

界面与颜色语义、告警规则见 [docs/ui.md](docs/ui.md)。

---

## 6. 管理页面 `/admin`

- 增删机器、改 SSH 目标 / 显示名 / 分组 / 预期卡数 / 磁盘目录
- 改采集间隔、超时、黄灯红灯阈值、显示名规则
- 保存立即热生效；保存前校验，并检查文件是否被他人改过（冲突则 409，不静默覆盖）

设置密码（改文件后重启）：

```jsonc
"admin": {
  "password_sha256": "node -e \"console.log(require('crypto').createHash('sha256').update('密码').digest('hex'))\"",
  "session_hours": 12
}
```

- 两个密码字段都不写 = 管理页不可用（没有默认口令）
- 密码只能改文件，不能在管理页里改（丢了永远能救回来）
- 会话 Cookie 为 HttpOnly + SameSite=Strict；连续失败 5 次锁 15 分钟
- **服务是 HTTP**，可信内网之外请套 HTTPS 或 SSH 隧道

---

## 7. API

| 端点 | 说明 |
|---|---|
| `GET /api/health` | 存活与配置摘要 |
| `GET /api/snapshot` | 当前全量快照 |
| `GET /api/stream` | **SSE** 实时快照 |
| `GET /api/config` | 公开配置 |
| `GET /api/prices` | 价目表 |
| `GET /api/usage/totals?from=-30d&host=` | 按用户汇总用量 |
| `GET /api/usage?from=-24h&bucket=3600&user=&host=` | 时间序列用量 |
| `GET /api/usage/users` | 近期用户名 |
| `GET /api/history/machine?host=gpu19&from=-24h` | 机器小时趋势 |
| `GET /api/events?limit=100&host=` | 事件记录 |
| `GET /api/admin/session` | 登录状态 |
| `POST /api/admin/login` / `POST /api/admin/logout` | 登录 / 退出 |
| `GET /api/admin/config` / `PUT /api/admin/config` | 读/存配置（**需登录**） |

时间参数：epoch 毫秒、ISO 日期或相对量（`-30m` / `-24h` / `-7d` / `-1y`）。

接口字段的唯一约定在 `shared/schema.ts`（zod），前后端共用。

---

## 8. 数据库

单个 SQLite 文件（默认 `data/gpustatus.db`），WAL。备份：`sqlite3 data/gpustatus.db ".backup out.db"`。

| 表 | 内容 | 生命周期 |
|---|---|---|
| `hosts` | 机器注册表、最近状态 | 永久 |
| `host_sample` / `gpu_sample` / `proc_sample` | 原始采样 | 按保留期清理 |
| `host_hourly` / `usage_rollup` / `usage_peak` | 小时汇总与用量积分 | **永久** |
| `events` | 上下线、采集异常 | 永久 |

---

## 9. 部署（systemd）

```bash
sudo cp deploy/gpustatus.service /etc/systemd/system/
sudo vi /etc/systemd/system/gpustatus.service   # User / WorkingDirectory / ExecStart
sudo systemctl daemon-reload && sudo systemctl enable --now gpustatus
journalctl -u gpustatus -f
```

> `ExecStart` 里的 node 必须是绝对路径。nvm 用户可：
>
> ```bash
> sed "s#^ExecStart=.*#ExecStart=$(command -v node) server/index.js#" \
>   deploy/gpustatus.service | sudo tee /etc/systemd/system/gpustatus.service >/dev/null
> ```

建议用独立服务账号（如 `gpustatus`），并把它的公钥分发到各 GPU 机器。

部署机连不上 GitHub 时用 `tools/offline-update.sh <host> --build`，详见 [docs/ops.md](docs/ops.md)。

---

## 10. 常见问题

**Q: 界面显示"尚未采集到数据"，错误是 `Permission denied (publickey)`**  
A: 免密 SSH 没配好。用 `ssh -o BatchMode=yes <host> true` 验证。

**Q: 状态灯是黄的，错误写着 `nvidia-smi failed: Failed to initialize NVML`**  
A: 目标机 `nvidia-smi` 不可用。探针仍返回 CPU/内存并标出错误，避免整机显示失联而掩盖原因。

**Q: 某台机器 GPU 数是 7 但预期 8**  
A: 界面会告警。通常是掉卡或驱动异常，查 `dmesg` / `nvidia-smi -q`。

**Q: 想加更多机器？**  
A: 在 `hosts` 数组里加一项（或用管理页）。目标机不用改。

**Q: 采集间隔能改到多快？**  
A: 单次采集约 0.7–1.0s，5s 可行；无秒级需求建议 ≥15s，减少对生产机干扰。

**Q: 前后端能分开部署吗？**  
A: 能。`/api/*` 是全部契约，`web/dist` 可交任意静态服务器，并改 `vite.config.ts` 代理目标。

---

## 11. 目录结构

```
GPUStatus/
├── AGENTS.md                  # 贡献/Agent 硬约束与规范索引
├── docs/                      # ui / data / ops 详细规范
├── config/hosts.json          # ★ 要监控哪些机器
├── config/prices.json         # ★ 卡时价目（与 hosts 解耦）
├── shared/schema.ts           # ★ 接口约定唯一来源（zod）
├── server/
│   ├── index.js               # 入口：轮询 + HTTP + 静态托管
│   ├── remote-probe.sh        # ★ 目标机只读探针
│   ├── collector.js / state.js / api.js / auth.js / config.js / prices.js
│   └── db/                    # SQLite 持久层（Db 门面）
├── web/                       # React + Vite 前端
├── tools/                     # screenshot / offline-update / seed-visual-db
├── deploy/gpustatus.service
└── data/gpustatus.db          # 自动创建，纳入备份
```

---

## 12. 开发与测试

```bash
npm test                  # 单元测试（后端 + 前端主题不变量）
npm run typecheck         # 前端 TypeScript
npm run check:render      # 渲染冒烟（需后端在跑；从真实接口拉快照）
npm run screenshot        # 截图目检（playwright-core + chrome-headless-shell）
```

`check:render` 对真实 DOM 断言结构、文本与边界场景；类型检查只能证明结构对得上。UI 改动务必看截图，规则见 [docs/ui.md](docs/ui.md)。

截图：

```bash
npm run screenshot -- --tabs
npm run screenshot -- --theme light --viewport
npm run screenshot -- --selector "#host-gpu19"
```
