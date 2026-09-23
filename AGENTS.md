# AGENTS.md

多机 GPU 监控看板：中心 SSH 拉取、**目标机零安装**、单进程 + SQLite。
详细规范在 `docs/`，这里只列硬约束和入口。

## 硬约束

1. **目标机零安装**。探针只允许：`sh` `awk` `sed` `grep` `ps` `df` `hostname` `uname` `date` `nvidia-smi` `/proc`。不写文件、不装包、不开端口。
2. **后端依赖保持极少**：`better-sqlite3`、`jsonc-parser`、`zod`。HTTP 用 `node:http`，实时用 SSE（不用 WebSocket）。
3. **`null` ≠ `0`**。读不到的测量绝不当成 0 参与平均或计费。
4. **校验只用 zod**。接口形状唯一来源是 `shared/schema.ts`；配置结构是 `server/config-schema.ts`。
5. **不加功耗墙告警**。温度 / 热降频保留；满载撞功耗墙是正常表现。
6. **成本只按当前价目 × 占用卡时**，查询时换算。库里不存金额；未定价显示「未定价」，绝不按 0 计。
7. **界面只放数据**，不放说明性文字；告警色只表示「出问题了」。

## 常用命令

```bash
npm test                 # 全部单元测试
npm run typecheck        # 前端类型检查
npm run check:render     # 渲染冒烟（需后端在跑）
npm run screenshot       # 截图目检
npm start                # 启动服务
node server/index.js --once   # 单次采集试跑
```

改完 UI 后：`npm test && npm run typecheck && npm run check:render`，并用 `npm run screenshot` 看图。

部署到 `mgmt2`：`tools/offline-update.sh mgmt2 --build`，再重启 `gpustatus.service`。

## 代码地图

| 路径 | 职责 |
|---|---|
| `server/remote-probe.sh` | 目标机只读探针（POSIX sh + 单次 awk） |
| `server/collector.js` | SSH 采集与 uuid/pid/user 关联 |
| `server/state.js` | 内存状态、状态灯、降频解码、事件 |
| `server/db/` | SQLite 持久层（`Db` 门面） |
| `server/api.js` `server/auth.js` | REST + SSE + 管理认证 |
| `shared/schema.ts` | 前后端共用接口契约（zod） |
| `web/src/components/` | 页面组件 |
| `config/hosts.json` `config/prices.json` | 机器配置 / 价目表（JSONC，热重载） |

## 详细规范索引

| 文档 | 内容 |
|---|---|
| [docs/ui.md](docs/ui.md) | 布局、颜色语义、表格、主题、图表、截图检查 |
| [docs/data.md](docs/data.md) | 测量口径、用量/成本、保留策略、数据修复 |
| [docs/ops.md](docs/ops.md) | 探针约束、磁盘/网络挂载、热重载、部署与排障 |

改界面前读 `docs/ui.md`；改采集/统计前读 `docs/data.md`；改探针或部署前读 `docs/ops.md`。

## agent_playground

`agent_playground/` 是 agent 专用暂存区，等同项目内的 `/tmp`：

- 可自由读写、建子目录、放实验脚本 / 临时输出 / 截图 / 诊断转储
- **不进 git**（已 `.gitignore`），不放需要长期保留的源码或文档
- 不要从这里 `import` / 引用进产品代码；产线改动只落在正式路径
- 用完可整目录清空，无需确认

## 改动纪律

- 新增/改接口字段：同步 `shared/schema.ts` 与实际 JSON，勿再手写平行类型。
- 测试断言**行为与产物**，不要断言「源码里存在某段文字」。
- 语义规则（颜色方向、null、计费、告警阈值）被渲染检查或单测盯住的，改语义时同步改测试。
- 保持精简：不为假想需求加抽象、配置项、依赖。
