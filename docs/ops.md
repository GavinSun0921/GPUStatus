# 运维、探针与部署

改探针、磁盘逻辑、部署链路前先读这份。

## 目标机零安装（硬约束）

允许命令：`sh` `awk` `sed` `grep` `ps` `df` `hostname` `uname` `date` `nvidia-smi` `/proc`。

- 探针**只读**：不落盘、不联网、不需要 root。
- `nvidia-smi` 挂掉时仍返回合法 JSON 并上报错误，不整机失联。
- SSH 一律 `BatchMode=yes`（密码提示会卡住采集）；连接用 ControlMaster 复用。

## 磁盘与网络挂载

- 每台机器可配 `disks: [路径]`；路径解析到所在文件系统；缺失与 `[]` 语义不同。
- 全局排除 `disk_exclude`（默认 `/`, `/boot/efi`），**在探针过滤**。
- 自动过滤：只读挂载不统计、同一设备只报一次、内核/伪文件系统与 snap 镜像。
- 自动发现挂载点时**先读 `/proc/mounts` 再 `df`**，绝不 `df` 枚举全部（NFS 挂死会阻塞探针）。
- `net_mounts`：只判断**是否真的挂上**，不统计容量（NFS 容量属于文件服务器）。
  - 状态：已挂载（绿）/ 只读（黄）/ 异常（红）。
  - `autofs` / `missing` / `stale` **都算异常**（诊断进 tooltip）；配置了 `net_mounts` 缺失才可见。
  - 从未采集过的机器不显示该行；机器没配的挂载项不显示。

## 显示名与标识

- 显示名优先级：`label` > hostname 解析 > `id`。解析只改名字部分大小写，不动域名。
- **改 `id` = 换机器**，历史断开。要改叫法改 `label`。
- `site` 是部署级名称（顶栏一次）；`group` 仅当与 `site` 不同才显示。

## 公告

- 全站公告默认不开启；不可被访客关闭；链接用 React 元素渲染，**不用** `dangerouslySetInnerHTML`。
- 机器 `note` 显示在健康告警**之下**。

## 配置热重载

- 监听 `config/hosts.json` / `config/prices.json`，约 0.4s 生效，无需重启。
- 解析失败：记日志、**继续用旧配置**。写坏配置不能把服务打挂。
- 管理页保存前写临时文件校验；首次保存自动留 `hosts.json.bak`（标准注释重生成会替换手写注释）。
- 密码只在文件里改：不设密码 = 管理页不可用；不要默认口令。

## 部署（systemd）

```bash
sudo cp deploy/gpustatus.service /etc/systemd/system/
# ExecStart 必须是 node 绝对路径（nvm 用户不能依赖 PATH）
sed "s#^ExecStart=.*#ExecStart=$(command -v node) server/index.js#" \
  deploy/gpustatus.service | sudo tee /etc/systemd/system/gpustatus.service >/dev/null
sudo systemctl daemon-reload && sudo systemctl enable --now gpustatus
```

生产机：`mgmt2`（`/home/mguser/GPUStatus`，`gpustatus.service`）。

## 更新（GitHub 受限时）

mgmt2 上 GitHub HTTPS 可能被 SNI 阻断。优先 SSH：

```bash
git remote set-url origin git@github.com:GavinSun0921/GPUStatus.git
# ~/.ssh/config → Host github.com / HostName ssh.github.com / Port 443 / User git
```

完全连不上时从开发机中转：

```bash
tools/offline-update.sh mgmt2 --build   # git bundle 增量，保留完整历史
sudo systemctl restart gpustatus        # 按需
```

## 环境备忘

- mgmt2：Rocky Linux，SSH **端口 1938**，`80/443` 被 FreeIPA 占用，勿抢。
- `sudo` 仅对 `gpustatus` 的 systemctl 动作免密。
- SELinux：网关用**用户级** systemd（`lab-gateway`，8081），不写系统 unit。
- 校园域名只解析到内网 IP；禁止 frp / ngrok / 公网反代。
- 本地截图 QA：`node tools/seed-visual-db.mjs` + `--config tools/visual-hosts.json --no-poll`，勿直接开大库截图。

## 排障速查

| 现象 | 处理 |
|---|---|
| `Permission denied (publickey)` | 免密未配好；`ssh -o BatchMode=yes <host> true` 验证 |
| `NVML` 初始化失败 | 目标机 `nvidia-smi` 不可用；CPU/内存仍显示，错误单独标出 |
| 显卡 7/8 | 掉卡/驱动异常；查 `dmesg` / `nvidia-smi -q` |
| 老驱动进程利用率全空 | pmon 列数不同，按表头解析（见 docs/data.md） |
| `git pull` 卡住 | 见上「更新」 |

更多口径见 [docs/data.md](data.md)，界面语义见 [docs/ui.md](ui.md)。
