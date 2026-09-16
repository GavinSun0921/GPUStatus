#!/bin/sh
# ==============================================================================
#  GPUStatus :: remote probe
# ------------------------------------------------------------------------------
#  Runs ON the monitored GPU host. Reads system state and prints EXACTLY ONE
#  JSON object on stdout.
#
#  Requirements (deliberately minimal -- nothing is installed on the target):
#    * POSIX /bin/sh
#    * coreutils + awk + grep + ps  (date hostname uname df)
#    * /proc filesystem
#    * nvidia-smi              (optional: absence is reported, not fatal)
#
#  NO Python. NO writes to disk. NO network access. Read-only.
#
#  Invoked by the collector as:   ssh <host> sh -s   < remote-probe.sh
#
#  Architecture
#  ------------
#  Raw command output is streamed through the pipeline in SECTIONS (see the
#  `\001SECTION` markers) and parsed+JSON-encoded by a SINGLE awk program.
#
#  This matters for cost: an earlier revision formatted every field with its own
#  `$( ... )`/sed/tr call, which cost ~200 forks and made the probe take 1.7s of
#  which 1.16s was system time -- on every poll, on every monitored machine.
#  Parsing centrally in awk removes almost all of that (~12 forks now), so the
#  probe is dominated by nvidia-smi's own runtime (~0.6s).
#
#  The probe performs NO data correlation: it reports `gpus` keyed by uuid,
#  `procs` keyed by gpu uuid, `pmon` keyed by gpu index and `pid_users` keyed by
#  pid. The backend joins them.
# ==============================================================================

LANG=C
LC_ALL=C
export LANG LC_ALL

PROBE_VERSION=2
SECTION=$(printf '\001')'SECTION'
export SECTION

# --- collection ---------------------------------------------------------------

TS=$(date +%s 2>/dev/null || echo 0)
HOSTN=$(hostname 2>/dev/null || echo unknown)
UNAME=$(uname -srm 2>/dev/null || echo '')
NCPU=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)

UPTIME_S=0
[ -r /proc/uptime ] && read -r UPTIME_S _ < /proc/uptime

