/** Display helpers. Every function tolerates null: missing data is normal. */

export function gib(mib: number | null | undefined, digits = 1): string {
  if (mib === null || mib === undefined || !Number.isFinite(mib)) return '—';

  const value = mib / 1024;
  if (Math.abs(value) >= 1000) return `${(value / 1024).toFixed(2)} TiB`;
  // Below 1 GiB the "GiB" form rounds to "0 GiB", which reads as no capacity at
  // all -- a 475 MiB EFI partition would be shown as "0 GiB / 0 GiB".
  if (Math.abs(value) < 1) return `${Math.round(mib)} MiB`;
  return `${value.toFixed(digits)} GiB`;
}

export function pct(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

export function num(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

/** Compact duration: 45s, 12m, 3h20m, 4d3h. */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d${h % 24}h` : `${d}d`;
}

export function ago(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 0) return '刚刚';
  const s = Math.round(ms / 1000);
  if (s < 2) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export function clock(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

/** Warning codes from the collector, rendered for humans. */
export function warningLabel(code: string): string {
  if (code.startsWith('probe:')) return `采集告警: ${code.slice(6)}`;
  if (code.startsWith('nvidia:')) return `nvidia-smi: ${code.slice(7)}`;
  if (code.startsWith('gpu_count_mismatch:')) {
    const m = /expected_(\d+)_saw_(\d+)/.exec(code);
    return m ? `显卡数量异常: 预期 ${m[1]} 张,实际 ${m[2]} 张` : '显卡数量异常';
  }
  if (code.startsWith('unresolved_process_users:')) {
    return `${code.split(':')[1]} 个进程无法解析所属用户`;
  }
  if (code.startsWith('clock_skew:')) return `时钟偏差 ${code.slice(11)}`;
  if (code.startsWith('throttled:')) {
    const m = /throttled:(\d+)\/(\d+)_(\w+)/.exec(code);
    if (!m) return code;
    const what =
      m[3] === 'thermal'
        ? '热降频'
        : m[3] === 'thermal_recent'
          ? '近期出现热降频'
          : '功耗墙限频';
    return `${m[1]}/${m[2]} 张卡${what}`;
  }
  if (code.startsWith('pcie_degraded:')) {
    const m = /pcie_degraded:(\d+)\/(\d+)/.exec(code);
    return m ? `${m[1]}/${m[2]} 张卡 PCIe 链路降速` : 'PCIe 链路降速';
  }
  return code;
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'ok':
      return '正常';
    case 'stale':
      return '数据陈旧';
    case 'down':
      return '失联';
    default:
      return '未知';
  }
}