ERRORS=""
err() { ERRORS="$ERRORS$1
"; }

# GPU telemetry. One query returns identity plus every per-card metric.
# `nounits` yields bare numbers; unsupported fields arrive as [N/A] and are
# mapped to null by awk (fan.speed is [N/A] on some SKUs, e.g. RTX 6000D).
NVIDIA_ERR=""
GPU_CSV=""
PROC_CSV=""
PMON=""
PIDS=""
PID_USERS=""

if ! command -v nvidia-smi >/dev/null 2>&1; then
  err "nvidia_smi_not_installed"
  NVIDIA_ERR="nvidia-smi not found in PATH"
else
  # NOTE ON FIELD ORDER: the parser below reads the trailing fields by position
  # (f[n], f[n-1], ...) because the model name may itself contain commas. Adding
  # fields means appending here AND shifting the indices there.
  #
  # The last five are health telemetry, not performance:
  #   clocks_throttle_reasons.active  bitmask -- is the card being slowed down
  #   clocks.current.sm / max.sm      to express that slowdown as a ratio
  #   power.limit                     to tell "using 285W" from "capped at 285W"
  #   pstate                          P0 = full performance, P2/P8 = idle states
  #
  # Verified on all six machines (drivers 580.173.02 .. 610.57.04) that every one
  # of these fields is queryable. That mattered: an unsupported field name makes
  # nvidia-smi reject the WHOLE query, which would have blanked the entire table.
  #
  # Cost of the five extra fields: measured 0.11s -> 0.12s per poll, no new
  # process and no extra NVML initialisation -- they ride along on this call.
  # pcie.link.* is appended at the END, so the trailing-index reads below shift
  # by two. A card that has trained down to x4 or Gen1 runs slower while every
  # other metric -- utilisation, temperature, power -- looks perfectly normal,
  # which makes it invisible without this.
  GPU_FIELDS='index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,utilization.memory,fan.speed,clocks_throttle_reasons.active,clocks.current.sm,clocks.max.sm,power.limit,pstate,pcie.link.gen.current,pcie.link.width.current,pcie.link.gen.max,pcie.link.width.max'

  # !! nvidia-smi prints NVML failures to STDOUT while exiting non-zero, so the
  # exit code must be honoured -- otherwise the error text would be parsed as a
  # data row and fabricate a phantom GPU with all-null fields.
  GPU_CSV=$(nvidia-smi --query-gpu="$GPU_FIELDS" --format=csv,noheader,nounits 2>&1)
  GPU_RC=$?
  if [ "$GPU_RC" -ne 0 ]; then
    NVIDIA_ERR=$(printf '%s' "$GPU_CSV" | head -1)
    GPU_CSV=""
    err "nvidia_smi_failed"
  fi

  PROC_CSV=$(nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory \
    --format=csv,noheader,nounits 2>&1)
  PROC_RC=$?
  if [ "$PROC_RC" -ne 0 ]; then
    PROC_CSV=""
    [ -z "$NVIDIA_ERR" ] && NVIDIA_ERR=$(printf '%s' "$PROC_CSV" | head -1)
    err "compute_apps_query_failed"
  fi

  # pmon is the only nvidia-smi interface exposing utilisation per PID.
  # An empty result is normal when no client process is attached to any GPU.
  PMON=$(nvidia-smi pmon -c 1 2>&1)
  PMON_RC=$?
  if [ "$PMON_RC" -ne 0 ]; then
    PMON=""
    err "pmon_failed"
  fi

  # pid -> owning user. One `ps` call resolves every client PID at once.
  # `ps` is used rather than /proc/<pid>/status so that the answer is correct for
  # processes owned by other users, and it never requires root.
  PIDS=$(printf '%s\n' "$PROC_CSV" | awk -F, '
    NF >= 4 {
      p = $2; gsub(/[ \t\r]/, "", p)
      if (p ~ /^[0-9]+$/) printf (c++ ? "," : "") "%s", p
    }')
  # etime (elapsed time) rides along on the same ps call -- no extra process --
  # so the UI can show how long a job has been holding a card.
  #
  # `user:32=` is REQUIRED, not cosmetic. With several output columns ps applies
  # its default widths instead of sizing to the content, and USER defaults to 8
  # characters: `luzhicheng` came back as `luzhich+`. That truncation reached the
  # usage rollup, where it split one person's GPU-hours across two rows under two
  # different names -- a wrong answer in the year-end accounting, not just a
  # cosmetic problem. 32 is the maximum Linux username length, so this cannot
  # truncate. (A single `-o user=` column happens to auto-size, which is why the
  # bug only appeared once etime was added.)
  [ -n "$PIDS" ] && PID_USERS=$(ps -o pid=,user:32=,etime= -p "$PIDS" 2>/dev/null)
fi

# Driver version, taken from /proc rather than from a fourth nvidia-smi call.
#
# `read` is a shell builtin, so this costs NO process and no NVML initialisation,
# against 0.07s wall / 0.03s sys for `nvidia-smi --query-gpu=driver_version`.
# Verified identical to nvidia-smi's KMD version on every machine tested
# (580.173.02 / 610.57.04 / 580.178.04 / 610.43.02).
#
# It also sidesteps a driver quirk: on newer releases
# `--query-gpu=driver_version` returns the sentence 'Deprecated, see "KMD
# version" instead' -- text containing a comma, which would corrupt a CSV row if
# it were folded into the main --query-gpu call.
NVRM_LINE=""
[ -r /proc/driver/nvidia/version ] && IFS= read -r NVRM_LINE < /proc/driver/nvidia/version

# Only if /proc is unavailable (not the case on a working NVIDIA host).
DRIVER_VERSION=""
if [ -z "$NVRM_LINE" ] && [ -n "$GPU_CSV" ]; then
  DRIVER_VERSION=$(nvidia-smi --version 2>/dev/null | awk -F: '
    /KMD version|DRIVER version/ {
      gsub(/[[:space:]]/, "", $2)
      if ($2 ~ /^[0-9]/) { print $2; exit }
    }')
fi

# Disk paths configured for this host arrive as positional arguments:
#   ssh <host> sh -s -- /home /data
# They are captured here because the emit block below runs inside a pipeline,
# where the script's own "$@" is no longer in scope. Newline-separated is safe:
# the config layer rejects paths containing a newline.
# Arguments are tagged so both lists can travel in one command line:
#   d:<path>  local directory to measure usage for
#   n:<path>  network mount whose HEALTH should be checked
CONFIGURED_DISKS=""
CONFIGURED_NET=""
DISK_EXCLUDE=""
for _arg in "$@"; do
  case "$_arg" in
    d:*) CONFIGURED_DISKS="${CONFIGURED_DISKS}${CONFIGURED_DISKS:+
}${_arg#d:}" ;;
    n:*) CONFIGURED_NET="${CONFIGURED_NET}${CONFIGURED_NET:+
}${_arg#n:}" ;;
    x:*) DISK_EXCLUDE="${DISK_EXCLUDE}${DISK_EXCLUDE:+
}${_arg#x:}" ;;
  esac
done

# Filesystem types that are NOT local storage. Two consequences:
#   * their usage is not reported -- it belongs to the server, so every machine
#     shows identical figures (all six machines reported /share at 99% / 87 TiB,
#     burying the local disks that actually differ);
#   * they are never passed to df, because df on a stale NFS mount blocks until
#     the server answers, which would stall the entire probe.
NET_FSTYPES='^(nfs|nfs4|cifs|smbfs|glusterfs|ceph|lustre|afs|9p|davfs|ncpfs|coda|fuse\.(sshfs|rclone|s3fs|gcsfuse|davfs2))$'

# --- emit: sections in, one JSON document out --------------------------------

{
  printf '%s\tMETA\n' "$SECTION"
  printf 'probe_version\t%s\n' "$PROBE_VERSION"
  printf 'ts\t%s\n' "$TS"
  printf 'hostname\t%s\n' "$HOSTN"
  printf 'uname\t%s\n' "$UNAME"
  printf 'ncpu\t%s\n' "$NCPU"
  printf 'uptime\t%s\n' "$UPTIME_S"
  printf 'driver_version\t%s\n' "$DRIVER_VERSION"
  printf 'nvrm_line\t%s\n' "$NVRM_LINE"
  printf 'nvidia_error\t%s\n' "$NVIDIA_ERR"
  printf '%s\n' "$ERRORS" | while IFS= read -r e; do
    [ -n "$e" ] && printf 'error\t%s\n' "$e"
  done

  printf '%s\tCPU_STAT\n' "$SECTION"
  head -n 1 /proc/stat 2>/dev/null

  printf '%s\tLOADAVG\n' "$SECTION"
  cat /proc/loadavg 2>/dev/null

  printf '%s\tMEMINFO\n' "$SECTION"
  cat /proc/meminfo 2>/dev/null

  # ---- local filesystem usage -------------------------------------------
  # The local mount list comes from /proc/mounts and is filtered by type, so df
  # is only ever asked about local storage and can never block on the network.
  printf '%s\tDF\n' "$SECTION"
  # Local filesystems worth reporting, from /proc/mounts. Four filters, each
  # removing a category that is not "storage a job can fill up":
  #
  #   1. non-local filesystem types (handled separately as health checks)
  #   2. kernel/pseudo filesystems and snap image mounts
  #   3. READ-ONLY mounts -- nothing can be written to them, so free space is not
  #      actionable. This is what removed the snap-created
  #      /var/snap/firefox/common/host-hunspell bind mount on three machines.
  #   4. a device already reported -- the same filesystem is often mounted at
  #      several points, and each copy printed identical figures.
  #
  # `excluded` holds mount points the operator never wants to see (by default
  # "/" and "/boot/efi": the OS disk and firmware, neither of which reflects
  # whether a job can write its data).
  LOCAL_MOUNTS=$(awk -v re="$NET_FSTYPES" -v excl="$DISK_EXCLUDE" '
    BEGIN { n = split(excl, e, "\n"); for (i = 1; i <= n; i++) skip[e[i]] = 1 }
    $3 ~ re || $3 == "autofs" { next }
    $3 ~ /^(proc|sysfs|devtmpfs|devpts|tmpfs|cgroup|cgroup2|securityfs|debugfs|tracefs|configfs|fusectl|mqueue|hugetlbfs|pstore|bpf|binfmt_misc|rpc_pipefs|nsfs|squashfs|overlay|ramfs|efivarfs|fuse\.gvfsd-fuse|none)$/ { next }
    $2 ~ /^\/(run|dev|sys|proc|snap|var\/snap)(\/|$)/ { next }
    $4 ~ /(^|,)ro(,|$)/ { next }
    {
      if (seen[$1]++) next
      if (skip[$2]) next
      print $2
    }
  ' /proc/mounts 2>/dev/null | head -24)

  if [ -n "$LOCAL_MOUNTS" ]; then
    printf '%s\n' "$LOCAL_MOUNTS" | while IFS= read -r _mp; do
      [ -z "$_mp" ] && continue
      df -P -k -- "$_mp" 2>/dev/null | awk -v want="$_mp" '
        NR == 2 {
          pct = $5; sub(/%$/, "", pct)
          printf "%s\t%s\t%s\t%s\t%s\t%s\n", want, $6, $2, $3, $4, pct
        }'
    done
  fi

  # Configured paths that are NOT mount points (a subdirectory such as /data
  # living on the / volume) are measured individually, so they can be tracked
  # separately. Paths that do not exist are reported rather than dropped.
  if [ -n "$CONFIGURED_DISKS" ]; then
    printf '%s\n' "$CONFIGURED_DISKS" | while IFS= read -r p; do
      [ -z "$p" ] && continue
      if printf '%s\n' "$LOCAL_MOUNTS" | grep -Fxq -- "$p"; then
        continue
      fi
      # An explicitly configured path must not resurrect an excluded mount
      # point; the exclusion would otherwise only apply to auto-discovery.
      if [ -n "$DISK_EXCLUDE" ] && printf '%s\n' "$DISK_EXCLUDE" | grep -Fxq -- "$p"; then
        continue
      fi
      out=$(df -P -k -- "$p" 2>/dev/null)
      rc=$?
      if [ "$rc" -eq 0 ] && [ -n "$out" ]; then
        printf '%s\n' "$out" | awk -v want="$p" '
          NR == 2 {
            pct = $5; sub(/%$/, "", pct)
            printf "%s\t%s\t%s\t%s\t%s\t%s\n", want, $6, $2, $3, $4, pct
          }'
      else
        printf '%s\tMISSING\n' "$p"
      fi
    done
  fi

  # ---- network mount health ---------------------------------------------
  # These carry no usage figures at all, only whether the mount is actually
  # there and answering. `stat -f` is what distinguishes a live mount from a
  # hung one, and it runs under `timeout` so an unreachable NFS server cannot
  # stall the probe.
  #
  # Configured entries are checked even when not currently mounted, which is the
  # only way to tell "this machine failed to mount /share" apart from "this
  # machine has no /share configured" -- an auto-discovered list alone would
  # simply be silent in the failure case.
  printf '%s\tNETMOUNT\n' "$SECTION"
  {
    [ -n "$CONFIGURED_NET" ] && printf '%s\n' "$CONFIGURED_NET"
    awk -v re="$NET_FSTYPES" '$3 ~ re { print $2 }' /proc/mounts 2>/dev/null
  } | sort -u | while IFS= read -r _np; do
    [ -z "$_np" ] && continue
    info=$(awk -v want="$_np" -v re="$NET_FSTYPES" '
      $2 == want && $3 ~ re {
        print $3, ($4 ~ /(^|,)ro(,|$)/ ? "ro" : "rw")
        exit
      }' /proc/mounts 2>/dev/null)
    if [ -z "$info" ]; then
      # No real mount. Distinguish "armed by the automounter but not triggered
      # yet" from "not mounted at all": reporting an idle autofs entry as a
      # failure would raise a false alarm on every machine that simply has not
      # touched the directory since boot.
      if awk -v want="$_np" '
            $2 == want && $3 == "autofs" { found = 1; exit }
            END { exit(found ? 0 : 1) }' /proc/mounts 2>/dev/null; then
        printf '%s\tautofs\tautofs\n' "$_np"
      else
        printf '%s\t-\tmissing\n' "$_np"
      fi
      continue
    fi
    fstype=${info%% *}
    mode=${info##* }
    if command -v timeout >/dev/null 2>&1; then
      if timeout 3 stat -f -- "$_np" >/dev/null 2>&1; then
        printf '%s\t%s\t%s\n' "$_np" "$fstype" "$mode"
      else
        printf '%s\t%s\tstale\n' "$_np" "$fstype"
      fi
    else
      printf '%s\t%s\t%s\n' "$_np" "$fstype" "$mode"
    fi
  done

  printf '%s\tGPU\n' "$SECTION"
  printf '%s\n' "$GPU_CSV"

  printf '%s\tPROC\n' "$SECTION"
  printf '%s\n' "$PROC_CSV"

  printf '%s\tPIDUSER\n' "$SECTION"
  printf '%s\n' "$PID_USERS"

  printf '%s\tPMON\n' "$SECTION"
  printf '%s\n' "$PMON"
} | awk '
function esc(s) {
  gsub(/\\/, "\\\\", s)
  gsub(/"/, "\\\"", s)
  gsub(/[\001-\037\177]/, "", s)
  return s
}
function str(s) { return "\"" esc(s) "\"" }

# JSON number, or null for [N/A] / "-" / "" / any non-numeric text.
function num(v,   s) {
  s = v
  gsub(/[ \t\r]/, "", s)
  if (s ~ /^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/) return s
  return "null"
}
function trim(s) { gsub(/^[ \t\r]+/, "", s); gsub(/[ \t\r]+$/, "", s); return s }

# `ps -o etime=` prints [[DD-]HH:]MM:SS. Converted to seconds so the UI does not
# have to know the format.
function etimeSeconds(v,   s, rest, parts, n, i, secs, days) {
  s = trim(v)
  if (s == "") return "null"
  days = 0
  if (index(s, "-") > 0) {
    n = split(s, rest, "-")
    days = rest[1] + 0
    s = rest[2]
  }
  n = split(s, parts, ":")
  secs = 0
  for (i = 1; i <= n; i++) secs = secs * 60 + (parts[i] + 0)
  return days * 86400 + secs
}

# Throttle reasons come as a hex bitmask ("0x0000000000000020").
#
# Parsed by hand rather than with strtonum(): that is a GNU awk extension, and
# this probe is meant to run on any machine with sh + coreutils + nvidia-smi.
# All six current hosts happen to ship gawk, but one added later with mawk would
# abort the whole GPU section on an undefined function.
#
# Anything that is not a 0x-prefixed hex string becomes null rather than 0:
# "cannot tell" and "not throttled" are different answers, and defaulting to 0
# would silently report a healthy card for a reading we never got.
function hexnum(v,   s, i, c, d, n) {
  s = trim(v)
  if (s !~ /^0[xX][0-9a-fA-F]+$/) return "null"
  s = substr(s, 3)
  n = 0
  for (i = 1; i <= length(s); i++) {
    d = index("0123456789abcdef", tolower(substr(s, i, 1))) - 1
    if (d < 0) return "null"
    n = n * 16 + d
  }
  return n
}

function join(f, from, to,   i, out, sep) {
  out = ""; sep = ""
  for (i = from; i <= to; i++) { out = out sep f[i]; sep = "," }
  return out
}

BEGIN { FS = "\t"; have_gpu = 0 }

/^\001SECTION/ { section = $2; next }

# ---- META -------------------------------------------------------------------
section == "META" {
  if ($1 == "error") { errors[++nerr] = $2; next }
  meta[$1] = $2
  if ($1 == "uname") {
    n = split($2, u, " ")
    meta["kernel"] = u[1] " " u[2]
    meta["arch"] = u[3]
  }
  next
}

# ---- /proc/stat aggregate line ---------------------------------------------
section == "CPU_STAT" {
  n = split($0, f, /[ \t]+/)
  # The line is "cpu  u n s idle iowait irq softirq steal guest guest_nice";
  # a leading space yields an empty f[1], so find the label first.
  start = (f[1] == "cpu") ? 2 : 3
  for (i = start; i <= start + 9; i++) ticks[i - start + 1] = (f[i] == "" ? 0 : f[i])
  next
}

# ---- /proc/loadavg ---------------------------------------------------------
section == "LOADAVG" {
  split($0, f, /[ \t]+/)
  load1 = num(f[1]); load5 = num(f[2]); load15 = num(f[3])
  split(f[4], r, "/")
  running = num(r[1]); nprocs = num(r[2])
  next
}

# ---- /proc/meminfo (kB) ----------------------------------------------------
# NB: /proc/meminfo is SPACE separated, so it must be split explicitly -- the
# global FS is a tab, which would leave the whole line in $1.
section == "MEMINFO" {
  n = split($0, f, /[ \t]+/)
  key = f[1]; v = f[2]
  if      (key == "MemTotal:")     mem_total = v
  else if (key == "MemFree:")      mem_free = v
  else if (key == "MemAvailable:") mem_avail = v
  else if (key == "Buffers:")      mem_buffers = v
  else if (key == "Cached:")       mem_cached = v
  else if (key == "SwapTotal:")    swap_total = v
  else if (key == "SwapFree:")     swap_free = v
  next
}

# ---- df --------------------------------------------------------------------
# Either "path<TAB>mount<TAB>total<TAB>used<TAB>avail<TAB>pct", or
# "path<TAB>MISSING" when the configured directory does not exist.
section == "DF" {
  if (NF == 2 && $2 == "MISSING") {
    m = ++ndisk
    disk_path[m] = $1
    disk_missing[m] = 1
  } else if (NF >= 6 && $1 != "") {
    m = ++ndisk
    disk_path[m] = $1
    disk_mount[m] = $2
    disk_total[m] = $3
    disk_used[m] = $4
    disk_avail[m] = $5
    disk_pct[m] = $6
    disk_missing[m] = 0
  }
  next
}

# ---- network mount health --------------------------------------------------
# "path<TAB>fstype<TAB>status", where status is one of:
#   rw      mounted and writable        (healthy)
#   ro      mounted read-only
#   stale   mounted but not answering   (server down / hung)
#   autofs  automounter armed but not currently triggered (not a failure)
#   missing not mounted on this machine
section == "NETMOUNT" {
  if (NF >= 3 && $1 != "") {
    k = ++nnm
    nm_path[k] = $1
    nm_fstype[k] = $2
    nm_status[k] = $3
  }
  next
}

# ---- nvidia-smi --query-gpu -------------------------------------------------
# "index, uuid, name, util, mem.used, mem.total, temp, power, mem.util, fan"
# The name is re-joined from the middle fields so that a comma inside a product
# name cannot shift the trailing metrics.
section == "GPU" {
  if ($0 == "") next
  n = split($0, f, ",")
  # 15 fields now; below this the trailing-index reads would silently misalign.
  if (n < 19) next
  k = ++ngpu
  gpu_index[k] = num(f[1])
  gpu_uuid[k]  = trim(f[2])
  gpu_name[k]  = trim(join(f, 3, n - 16))
  gpu_util[k]  = num(f[n - 15])
  gpu_memused[k] = num(f[n - 14])
  gpu_memtotal[k] = num(f[n - 13])
  gpu_temp[k]  = num(f[n - 12])
  gpu_power[k] = num(f[n - 11])
  gpu_memutil[k] = num(f[n - 10])
  gpu_fan[k]   = num(f[n - 9])
  # Throttle bitmask arrives as hex (0x0000000000000020); strtonum needs the
  # leading 0x, and a non-numeric value must not become 0 ("not throttled").
  gpu_throttle[k] = hexnum(trim(f[n - 8]))
  gpu_smclock[k]  = num(f[n - 7])
  gpu_smclockmax[k] = num(f[n - 6])
  gpu_powerlimit[k] = num(f[n - 5])
  gpu_pstate[k] = trim(f[n - 4])
  # Width is the degradation signal that can be trusted: a PCIe link
  # renegotiates its GENERATION down when the card is idle, but not its width.
  gpu_pciegen[k]      = num(f[n - 3])
  gpu_pciewidth[k]    = num(f[n - 2])
  gpu_pciegenmax[k]   = num(f[n - 1])
  gpu_pciewidthmax[k] = num(f[n])
  next
}

# ---- nvidia-smi --query-compute-apps ---------------------------------------
# "gpu_uuid, pid, process_name, used_memory"
section == "PROC" {
  if ($0 == "") next
  n = split($0, f, ",")
  if (n < 4) next
  k = ++nproc
  proc_uuid[k] = trim(f[1])
  proc_pid[k]  = num(f[2])
  proc_name[k] = trim(join(f, 3, n - 1))
  proc_mem[k]  = num(f[n])
  next
}

# ---- ps -o pid=,user= ------------------------------------------------------
section == "PIDUSER" {
  line = trim($0)
  if (line == "") next
  n = split(line, f, /[ \t]+/)
  if (n < 2) next
  piduser_pid[++npu] = num(f[1])
  piduser_name[npu]  = trim(f[2])
  piduser_secs[npu]  = (n >= 3) ? etimeSeconds(f[3]) : "null"
  next
}

# ---- nvidia-smi pmon -------------------------------------------------------
# "gpu pid type sm mem enc dec jpg ofa command", where the utilisation columns
# are "-" for graphics (non-compute) clients.
section == "PMON" {
  line = trim($0)
  if (line == "" || substr(line, 1, 1) == "#") next
  n = split(line, f, /[ \t]+/)
  if (n < 9) next
  k = ++npmon
  pmon_gpu[k]  = num(f[1])
  pmon_pid[k]  = num(f[2])
  pmon_type[k] = trim(f[3])
  pmon_sm[k]   = num(f[4])
  pmon_mem[k]  = num(f[5])
  pmon_cmd[k]  = (n >= 10) ? trim(join(f, 10, n)) : ""
  next
}

END {
  printf "{\n"
  printf "  \"probe_version\": %s,\n", num(meta["probe_version"])
  printf "  \"ts\": %s,\n", num(meta["ts"])
  printf "  \"hostname\": %s,\n", str(meta["hostname"])
  printf "  \"kernel\": %s,\n", str(meta["kernel"])
  printf "  \"arch\": %s,\n", str(meta["arch"])
  printf "  \"uptime_s\": %s,\n", num(meta["uptime"])
  # Prefer the /proc line; fall back to the nvidia-smi value when absent.
  driver = ""
  if (meta["nvrm_line"] != "") {
    n = split(meta["nvrm_line"], nf, /[ \t]+/)
    for (i = 1; i <= n; i++) if (nf[i] ~ /^[0-9]+\.[0-9]+/) { driver = nf[i]; break }
  }
  if (driver == "") driver = meta["driver_version"]
  printf "  \"driver_version\": %s,\n", str(driver)
  printf "  \"nvidia_error\": %s,\n", str(meta["nvidia_error"])

  printf "  \"cpu\": {\"cores\": %s, \"ticks\": [", num(meta["ncpu"])
  for (i = 1; i <= 10; i++) printf "%s%s", (i > 1 ? "," : ""), num(ticks[i])
  printf "], \"load1\": %s, \"load5\": %s, \"load15\": %s, \"running\": %s, \"procs\": %s},\n",
    load1, load5, load15, running, nprocs

  printf "  \"mem\": {\"total_kib\": %s, \"free_kib\": %s, \"available_kib\": %s, \"buffers_kib\": %s, \"cached_kib\": %s, \"swap_total_kib\": %s, \"swap_free_kib\": %s},\n",
    num(mem_total), num(mem_free), num(mem_avail), num(mem_buffers),
    num(mem_cached), num(swap_total), num(swap_free)

  printf "  \"gpus\": ["
  for (i = 1; i <= ngpu; i++) {
    printf "%s\n    {\"index\": %s, \"uuid\": %s, \"name\": %s, \"util\": %s, \"mem_used_mib\": %s, \"mem_total_mib\": %s, \"mem_util\": %s, \"temp_c\": %s, \"power_w\": %s, \"fan_pct\": %s, \"throttle\": %s, \"sm_clock_mhz\": %s, \"sm_clock_max_mhz\": %s, \"power_limit_w\": %s, \"pstate\": %s, \"pcie_gen\": %s, \"pcie_width\": %s, \"pcie_gen_max\": %s, \"pcie_width_max\": %s}",
      (i > 1 ? "," : ""), gpu_index[i], str(gpu_uuid[i]), str(gpu_name[i]), gpu_util[i],
      gpu_memused[i], gpu_memtotal[i], gpu_memutil[i], gpu_temp[i], gpu_power[i], gpu_fan[i],
      gpu_throttle[i], gpu_smclock[i], gpu_smclockmax[i], gpu_powerlimit[i], str(gpu_pstate[i]),
      gpu_pciegen[i], gpu_pciewidth[i], gpu_pciegenmax[i], gpu_pciewidthmax[i]
  }
  printf "%s  ],\n", (ngpu > 0 ? "\n" : "")

  printf "  \"procs\": ["
  for (i = 1; i <= nproc; i++) {
    printf "%s\n    {\"gpu_uuid\": %s, \"pid\": %s, \"name\": %s, \"used_mem_mib\": %s}",
      (i > 1 ? "," : ""), str(proc_uuid[i]), proc_pid[i], str(proc_name[i]), proc_mem[i]
  }
  printf "%s  ],\n", (nproc > 0 ? "\n" : "")

  printf "  \"pid_users\": ["
  for (i = 1; i <= npu; i++) {
    printf "%s\n    {\"pid\": %s, \"user\": %s, \"elapsed_s\": %s}", (i > 1 ? "," : ""),
      piduser_pid[i], str(piduser_name[i]), piduser_secs[i]
  }
  printf "%s  ],\n", (npu > 0 ? "\n" : "")

  printf "  \"pmon\": ["
  for (i = 1; i <= npmon; i++) {
    printf "%s\n    {\"gpu_index\": %s, \"pid\": %s, \"type\": %s, \"sm_pct\": %s, \"mem_pct\": %s, \"command\": %s}",
      (i > 1 ? "," : ""), pmon_gpu[i], pmon_pid[i], str(pmon_type[i]), pmon_sm[i], pmon_mem[i], str(pmon_cmd[i])
  }
  printf "%s  ],\n", (npmon > 0 ? "\n" : "")

  printf "  \"net_mounts\": ["
  for (i = 1; i <= nnm; i++) {
    printf "%s\n    {\"path\": %s, \"fstype\": %s, \"status\": %s}",
      (i > 1 ? "," : ""), str(nm_path[i]), str(nm_fstype[i]), str(nm_status[i])
  }
  printf "%s  ],\n", (nnm > 0 ? "\n" : "")

  printf "  \"disks\": ["
  for (i = 1; i <= ndisk; i++) {
    if (disk_missing[i]) {
      printf "%s\n    {\"path\": %s, \"missing\": true}", (i > 1 ? "," : ""), str(disk_path[i])
    } else {
      printf "%s\n    {\"path\": %s, \"mount\": %s, \"total_kib\": %s, \"used_kib\": %s, \"avail_kib\": %s, \"use_pct\": %s}",
        (i > 1 ? "," : ""), str(disk_path[i]), str(disk_mount[i]), num(disk_total[i]),
        num(disk_used[i]), num(disk_avail[i]), num(disk_pct[i])
    }
  }
  printf "%s  ],\n", (ndisk > 0 ? "\n" : "")

  printf "  \"errors\": ["
  for (i = 1; i <= nerr; i++) printf "%s%s", (i > 1 ? "," : ""), str(errors[i])
  printf "]\n}\n"
}
'
