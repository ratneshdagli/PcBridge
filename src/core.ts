// PC Bridge core: everything that shells out to ssh / docker / tailscale / tar. No Electron imports,
// so test/e2e.ts can drive it directly against the real remote.
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { Balancer } from './balancer';

// ---------- types & config ----------
export interface Remote { name: string; host: string; user: string; keyPath: string; port: number; contextName: string; routes?: string[] /* fallback addresses of the same PC (e.g. its LAN IP): used only while the main address is unreachable */; fastCopy?: boolean /* big file copies use the PC's home-network (LAN) address when this PC is on the same network; default on, false = always the main address */ }
export interface Forward { name: string; localPort: number; remotePort: number; remoteHost: string; autoStart?: boolean }
export interface Project {
  name: string; path: string;
  ports?: number[];          // ports the site serves on (same number locally and on the remote)
  failover?: boolean;        // when offloaded: come back to this PC automatically if the remote dies
  autoFailback?: boolean;    // after a failover: move to the remote again once it has been healthy for ~1 min
  mode?: 'local' | 'remote' | 'split'; // where the site is currently served from ('split' = both PCs, see share)
  share?: number;            // split only: % of the CONNECTIONS sent to the remote PC (the rest is served by this PC). Default behaviour = 100% on one PC.
  altPort?: number;          // split only: local port of the ssh tunnel to the remote copy
  failedOver?: boolean;
  container?: string;        // "container project": a plain local container (e.g. searxng) whose twin already exists on the remote. No files/images are synced.
  autoOffload?: boolean;     // keep it on the remote whenever the remote is healthy (offloads at start-up and after a failback)
  paused?: boolean;          // user clicked "Bring back to this PC": no automatic offload until they offload again
  remote?: string;           // NAME of the PC it runs on when moved (default: the active PC). Lets different sites live on different PCs.
}
/** The PC a site/program belongs to: its own `remote` if set and still configured, otherwise the active PC. */
export const remoteFor = (c: Config, name?: string): Remote => (name && c.remotes.find((r) => r.name === name)) || c.remotes[c.activeRemote];
export interface Config {
  remotes: Remote[]; activeRemote: number;
  forwards: Forward[]; projects: Project[];
  localContext: string;          // docker context to return to when leaving the remote
  syncExcludes: string[];
  keepAwake: boolean;            // hold a background ssh session so the remote WSL VM never idles off
  programs?: import('./programs').Program[];   // plain programs that can run on the remote PC
  autoUpdate?: boolean;          // update the remote's Node/uv/program libraries about once a week (default off)
  programsUpdatedAt?: number;    // last time "Update everything" ran (ms since 1970)
  remoteRoot?: string;          // folder on the remote's NON-C drive for everything PC Bridge puts there (default E:\PCBridge)
  apps?: import('./apps').App[];   // named groups of programs/containers moved together
  api?: { enabled: boolean; port: number; token: string; control: boolean };   // local API for other programs (off by default)
}
export const defaultConfig = (): Config => ({
  // First run: a placeholder PC. Use Setup > "Connect a PC" to add yours. (PCB_REMOTE_NAME / PCB_REMOTE_HOST / PCB_REMOTE_USER preset it, used by the end-to-end tests.)
  remotes: [{ name: process.env.PCB_REMOTE_NAME || 'my-other-pc', host: process.env.PCB_REMOTE_HOST || '100.64.0.1', user: process.env.PCB_REMOTE_USER || 'user',
    keyPath: path.join(os.homedir(), '.ssh', 'id_ed25519'), port: 22, contextName: 'remote' }],
  activeRemote: 0, forwards: [], localContext: '',
  projects: [],
  syncExcludes: ['node_modules', '.git', '__pycache__', '.venv'], keepAwake: true,
  api: { enabled: false, port: 8787, token: '', control: false },
});

const HOST_RE = /^[A-Za-z0-9._:-]+$/, USER_RE = /^[A-Za-z0-9._-]+$/, CTX_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Returns a list of human-readable problems; empty = valid. Guards ssh option/command injection. */
export function validateConfig(c: Config): string[] {
  const e: string[] = [];
  if (!Array.isArray(c.remotes) || !c.remotes.length) e.push('At least one remote is required');
  (c.remotes || []).forEach((r, i) => {
    const p = `Remote #${i + 1}: `;
    if (!r.host || !HOST_RE.test(r.host) || r.host.startsWith('-')) e.push(p + 'host/IP is invalid');
    if (!r.user || !USER_RE.test(r.user) || r.user.startsWith('-')) e.push(p + 'user is invalid');
    if (!r.keyPath) e.push(p + 'SSH key path is required');
    if (!Number.isInteger(r.port) || r.port < 1 || r.port > 65535) e.push(p + 'SSH port must be 1-65535');
    if (!CTX_RE.test(r.contextName || '')) e.push(p + 'docker context name is invalid');
    for (const h of r.routes || []) if (!HOST_RE.test(h) || h.startsWith('-')) e.push(p + `extra address "${h}" is invalid`);
  });
  if (!c.remotes?.[c.activeRemote]) e.push('Active remote index is out of range');
  if (c.api) {
    if (!Number.isInteger(c.api.port) || c.api.port < 1024 || c.api.port > 65535) e.push('API port must be 1024-65535');
    if (c.api.token && !/^pcb_[0-9a-f]{48}$/.test(c.api.token)) e.push('API token is malformed');
    if (c.api.enabled && !c.api.token) e.push('API cannot be enabled without a token');
  }
  e.push(...require('./programs').validatePrograms(c));
  e.push(...require('./apps').validateApps(c));
  for (const p of [...(c.projects || []), ...(c.programs || [])]) if (p.remote && !(c.remotes || []).some((r) => r.name === p.remote)) e.push(`"${p.name}" is set to run on "${p.remote}", but no PC with that name is configured`);
  const seen = new Set<number>();
  for (const f of c.forwards || []) {
    if (!Number.isInteger(f.localPort) || f.localPort < 1 || f.localPort > 65535) e.push(`Forward "${f.name}": local port invalid`);
    if (!Number.isInteger(f.remotePort) || f.remotePort < 1 || f.remotePort > 65535) e.push(`Forward "${f.name}": remote port invalid`);
    if (!HOST_RE.test(f.remoteHost || '') || f.remoteHost.startsWith('-')) e.push(`Forward "${f.name}": remote host invalid`);
    if (seen.has(f.localPort)) e.push(`Local port ${f.localPort} is used by two forwards`);
    seen.add(f.localPort);
  }
  for (const p of c.projects || []) {
    if (!p.path && !p.container) e.push(`Project "${p.name}": folder is empty`);
    if (p.container && !CONTAINER_RE.test(p.container)) e.push(`Project "${p.name}": container name invalid`);
    for (const n of p.ports || []) if (!Number.isInteger(n) || n < 1 || n > 65535) e.push(`Project "${p.name}": port ${n} invalid`);
    if (p.share !== undefined && (!Number.isInteger(p.share) || p.share < 0 || p.share > 100)) e.push(`Project "${p.name}": share must be 0-100`);
  }
  return e;
}

export function loadConfig(file: string): { config: Config; warning?: string } {
  const d = defaultConfig();
  if (!fs.existsSync(file)) { saveConfig(file, d); return { config: d }; }
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const c: Config = { ...d, ...j };
    const errs = validateConfig(c);
    if (errs.length) throw new Error(errs.join('; '));
    return { config: c };
  } catch (err: any) {
    const bad = file + '.bad';
    try { fs.copyFileSync(file, bad); } catch { /* ignore */ }
    saveConfig(file, d);
    return { config: d, warning: `Config was invalid (${err.message}). Backed up to ${bad} and reset to defaults.` };
  }
}
export function saveConfig(file: string, c: Config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  const text = JSON.stringify(c, null, 2);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);              // atomic: a crash never leaves half a config
  // read it back: a save that did not land must be loud, because a restart would silently lose every program and app
  log('info', `config saved: ${file} (${Buffer.byteLength(text)} bytes)`, true);
  if (fs.readFileSync(file, 'utf8') !== text) throw new Error(`The config was written but ${file} does not contain it. Programs and apps would be lost on restart.`);
}

// ---------- command log ----------
export interface LogEntry { t: number; kind: 'cmd' | 'out' | 'err' | 'info'; poll: boolean; msg: string }
/** Programs that are being moved right now: name -> target PC. App links treat them as already there, so a reverse link cannot hold their port on the target while they start. */
export const movingTo = new Map<string, string>();
export const logs: LogEntry[] = [];
let logListener: ((e: LogEntry) => void) | null = null;
export const onLog = (fn: (e: LogEntry) => void) => { logListener = fn; };
export function log(kind: LogEntry['kind'], msg: string, poll = false) {
  const e = { t: Date.now(), kind, poll, msg };
  logs.push(e); if (logs.length > 5000) logs.splice(0, 1000);
  logListener?.(e);
}
const short = (s: string) => (s.length > 220 ? s.slice(0, 200) + `…(${s.length} chars)` : s);

// ---------- process runner (never hangs: every call has a timeout) ----------
export interface RunOpt { timeout?: number; input?: string | Buffer; poll?: boolean; stream?: boolean }
export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; ms: number }
const clean = (b: Buffer | string) => (typeof b === 'string' ? b : b.toString('utf8')).replace(/\0/g, '');

export function killTree(pid?: number) {
  if (!pid) return;
  try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* gone */ }
}

export function run(cmd: string, args: string[], opt: RunOpt = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const t0 = Date.now(); const poll = !!opt.poll;
    log('cmd', `$ ${cmd} ${args.map(short).join(' ')}`, poll);
    const out: Buffer[] = [], err: Buffer[] = []; let timedOut = false, done = false;
    let child: ChildProcess; let timer: NodeJS.Timeout;
    const finish = (code: number | null, extraErr = '') => {
      if (done) return; done = true; clearTimeout(timer);
      const r: RunResult = { code, stdout: clean(Buffer.concat(out)), stderr: (clean(Buffer.concat(err)) + extraErr).trim(), timedOut, ms: Date.now() - t0 };
      if (!opt.stream && !poll && r.stdout.trim()) log('out', short(r.stdout.trim().split('\n').slice(0, 6).join('\n')));
      if (r.stderr && !opt.stream && (!poll || code !== 0)) log('err', short(r.stderr.split('\n').slice(0, 4).join('\n')), poll);
      log('info', `  → ${timedOut ? 'TIMEOUT' : 'exit ' + code} (${r.ms} ms)`, poll && code === 0);
      resolve(r);
    };
    try { child = spawn(cmd, args, { windowsHide: true }); }
    catch (e: any) { return finish(null, `spawn failed: ${e.message}`); }
    timer = setTimeout(() => { timedOut = true; killTree(child.pid); setTimeout(() => finish(null, 'timed out'), 500); }, opt.timeout ?? 15000);
    child.stdout!.on('data', (d: Buffer) => { out.push(d); if (opt.stream) log('out', clean(d).trimEnd()); });
    child.stderr!.on('data', (d: Buffer) => { err.push(d); if (opt.stream) log('err', clean(d).trimEnd()); });
    child.on('error', (e: any) => finish(null, e.code === 'ENOENT' ? `${cmd} not found in PATH` : e.message));
    child.on('close', (code) => finish(code));
    child.stdin!.on('error', () => { /* child exited before reading stdin */ });
    child.stdin!.end(opt.input);
  });
}

// ---------- ssh helpers ----------
// ---- fallback addresses for the same PC (e.g. LAN IP when Tailscale is down). Sticky: the main address is used while it works;
// we only switch when it stops answering, and switch back after it has answered 5 polls in a row (no flapping, tunnels are not churned). ----
export interface RouteInfo { host: string; primary: boolean; candidates: { host: string; ms: number | null }[]; backOk: number }
const routeCache = new Map<string, RouteInfo>();
const routeKey = (r: Remote) => `${r.user}@${r.host}:${r.port}`;
export const effectiveHost = (r: Remote) => routeCache.get(routeKey(r))?.host ?? r.host;
export const routeInfo = (r: Remote) => routeCache.get(routeKey(r));
/** Tests only: pretend the route probe chose this address. */
export const forceRoute = (r: Remote, host: string) => routeCache.set(routeKey(r), { host, primary: host === r.host, candidates: [], backOk: 0 });
export async function probeRoutes(r: Remote): Promise<RouteInfo> {
  const cands = [r.host, ...(r.routes || []).filter((h) => h !== r.host)]; const k = routeKey(r), old = routeCache.get(k);
  const res = await Promise.all(cands.map(async (host) => { const t = await tcpProbe(host, r.port, 1500); return { host, ms: t.ok ? t.ms : null }; }));
  const up = (h: string) => res.find((x) => x.host === h)?.ms != null;
  let host = old?.host ?? r.host, backOk = old?.backOk ?? 0;
  if (host !== r.host) {                                   // on a fallback: return to the main address once it is stable
    backOk = up(r.host) ? backOk + 1 : 0;
    if (backOk >= 5) { host = r.host; backOk = 0; } else if (!up(host)) { const alt = res.filter((x) => x.ms !== null).sort((a, b) => a.ms! - b.ms!)[0]; if (alt) host = alt.host; }
  } else if (!up(r.host)) { const alt = res.filter((x) => x.ms !== null && x.host !== r.host).sort((a, b) => a.ms! - b.ms!)[0]; if (alt) host = alt.host; }
  const info: RouteInfo = { host, primary: host === r.host, candidates: res, backOk }; routeCache.set(k, info);
  if (old && old.host !== host) log('info', `route to ${r.name} changed: ${old.host} -> ${host}`);
  return info;
}

export function sshArgs(r: Remote, extra: string[] = [], via?: string): string[] {
  const h = via ?? effectiveHost(r);   // another address of the same PC: reuse the SAME host-key entry (known_hosts is never touched)
  const alias = h !== r.host ? ['-o', `HostKeyAlias=${r.host}`, '-o', 'CheckHostIP=no'] : [];
  return ['-i', r.keyPath, '-p', String(r.port), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'ConnectTimeout=6', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2', ...alias, ...extra, '--', `${r.user}@${h}`];
}
/** ssh arguments for BIG copies (program folders, files). If this PC is on the same home network as the remote (measured: 43 MB/s vs 2.5 MB/s through
 *  Tailscale) they use the remote's LAN address, otherwise the normal address. Everything else (control, status) keeps using the normal address.
 *  The LAN address is asked from the remote itself and only used after a real ssh login with the same key + host-key entry worked on it, so a
 *  stranger's device with the same private IP on another network is never trusted. Result cached 5 min. Off with Remote.fastCopy = false. */
const lanCache = new Map<string, { host: string | null; at: number }>();
export async function bulkSshArgs(r: Remote): Promise<string[]> {
  if (r.fastCopy === false) return sshArgs(r);
  const k = routeKey(r); let e = lanCache.get(k);
  if (!e || Date.now() - e.at > 300000) {
    let host: string | null = null;
    try {
      const q = await psRemote(r, `(Get-NetIPConfiguration | ? { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | % { $_.IPv4Address.IPAddress }) -join ','`, { timeout: 20000 });
      const cands = [...new Set([...(r.routes || []), ...(q.code === 0 ? q.stdout.trim().split(',') : [])].map((x) => x.trim()))].filter((x) => x !== r.host && /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))\./.test(x));
      for (const c of cands) {
        if (!(await tcpProbe(c, r.port, 1500)).ok) continue;
        const t = await run('ssh', [...sshArgs(r, [], c), 'echo pcb-lan-ok'], { timeout: 15000 });
        if (t.code === 0 && t.stdout.includes('pcb-lan-ok')) { host = c; break; }
      }
    } catch { /* no LAN path: use the normal address */ }
    e = { host, at: Date.now() }; lanCache.set(k, e);
    log('info', host ? `big copies to ${r.name} use the home-network address ${host}` : `big copies to ${r.name} use the normal address (no home-network path)`);
  }
  return e.host ? sshArgs(r, [], e.host) : sshArgs(r);
}
/** Run a command string on the remote (Windows OpenSSH default shell = cmd.exe). */
export const ssh = (r: Remote, remoteCmd: string, opt?: RunOpt) => run('ssh', [...sshArgs(r), remoteCmd], opt);
/** Run a PowerShell script on the remote via -EncodedCommand (no quoting problems). */
export const psRemote = (r: Remote, script: string, opt?: RunOpt) =>
  ssh(r, `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`, opt);
/**
 * Run a sh script inside the remote's WSL distro. The script travels base64-encoded (only [A-Za-z0-9+/=]),
 * so cmd.exe / ssh / wsl.exe quoting can never mangle it. Stdin of the script is /dev/null.
 */
export const wslSh = (r: Remote, script: string, opt?: RunOpt) => {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return ssh(r, `wsl.exe -e sh -c "t=$(mktemp); echo ${b64} | base64 -d > $t; sh $t </dev/null; rc=$?; rm -f $t; exit $rc"`, opt);
};

export function tcpProbe(host: string, port: number, timeout = 3000): Promise<{ ok: boolean; ms: number; error?: string }> {
  return new Promise((resolve) => {
    const t0 = Date.now(); const s = net.connect({ host, port });
    const end = (ok: boolean, error?: string) => { s.destroy(); resolve({ ok, ms: Date.now() - t0, error }); };
    s.setTimeout(timeout, () => end(false, 'timed out')); s.on('connect', () => end(true)); s.on('error', (e: any) => end(false, e.code || e.message));
  });
}

// ---------- status ----------
export interface Container { name: string; image: string; status: string; state: string; ports: string; cpu: string; mem: string }
export interface Status {
  ts: number;
  route?: { host: string; primary: boolean; candidates: { host: string; ms: number | null }[] };
  tailscale: { state: 'online' | 'offline' | 'unknown'; detail: string };
  ssh: { ok: boolean; latencyMs: number | null; error?: string; headline?: string; checklist?: string[] };
  metrics?: { host: string; cpu: number; ramUsedMB: number; ramTotalMB: number; disks: { id: string; freeGB: number; totalGB: number }[]; gpuNames: string[]; nvidia?: string };
  docker?: { wslRunning: boolean; daemonUp: boolean; error?: string; containers: Container[] };
  portsUp?: Record<string, boolean>;   // remote-side TCP check of the offloaded projects' ports
  local?: Status['metrics'];           // this PC's own CPU / RAM / disks / GPU, so both machines can be compared
  context: string; contextIsRemote: boolean;
}

let tsCache: { t: number; host: string; v: Status['tailscale'] } | undefined;
/** `tailscale status --json` is a process plus a big JSON parse: an "online" answer is reused for 10 s, anything else is always re-checked. */
export async function tailscaleState(r: Remote): Promise<Status['tailscale']> {
  if (tsCache && tsCache.host === r.host && Date.now() - tsCache.t < 10000) return tsCache.v;
  const v = await tailscaleLive(r);
  tsCache = v.state === 'online' ? { t: Date.now(), host: r.host, v } : undefined;
  return v;
}
async function tailscaleLive(r: Remote): Promise<Status['tailscale']> {
  const x = await run('tailscale', ['status', '--json'], { timeout: 5000, poll: true });
  if (x.code !== 0) return { state: 'unknown', detail: 'tailscale CLI failed: ' + (x.stderr || (x.timedOut ? 'timeout' : 'unknown error')).split('\n')[0] };
  try {
    const j = JSON.parse(x.stdout);
    if (j.BackendState && j.BackendState !== 'Running') return { state: 'offline', detail: `This PC's Tailscale is ${j.BackendState}` };
    const peers: any[] = Object.values(j.Peer || {});
    const p = peers.find((q) => (q.TailscaleIPs || []).includes(r.host) || String(q.HostName).toLowerCase() === r.host.toLowerCase() || String(q.DNSName).toLowerCase().startsWith(r.host.toLowerCase() + '.'));
    if (!p) return { state: 'unknown', detail: `${r.host} is not in this tailnet's peer list (not a Tailscale address?)` };
    return p.Online ? { state: 'online', detail: `${p.HostName} online${p.CurAddr ? ' (direct)' : p.Relay ? ' (relay ' + p.Relay + ')' : ''}` }
      : { state: 'offline', detail: `${p.HostName} offline${p.LastSeen ? ', last seen ' + p.LastSeen : ''}` };
  } catch (e: any) { return { state: 'unknown', detail: 'could not parse tailscale output: ' + e.message }; }
}

const CHECKLIST = [
  'Remote PC is powered on, awake (not sleeping/hibernating) and connected to the internet',
  'Tailscale is running and logged in on BOTH PCs (tray icon connected)',
  'OpenSSH Server service (sshd) is running on the remote: Get-Service sshd (set to Automatic)',
  'C:\\Users\\<user>\\.ssh\\authorized_keys exists and is NOT named authorized_keys.txt (admin accounts use C:\\ProgramData\\ssh\\administrators_authorized_keys)',
  'Your private key path in Settings is correct and the file is readable',
];
export function diagnoseSsh(err: string, ts: Status['tailscale']): { headline: string; checklist: string[] } {
  const e = err.toLowerCase(); let h = 'Cannot reach the remote over SSH';
  if (/permission denied|publickey/.test(e)) h = 'SSH reached the remote but the key was rejected (authorized_keys problem)';
  else if (/identity file|no such file|not accessible|bad permissions|unprotected/.test(e)) h = 'Problem with your private key file (missing or wrong permissions)';
  else if (/could not resolve|name or service|enotfound|getaddrinfo/.test(e)) h = 'Host name could not be resolved - check the host/IP in Settings';
  else if (/host key verification/.test(e)) h = 'Host key changed or unknown - verify the machine, then fix ~/.ssh/known_hosts';
  else if (/not found in path/.test(e)) h = 'The ssh program was not found (install the Windows "OpenSSH Client" feature)';
  else if (ts.state === 'offline') h = 'Remote PC is offline in Tailscale (asleep, shut down, or Tailscale stopped)';
  else if (/refused/.test(e)) h = 'Remote is reachable but sshd is not accepting connections (service stopped?)';
  else if (/timed out|timeout/.test(e)) h = 'Connection timed out (remote asleep/offline or Tailscale down)';
  return { headline: h, checklist: CHECKLIST };
}

const STATUS_PS = String.raw`
$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='SilentlyContinue'
$o=@{}; $os=Get-CimInstance Win32_OperatingSystem
$o.host=$env:COMPUTERNAME
$u=(Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -Filter "Name='_Total'").PercentProcessorUtility   # what Task Manager shows (frequency-scaled), not the older time-based LoadPercentage
if($null -eq $u){ $u=(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average }
$o.cpu=[int][math]::Min(100,[double]$u)
$av=(Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory).AvailableMBytes   # available = free + standby cache, like Task Manager's "in use"
$o.ramTotalMB=[int]($os.TotalVisibleMemorySize/1024); $o.ramFreeMB=$(if($av){[int]$av}else{[int]($os.FreePhysicalMemory/1024)})
$o.disks=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | % { @{id=$_.DeviceID; freeGB=[math]::Round($_.FreeSpace/1GB,1); totalGB=[math]::Round($_.Size/1GB,1)} })
$o.gpuNames=@(Get-CimInstance Win32_VideoController | % Name)
$o.nvidia=''; $nv=@("$env:windir\System32\nvidia-smi.exe",'C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe') | ? { Test-Path $_ } | select -First 1
if($nv){ $o.nvidia=((& $nv --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits) -join ';') }
$w=((wsl.exe -l --running | Out-String) -replace '[\0\s]','')
$d=@{wslRunning=($w -match 'Default'); daemonUp=$false; error=''; ps=@(); stats=@()}
if($d.wslRunning){
  $p=@(wsl.exe -e docker ps -a --format '{{json .}}' 2>&1)
  if($LASTEXITCODE -eq 0){ $d.daemonUp=$true; $d.ps=@($p | % { "$_" })
    if($WITHSTATS -and @($p | ? { $_ -match '"State":"running"' }).Count -gt 0){ $d.stats=@(wsl.exe -e docker stats --no-stream --format '{{json .}}' | % { "$_" }) }
  } else { $d.error=(($p | Out-String) -replace '[\0]','').Trim() }
}
$o.docker=$d
$o.portsUp=@{}; foreach($pt in $PORTS){ $c=New-Object Net.Sockets.TcpClient; $a=$c.BeginConnect('127.0.0.1',[int]$pt,$null,$null); $o.portsUp["$pt"]=[bool]($a.AsyncWaitHandle.WaitOne(500) -and $c.Connected); $c.Close() }
'__PCB__' + (ConvertTo-Json $o -Depth 6 -Compress)
`;

function parseDocker(d: any): Status['docker'] {
  const stats = new Map<string, any>();
  for (const l of d.stats || []) { try { const s = JSON.parse(l); stats.set(s.Name, s); } catch { /* skip */ } }
  const containers: Container[] = [];
  for (const l of d.ps || []) {
    try {
      const c = JSON.parse(l); const s = stats.get(c.Names);
      containers.push({ name: c.Names, image: c.Image, status: c.Status, state: c.State, ports: c.Ports || '', cpu: s?.CPUPerc ?? '-', mem: s?.MemUsage?.split('/')[0]?.trim() ?? '-' });
    } catch { /* skip malformed line */ }
  }
  return { wslRunning: !!d.wslRunning, daemonUp: !!d.daemonUp, error: d.error || undefined, containers };
}

/** Every LOCAL docker call goes through here. PCB_FAKE_DOCKER swaps in a scripted engine so failover can be tested without starting Docker Desktop. */
export const dkSpec = (args: string[]) => (process.env.PCB_FAKE_DOCKER ? { cmd: process.execPath, args: [process.env.PCB_FAKE_DOCKER, ...args] } : { cmd: 'docker', args });
export function dk(args: string[], opt?: RunOpt): Promise<RunResult> { const s = dkSpec(args); return run(s.cmd, s.args, opt); }

export async function dockerContext(): Promise<string> {
  if (!process.env.PCB_FAKE_DOCKER) {   // docker's own rule (env, else config.json), read directly: no process per poll
    if (process.env.DOCKER_CONTEXT) return process.env.DOCKER_CONTEXT;
    try { return JSON.parse(fs.readFileSync(path.join(process.env.DOCKER_CONFIG || path.join(os.homedir(), '.docker'), 'config.json'), 'utf8')).currentContext || 'default'; } catch { /* no config: ask docker */ }
  }
  const x = await dk(['context', 'show'], { timeout: 5000, poll: true });
  return x.code === 0 ? x.stdout.trim() : '?';
}

let lastStats: string[] = [];     // docker stats costs ~1.3 s on the remote, so the poller refreshes it only every few cycles
export async function getStatus(r: Remote, withStats = true, ports: number[] = []): Promise<Status> {
  const [ts, tcp, ctx] = await Promise.all([tailscaleState(r), (async () => { await probeRoutes(r); return tcpProbe(effectiveHost(r), r.port); })(), dockerContext()]);
  const ri = routeInfo(r); const base = { ts: Date.now(), tailscale: ts, context: ctx, contextIsRemote: ctx === r.contextName, route: ri ? { host: ri.host, primary: ri.primary, candidates: ri.candidates } : undefined };
  if (!fs.existsSync(r.keyPath)) {   // ssh would silently fall back to a default key and hide the misconfiguration
    const err = `identity file not accessible: ${r.keyPath}`;
    return { ...base, ssh: { ok: false, latencyMs: tcp.ok ? tcp.ms : null, error: err, ...diagnoseSsh(err, ts) } };
  }
  if (!tcp.ok) { const d = diagnoseSsh(tcp.error || '', ts); return { ...base, ssh: { ok: false, latencyMs: null, error: `TCP ${r.host}:${r.port}: ${tcp.error}`, ...d } }; }
  const x = await psRemote(r, `$WITHSTATS=${withStats ? '$true' : '$false'}; $PORTS=@(${ports.join(',')})\n` + STATUS_PS, { timeout: 20000, poll: true });
  const line = x.stdout.split('\n').find((l) => l.startsWith('__PCB__'));
  if (x.code !== 0 || !line) {
    const err = x.timedOut ? 'ssh command timed out' : (x.stderr || x.stdout || `exit ${x.code}`).split('\n').filter((l) => !l.startsWith('#< CLIXML'))[0];
    return { ...base, ssh: { ok: false, latencyMs: tcp.ms, error: err, ...diagnoseSsh(err, ts) } };
  }
  try {
    const j = JSON.parse(line.trim().slice(7));
    return { ...base, ssh: { ok: true, latencyMs: tcp.ms },
      metrics: { host: j.host, cpu: j.cpu, ramTotalMB: j.ramTotalMB, ramUsedMB: j.ramTotalMB - j.ramFreeMB, disks: j.disks, gpuNames: j.gpuNames, nvidia: j.nvidia || undefined },
      portsUp: j.portsUp || {},
      docker: parseDocker(withStats ? (lastStats = j.docker.stats || [], j.docker) : { ...j.docker, stats: lastStats }) };
  } catch (e: any) { return { ...base, ssh: { ok: false, latencyMs: tcp.ms, error: 'bad status output: ' + e.message, ...diagnoseSsh('', ts) } }; }
}

// ---------- this PC's own metrics (pure Node, no child process except an optional nvidia-smi) ----------
let prevCpu = os.cpus().map((c) => ({ ...c.times }));
function localCpuPct(): number {
  const cur = os.cpus(); let idle = 0, total = 0;
  cur.forEach((c, i) => {
    const p = prevCpu[i] ?? c.times, sum = (t: typeof c.times) => t.user + t.nice + t.sys + t.idle + t.irq;
    idle += c.times.idle - p.idle; total += sum(c.times) - sum(p);
  });
  prevCpu = cur.map((c) => ({ ...c.times }));
  return total > 0 ? Math.max(0, Math.min(100, Math.round(100 * (1 - idle / total)))) : 0;
}
/** Task Manager's CPU number is "% Processor Utility" (scaled by clock speed); os.cpus() only has time-based usage, which reads far higher when the CPU runs below full clock.
 *  typeperf is a tiny native exe; sampled in the background, os.cpus() is the fallback (other Windows languages name the counter differently). */
let utilV: number | undefined, utilAt = 0, utilProc: ChildProcess | undefined, utilNext = 0;
/** One long-lived typeperf (a sample every 3 s) instead of a new process per poll. If it exits (counter missing), retry after a minute. */
function cpuUtility(): number | undefined {
  if (!utilProc && Date.now() >= utilNext) {
    utilNext = Date.now() + 60000;
    try {
      const p = utilProc = spawn('typeperf', ['\\Processor Information(_Total)\\% Processor Utility', '-si', '3'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let buf = '';
      p.stdout!.on('data', (d: Buffer) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const r = buf.slice(0, i).trim().split('","'); buf = buf.slice(i + 1); const v = r.length === 2 ? parseFloat(r[1]) : NaN; if (Number.isFinite(v)) { utilV = Math.max(0, Math.min(100, Math.round(v))); utilAt = Date.now(); } } });
      const gone = () => { if (utilProc === p) utilProc = undefined; };
      p.on('error', gone); p.on('exit', gone);
      process.once('exit', () => p.kill());
    } catch { utilProc = undefined; }
  }
  return Date.now() - utilAt < 15000 ? utilV : undefined;
}
let gpuCache: { t: number; names: string[]; nvidia?: string } = { t: 0, names: [] };
export async function localMetrics(): Promise<NonNullable<Status['metrics']>> {
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const disks = (await Promise.all(letters.map(async (l) => {
    try {   // async + timeout: a sleeping network/cloud drive must never freeze the app
      const s: any = await Promise.race([fs.promises.statfs(`${l}:\\`), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 1500))]);
      const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
      return total > 0 ? { id: l + ':', freeGB: Math.round(free / 1e8) / 10, totalGB: Math.round(total / 1e8) / 10 } : null;
    } catch { return null; }
  }))).filter((d): d is { id: string; freeGB: number; totalGB: number } => !!d);
  if (Date.now() - gpuCache.t > 15000) {
    const x = await run('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { timeout: 4000, poll: true });
    gpuCache = { t: Date.now(), names: [], nvidia: x.code === 0 && x.stdout.trim() ? x.stdout.trim().split('\n')[0].replace(/\r/g, '').split(',').map((v) => v.trim()).join(',') : undefined };
  }
  const total = Math.round(os.totalmem() / 1048576);
  const timeBased = localCpuPct();
  return { host: os.hostname(), cpu: cpuUtility() ?? timeBased, ramTotalMB: total, ramUsedMB: total - Math.round(os.freemem() / 1048576), disks, gpuNames: gpuCache.names, nvidia: gpuCache.nvidia };
}

/** One real HTTP request through a local port: proves the forward reaches a live service. */
export function testForward(port: number): Promise<{ ok: boolean; status?: number; ms: number; server?: string; error?: string }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = require('http').get({ host: '127.0.0.1', port, path: '/', timeout: 6000 }, (res: any) => { res.resume(); resolve({ ok: true, status: res.statusCode, ms: Date.now() - t0, server: res.headers.server }); });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, ms: Date.now() - t0, error: 'timed out (tunnel is up but the remote service is not answering)' }); });
    req.on('error', (e: any) => resolve({ ok: false, ms: Date.now() - t0, error: e.code === 'ECONNREFUSED' ? 'nothing is listening on this port (forward is not running)' : e.message }));
  });
}

// ---------- docker context (use remote Docker locally) ----------
export async function useRemoteDocker(c: Config): Promise<string> {
  const r = c.remotes[c.activeRemote]; const url = `ssh://${r.user}@${r.host}${r.port !== 22 ? ':' + r.port : ''}`;
  const cur = await dockerContext();
  const ins = await dk(['context', 'inspect', r.contextName], { timeout: 8000 });
  if (ins.code !== 0) {
    const m = await dk(['context', 'create', r.contextName, '--docker', `host=${url}`], { timeout: 10000 });
    if (m.code !== 0) throw new Error('docker context create failed: ' + m.stderr);
  } else if (!ins.stdout.includes(url)) {
    const m = await dk(['context', 'update', r.contextName, '--docker', `host=${url}`], { timeout: 10000 });
    if (m.code !== 0) throw new Error('docker context update failed: ' + m.stderr);
  }
  if (cur !== r.contextName && cur !== '?') c.localContext = cur;
  const u = await dk(['context', 'use', r.contextName], { timeout: 8000 });
  if (u.code !== 0) throw new Error('docker context use failed: ' + u.stderr);
  return c.localContext;
}
export async function useLocalDocker(c: Config): Promise<void> {
  const target = c.localContext || 'default';
  let u = await dk(['context', 'use', target], { timeout: 8000 });
  if (u.code !== 0 && target !== 'default') u = await dk(['context', 'use', 'default'], { timeout: 8000 });
  if (u.code !== 0) throw new Error('docker context use failed: ' + u.stderr);
}

// ---------- run a project on the remote ----------
export const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
export const remoteName = (p: Project) => (p.name || path.basename(p.path)).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
export const findCompose = (dir: string) => COMPOSE_FILES.find((f) => fs.existsSync(path.join(dir, f)));

/** tar | ssh | tar. Binary-safe pipe; no rsync needed on Windows. Overwrites files, never deletes remote-only ones. */
export function syncProject(r: Remote, p: Project, excludes: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(p.path) || !fs.statSync(p.path).isDirectory()) return reject(new Error(`Folder not found: ${p.path}`));
    if (!findCompose(p.path)) return reject(new Error(`No docker-compose.yml / compose.yaml in ${p.path}`));
    const dest = `~/pcbridge/${remoteName(p)}`;
    const targs = ['-cf', '-', ...excludes.flatMap((e) => ['--exclude', e]), '-C', p.path, '.'];
    const sargs = [...sshArgs(r), `wsl.exe -e sh -c "mkdir -p ${dest} && tar -xf - -C ${dest}"`];
    log('cmd', `$ tar ${targs.join(' ')} | ssh ${sargs.slice(-2).join(' ')}`);
    const t0 = Date.now(); let tarErr = '', sshErr = '', tarCode: number | null = null, sshCode: number | null = null, bytes = 0, settled = false;
    const tar = spawn('tar', targs, { windowsHide: true }); const ss = spawn('ssh', sargs, { windowsHide: true });
    const settle = (err?: Error) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(); };
    const timer = setTimeout(() => { killTree(tar.pid); killTree(ss.pid); settle(new Error('Sync timed out after 10 minutes')); }, 600000);
    tar.stdout.on('data', (d) => (bytes += d.length)); tar.stdout.pipe(ss.stdin);
    ss.stdin.on('error', () => { /* ssh died early; reported via exit code */ });
    tar.stderr.on('data', (d) => (tarErr += d)); ss.stderr.on('data', (d) => (sshErr += clean(d)));
    tar.on('error', (e) => { killTree(ss.pid); settle(new Error('tar failed to start: ' + e.message)); });
    ss.on('error', (e) => { killTree(tar.pid); settle(new Error('ssh failed to start: ' + e.message)); });
    const check = () => {
      if (tarCode === null || sshCode === null) return;
      log('info', `  → sync finished: tar=${tarCode} ssh=${sshCode}, ${(bytes / 1024).toFixed(0)} KiB sent (${Date.now() - t0} ms)`);
      if (sshCode !== 0) return settle(new Error('remote extract failed: ' + (sshErr.trim().split('\n')[0] || 'exit ' + sshCode)));   // report the root cause (ssh), not the tar we killed
      if (tarCode !== 0) return settle(new Error('tar failed: ' + tarErr.trim().split('\n')[0]));
      settle();
    };
    tar.on('close', (c) => { tarCode = c; check(); });
    ss.on('exit', (code) => { ss.stdin.destroy(); if (code !== 0 && tarCode === null) { killTree(tar.pid); tar.stdout.destroy(); } });   // ssh died early (offline remote): don't leave tar blocked on a full pipe
    ss.on('close', (c) => { sshCode = c; check(); });
  });
}

export type ComposeAction = 'up' | 'down' | 'stop' | 'restart' | 'ps' | 'logs';
export async function composeAction(r: Remote, p: Project, action: ComposeAction): Promise<RunResult> {
  const dir = `~/pcbridge/${remoteName(p)}`;
  const withBuild = (() => { try { const f = findCompose(p.path); return !!f && /^\s*build\s*:/m.test(fs.readFileSync(path.join(p.path, f), 'utf8')); } catch { return false; } })();
  const cmd = { up: `docker compose up -d${withBuild ? ' --build' : ''}`, down: 'docker compose down', stop: 'docker compose stop', restart: 'docker compose restart',
    ps: 'docker compose ps -a', logs: 'docker compose logs --tail 200 --no-color' }[action];
  return wslSh(r, `cd ${dir} 2>/dev/null || { echo "Project not synced yet: ${dir}"; exit 3; }\n${cmd} 2>&1`, { timeout: action === 'up' ? 1200000 : 120000, stream: action === 'up' });
}

export async function containerAction(r: Remote, action: 'start' | 'stop' | 'restart' | 'logs', name: string): Promise<RunResult> {
  if (!CONTAINER_RE.test(name)) throw new Error('Invalid container name');
  const sub = action === 'logs' ? `logs --tail 300 --timestamps ${name}` : `${action} ${name}`;
  return ssh(r, `wsl.exe -e docker ${sub}`, { timeout: action === 'logs' ? 20000 : 60000 });
}

/** Wake WSL (starts the distro + docker daemon if it idled off). */
export const wakeDocker = (r: Remote) => ssh(r, 'wsl.exe -e docker info --format {{.ServerVersion}}', { timeout: 60000 });

// ---------- port forwarding with auto-reconnect ----------
export interface FwdState { localPort: number; state: 'starting' | 'active' | 'reconnecting' | 'stopped' | 'failed'; error?: string; restarts: number; label?: string }
interface Fwd { proc?: ChildProcess; desired: boolean; st: FwdState; timer?: NodeJS.Timeout; attempt: number; since: number }
export class Forwarder {
  private m = new Map<number, Fwd>();
  list = (): FwdState[] => [...this.m.values()].map((f) => ({ ...f.st }));
  get = (id: number) => this.m.get(id)?.st;
  async start(r: Remote, f: Forward): Promise<void> {
    const cur = this.m.get(f.localPort);
    if (cur?.desired) return;
    const free = await portFree(f.localPort);
    if (!free) throw new Error(`Local port ${f.localPort} is already in use on this PC (another program or a local Docker container is listening). Stop it, or pick a different local port for this forward.`);
    const e: Fwd = { desired: true, attempt: 0, since: 0, st: { localPort: f.localPort, state: 'starting', restarts: 0 } };
    const args = () => sshArgs(r, ['-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${f.localPort}:${f.remoteHost}:${f.remotePort}`]);
    this.m.set(f.localPort, e); this.spawn(args, `forward ${f.localPort}->${f.remoteHost}:${f.remotePort}`, e);
  }
  /** Keeps the remote WSL VM from idling off (which would kill every container). Id 0 in the table. */
  startKeepAwake(r: Remote, id = 0) {   // id 0 = the active PC; other PCs that run sites use -1, -2, ...
    if (this.m.get(id)?.desired) return;
    const e: Fwd = { desired: true, attempt: 0, since: 0, st: { localPort: 0, state: 'starting', restarts: 0 } };
    this.m.set(id, e); this.spawn(() => [...sshArgs(r), 'wsl.exe -e sleep infinity'], 'keep-awake ' + r.name, e);
  }
  /** Reverse link: port `port` on THAT PC's localhost reaches port `port` on this PC (so a program moved there can call a service that lives elsewhere). `id` is a negative table key. */
  startReverse(r: Remote, port: number, id: number) {
    if (this.m.get(id)?.desired) return;
    const e: Fwd = { desired: true, attempt: 0, since: 0, st: { localPort: 0, state: 'starting', restarts: 0, label: `link ${r.name}:${port} -> this PC` } };
    this.m.set(id, e); this.spawn(() => sshArgs(r, ['-N', '-o', 'ExitOnForwardFailure=yes', '-R', `127.0.0.1:${port}:127.0.0.1:${port}`]), `link ${r.name}:${port}`, e);
  }
  has = (id: number) => !!this.m.get(id)?.desired;
  private spawn(argsFn: () => string[], label: string, e: Fwd) {
    if (!e.desired) return;
    const args = argsFn(); log('cmd', `$ ssh ${args.join(' ')}`);
    e.since = Date.now(); let err = '';
    const p = spawn('ssh', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); e.proc = p;
    p.stderr!.on('data', (d) => (err += clean(d)));
    const mark = () => { if (e.desired && e.proc === p) { e.st.state = 'active'; e.st.error = undefined; } };
    let probing = true;   // a forward is "active" only once its local port really accepts connections (keep-awake has no port: time based)
    const poll = async () => { for (let i = 0; i < 40 && probing && e.desired && e.proc === p; i++) { if ((await tcpProbe('127.0.0.1', e.st.localPort, 400)).ok) return mark(); await new Promise((r) => setTimeout(r, 200)); } };
    const up = setTimeout(() => { e.st.localPort > 0 ? void poll() : mark(); }, e.st.localPort > 0 ? 100 : 1800);
    p.on('exit', () => { probing = false; });
    p.on('error', (x) => { err += x.message; });
    p.on('close', (code) => {
      clearTimeout(up); if (e.proc !== p) return;
      const msg = err.trim().split('\n').filter(Boolean).pop() || `ssh exited (${code})`;
      log('err', `${label} ended: ${msg}`);
      if (!e.desired) { e.st.state = 'stopped'; return; }
      if (Date.now() - e.since > 20000) e.attempt = 0;       // it was stable: restart backoff
      e.attempt++; e.st.restarts++; e.st.state = 'reconnecting'; e.st.error = msg;
      const delay = Math.min(1000 * 2 ** Math.min(e.attempt, 4), 15000);
      log('info', `${label}: reconnecting in ${delay / 1000}s (attempt ${e.attempt})`);
      e.timer = setTimeout(() => this.spawn(argsFn, label, e), delay);
    });
  }
  stop(localPort: number) {
    const e = this.m.get(localPort); if (!e) return;
    e.desired = false; clearTimeout(e.timer); killTree(e.proc?.pid); e.st.state = 'stopped';
  }
  stopAll() { for (const k of this.m.keys()) this.stop(k); }
  /** For tests: kill the ssh child without marking it as user-stopped, to simulate a network drop. */
  simulateDrop(localPort: number) { killTree(this.m.get(localPort)?.proc?.pid); }
}
/**
 * True only if NOTHING on this PC listens on the port. Windows lets a bind to 127.0.0.1 succeed while another program holds the
 * wildcard (0.0.0.0 / ::), and `localhost` may resolve to ::1 first - so check by connecting on both stacks AND by binding the wildcards.
 */
export async function portFree(port: number): Promise<boolean> {
  for (const h of ['127.0.0.1', '::1']) if ((await tcpProbe(h, port, 700)).ok) return false;
  const bind = (host: string) => new Promise<boolean | null>((res) => {
    const s = net.createServer(); s.once('error', (e: any) => res(e.code === 'EADDRINUSE' || e.code === 'EACCES' ? false : null));   // null = this stack unavailable
    s.once('listening', () => s.close(() => res(true))); s.listen(port, host);
  });
  return (await bind('0.0.0.0')) !== false && (await bind('::')) !== false;
}

// ---------- remote shell ----------
export function openShell(r: Remote): Promise<string> {
  const sshCmd = ['ssh', ...sshArgs(r)];
  const tryRun = (cmd: string, args: string[]) => new Promise<boolean>((res) => {
    log('cmd', `$ ${cmd} ${args.map(short).join(' ')}`);
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
    p.once('error', () => res(false)); p.once('spawn', () => { p.unref(); res(true); });
  });
  return (async () => {
    if (await tryRun('wt.exe', sshCmd)) return 'Windows Terminal';
    log('info', 'wt.exe not found, falling back to PowerShell window');
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    if (await tryRun('cmd.exe', ['/c', 'start', '', 'powershell.exe', '-NoExit', '-Command', '& ssh ' + sshCmd.slice(1).map(q).join(' ')])) return 'PowerShell';
    throw new Error('Could not open a terminal (neither wt.exe nor powershell.exe started)');
  })();
}

// ---------- offload a live site to the remote, with automatic failback ----------
import { createGzip } from 'zlib';
const IMG_RE = /^[A-Za-z0-9][A-Za-z0-9._\/:@-]*$/;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The docker context that means "this PC" (never the remote one). */
export async function localCtx(c: Config): Promise<string> {
  if (c.localContext) return c.localContext;
  const cur = await dockerContext();
  return cur !== '?' && cur !== c.remotes[c.activeRemote].contextName ? cur : 'default';
}
function composeBase(ctx: string, p: Project) {
  const f = findCompose(p.path); if (!f) throw new Error(`No compose file in ${p.path}`);
  return ['--context', ctx, 'compose', '--project-directory', p.path, '-f', path.join(p.path, f)];
}
export async function localCompose(c: Config, p: Project, action: 'up' | 'stop' | 'ps'): Promise<RunResult> {
  const sub = { up: ['up', '-d'], stop: ['stop'], ps: ['ps', '-a'] }[action];
  return dk([...composeBase(await localCtx(c), p), ...sub], { timeout: 600000, stream: action !== 'ps' });
}

function pipeImage(ctx: string, r: Remote, img: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const save = spawn('docker', ['--context', ctx, 'save', img], { windowsHide: true });
    const ss = spawn('ssh', [...sshArgs(r), 'wsl.exe -e sh -c "gunzip | docker load"'], { windowsHide: true });
    log('cmd', `$ docker save ${img} | gzip | ssh ... docker load`);
    let e1 = '', e2 = '', c1: number | null = null, c2: number | null = null, done = false;
    const fin = (err?: Error) => { if (done) return; done = true; clearTimeout(t); err ? reject(err) : resolve(); };
    const t = setTimeout(() => { killTree(save.pid); killTree(ss.pid); fin(new Error(`copying image ${img} timed out`)); }, 1800000);
    save.stdout.pipe(createGzip()).pipe(ss.stdin); ss.stdin.on('error', () => { /* reported via exit code */ });
    save.stderr.on('data', (d) => (e1 += d)); ss.stderr.on('data', (d) => (e2 += clean(d)));
    const chk = () => {   // receiver (ssh) errors are the root cause; a "pipe closed" from docker save is only the symptom
      if (c1 === null || c2 === null) return;
      c2 !== 0 ? fin(new Error('copying to the remote failed: ' + (e2.trim().split('\n').pop() || 'exit ' + c2))) : c1 !== 0 ? fin(new Error('docker save failed: ' + e1.trim())) : fin();
    };
    save.on('close', (c) => { c1 = c; chk(); });
    // Receiver gone: close its stdin (a dead ssh that never got data never raises EPIPE, so 'close' would never fire) and stop the sender.
    ss.on('exit', (code) => { ss.stdin.destroy(); if (code !== 0 && c1 === null) { killTree(save.pid); save.stdout.destroy(); } });   // only on FAILURE (killing after a success would turn it into a false error); unread stdout would also keep 'close' from ever firing
    ss.on('close', (c) => { c2 = c; chk(); });
    save.on('error', (e) => fin(e)); ss.on('error', (e) => fin(e));
  });
}

/** Make sure every image the project's compose file uses exists on the remote: pull there if public, else copy from this PC. */
export async function syncImages(c: Config, r: Remote, p: Project): Promise<string[]> {
  const ctx = await localCtx(c); const moved: string[] = [];
  const cfg = await dk([...composeBase(ctx, p), 'config', '--images'], { timeout: 30000 });
  if (cfg.code !== 0) throw new Error('docker compose config failed: ' + cfg.stderr.split('\n')[0]);
  for (const img of new Set(cfg.stdout.split('\n').map((x) => x.trim()).filter(Boolean))) { const m = await ensureImageOnRemote(c, r, img); if (m) moved.push(m); }
  return moved;
}

/** One image: nothing to do if the remote has it; else pull it there (public images), else copy it from this PC. Returns what was done, or null. */
export async function ensureImageOnRemote(c: Config, r: Remote, img: string): Promise<string | null> {
  if (!IMG_RE.test(img)) { log('err', `skipping image with unusual name: ${img}`); return null; }
  const ctx = await localCtx(c);
  if ((await ssh(r, `wsl.exe -e docker image inspect ${img} --format ok`, { timeout: 20000 })).code === 0) return null;
  const pull = await ssh(r, `wsl.exe -e docker pull ${img}`, { timeout: 900000, stream: true });
  if (pull.code === 0) return `${img} (pulled on remote)`;
  if ((await dk(['--context', ctx, 'image', 'inspect', img, '--format', 'ok'], { timeout: 15000 })).code !== 0) {
    log('info', `image ${img} is neither pullable nor on this PC; the remote will build it from the synced sources`); return null;
  }
  await pipeImage(ctx, r, img); return `${img} (copied from this PC)`;
}

async function waitFree(port: number, ms: number) { const end = Date.now() + ms; while (Date.now() < end) { if (await portFree(port)) return true; await sleep(400); } return false; }
async function remotePortsUp(r: Remote, ports: number[]): Promise<boolean> {
  const x = await psRemote(r, `$ProgressPreference='SilentlyContinue'; $ok=$true; foreach($pt in @(${ports.join(',')})){ $c=New-Object Net.Sockets.TcpClient; $a=$c.BeginConnect('127.0.0.1',[int]$pt,$null,$null); if(-not ($a.AsyncWaitHandle.WaitOne(800) -and $c.Connected)){$ok=$false}; $c.Close() }; if($ok){'UP'}else{'DOWN'}`, { timeout: 20000 });
  return x.stdout.includes('UP');
}

async function localDockerUp(c: Config): Promise<boolean> {
  const ctx = await localCtx(c);
  return (await dk(['--context', ctx, 'info', '--format', '{{.ServerVersion}}'], { timeout: 20000, poll: true })).code === 0;
}
/** Failover needs this PC's docker engine. If Docker Desktop is not running, start it and wait (up to 3 minutes). */
export async function ensureLocalDocker(c: Config): Promise<void> {
  if (await localDockerUp(c)) return;
  log('info', 'Local Docker engine is not running - starting Docker Desktop');
  if (process.env.PCB_FAKE_DOCKER) await dk(['__start_desktop']);
  else {
    const w = await run('where', ['docker'], { timeout: 5000, poll: true }); const first = w.stdout.split(/\r?\n/)[0]?.trim();
    const guess = first ? path.resolve(path.dirname(first), '..', '..', 'Docker Desktop.exe') : '';   // ...\DockerDesktop\resources\bin\docker.exe -> ...\DockerDesktop\Docker Desktop.exe
    const exe = [guess, 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'].find((f) => f && fs.existsSync(f));
    if (!exe) throw new Error('Docker Desktop is not running and its program was not found - start it manually');
    log('cmd', `$ "${exe}"`); spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  }
  for (let i = 0; i < 60; i++) { await sleep(3000); if (await localDockerUp(c)) { log('info', 'Local Docker engine is up'); return; } }
  throw new Error('Docker Desktop did not become ready within 3 minutes');
}
async function localStart(c: Config, p: Project): Promise<void> {
  await ensureLocalDocker(c); const ctx = await localCtx(c);
  const x = p.container ? await dk(['--context', ctx, 'start', p.container], { timeout: 60000 }) : await localCompose(c, p, 'up');
  if (x.code !== 0) throw new Error(`could not start ${p.container ?? 'the project'} on this PC: ${(x.stderr || x.stdout).trim().split('\n').slice(-3).join(' ')}`);
}
async function localStop(c: Config, p: Project): Promise<void> {
  if (!(await localDockerUp(c))) { log('info', 'local Docker is not running - nothing to stop on this PC'); return; }
  const ctx = await localCtx(c);
  const x = p.container ? await dk(['--context', ctx, 'stop', p.container], { timeout: 60000 }) : await localCompose(c, p, 'stop');
  if (x.code !== 0 && !/No such container/i.test(x.stderr)) throw new Error('could not stop the local copy: ' + x.stderr.split('\n')[0]);
}

/** Is the site (partly) served by the remote? */
export const isAway = (p: Project) => p.mode === 'remote' || p.mode === 'split';
/** A free local port for the ssh tunnel of a split site (asked from the OS, so it avoids ephemeral/excluded ranges). */
export function freePort(): Promise<number> {
  return new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
}
/** An address of THIS PC (not loopback) under which the local container is reachable while the split proxy owns 127.0.0.1:port. Tailscale's 100.x is stable; LAN IPs change. */
export function localBackendHost(): string {
  const all = Object.values(os.networkInterfaces()).flat().filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  const ts = all.find((a) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a)); const lan = all.find((a) => /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(a));
  const h = ts ?? lan; if (!h) throw new Error('This PC has no Tailscale or private-network (LAN) address, so a split cannot reach the local copy (a public address is never used)');
  return h;
}

export class Offloader {
  private fails = new Map<string, number>(); private good = new Map<string, number>(); private busy = new Set<string>(); private recon = new Map<string, number>();
  constructor(private cfg: () => Config, private save: () => void, private fwd: Forwarder, public bal: Balancer = new Balancer()) {}
  private find(name: string) { const c = this.cfg(); const p = c.projects.find((x) => x.name === name); if (!p) throw new Error(`Unknown project "${name}"`); return { c, p, r: remoteFor(c, p.remote) }; }
  isBusy = (name: string) => this.busy.has(name);
  private startForwards(r: Remote, p: Project) { return Promise.all((p.ports || []).map((n) => this.fwd.start(r, { name: p.name, localPort: n, remotePort: n, remoteHost: '127.0.0.1' }))); }

  /** Steps 1-4 of an offload: make sure the remote runs its own copy and is answering on the site's ports. Touches nothing on this PC. */
  private async prepareRemote(c: Config, r: Remote, p: Project, name: string, tag: string): Promise<void> {
    if (p.container) {   // container project: the remote already has its own copy; just make sure it is running
      log('info', `[${tag} ${name}] 1/4 making sure ${r.name} is running its own "${p.container}"`);
      const s0 = await ssh(r, `wsl.exe -e docker start ${p.container}`, { timeout: 60000 });
      if (s0.code !== 0) throw new Error(`The remote has no container named "${p.container}" (${(s0.stderr || s0.stdout).trim().split('\n')[0]}). Nothing was changed on this PC.`);
    } else {
      log('info', `[${tag} ${name}] 1/6 syncing images`); const imgs = await syncImages(c, r, p); if (imgs.length) log('info', 'images: ' + imgs.join(', '));
      log('info', `[${tag} ${name}] 2/6 syncing project files`); await syncProject(r, p, c.syncExcludes);
      log('info', `[${tag} ${name}] 3/6 starting on remote`); const up = await composeAction(r, p, 'up');
      if (up.code !== 0) throw new Error('docker compose up on remote failed: ' + (up.stdout + up.stderr).trim().split('\n').slice(-6).join('\n'));
    }
    log('info', `[${tag} ${name}] 4/6 waiting for remote ports ${p.ports!.join(',')}`);
    let live = false; for (let i = 0; i < 40 && !live; i++) { live = await remotePortsUp(r, p.ports!); if (!live) await sleep(1500); }
    if (!live) throw new Error(`Remote never opened port(s) ${p.ports!.join(',')} - the site did not start there (see compose logs). Your local copy is untouched.`);
  }

  /** Stop the split proxy + the tunnel to the remote copy. Both copies keep running; the local container's own published port answers again. */
  private unsplit(p: Project) {
    for (const n of p.ports || []) this.bal.stop(n);
    if (p.altPort) this.fwd.stop(p.altPort);
  }

  /**
   * Choose how the load is shared between THIS PC and the remote: share = % of connections for the remote (0 = all here, 100 = all remote, default).
   * 0/100 use the proven single-PC paths; anything in between runs the site on BOTH PCs behind a weighted proxy on localhost:port.
   */
  async setShare(name: string, share: number): Promise<string> {
    if (!Number.isInteger(share) || share < 0 || share > 100) throw new Error('share must be a whole number from 0 to 100');
    const { c, p, r } = this.find(name);
    if (!p.ports?.length) throw new Error('Set the port(s) the site serves on first (e.g. 8000)');
    if (this.busy.has(name)) throw new Error('Another operation on this project is still running');
    if (p.ports.length > 1 && share > 0 && share < 100) throw new Error('A split works for one port at a time; this site publishes several ports');
    const was = p.mode ?? 'local';
    if (share === 100) {
      if (was === 'split') this.unsplit(p);
      if (was !== 'remote') await this.offload(name);
      p.share = 100; this.save(); return 'all connections go to the remote PC';
    }
    if (share === 0) {
      if (was === 'split') {
        this.busy.add(name);
        try { await localStart(c, p); this.unsplit(p); } finally { this.busy.delete(name); }
        p.mode = 'local'; p.paused = true;
        if (p.container) ssh(r, `wsl.exe -e docker stop ${p.container}`, { timeout: 60000 }).catch(() => 0); else composeAction(r, p, 'stop').catch(() => 0);
      } else if (was === 'remote') await this.bringHome(name, 'manual');
      p.share = 0; this.save(); return 'all connections are served by this PC';
    }
    const port = p.ports[0];
    if (was === 'split' && this.bal.has(port)) { this.bal.setWeights(port, { local: 100 - share, remote: share }); p.share = share; this.save(); return `split updated: ${100 - share}% this PC / ${share}% remote`; }
    this.busy.add(name);
    try {
      log('info', `[split ${name}] ${100 - share}% this PC / ${share}% remote (was ${was})`);
      if (was !== 'remote') await this.prepareRemote(c, r, p, name, 'split');
      const alt = p.altPort && (await portFree(p.altPort)) ? p.altPort : await freePort();
      if (was === 'remote') { this.fwd.stop(port); if (!(await waitFree(port, 10000))) throw new Error(`Local port ${port} did not free up`); }
      p.altPort = alt;
      await this.fwd.start(r, { name: p.name + '-alt', localPort: alt, remotePort: port, remoteHost: '127.0.0.1' });
      for (let i = 0, up = false; !up; i++) { up = (await tcpProbe('127.0.0.1', alt, 800)).ok; if (!up && i >= 30) throw new Error('the tunnel to the remote copy did not come up'); if (!up) await sleep(400); }
      await localStart(c, p);
      const lh = localBackendHost(); let lup = false; for (let i = 0; i < 60 && !lup; i++) { lup = (await tcpProbe(lh, port, 1000)).ok; if (!lup) await sleep(1000); }
      if (!lup) throw new Error(`The local copy is not reachable on ${lh}:${port} (is it published on 127.0.0.1 only? it must be published on all addresses for a split)`);
      await this.bal.start(port, [{ name: 'local', host: lh, port, weight: 100 - share }, { name: 'remote', host: '127.0.0.1', port: alt, weight: share }]);
      p.mode = 'split'; p.remote = r.name; p.share = share; p.paused = false; p.failedOver = false; this.fails.set(name, 0); this.save();
      log('info', `[split ${name}] DONE - localhost:${port} -> ${100 - share}% this PC (${lh}), ${share}% ${r.name}`);
      return `split active: ${100 - share}% this PC / ${share}% remote`;
    } catch (e: any) {
      log('err', `[split ${name}] failed: ${e.message} - rolling back`);
      this.bal.stop(port); if (p.altPort) this.fwd.stop(p.altPort);
      if (was === 'remote') { await waitFree(port, 5000); await this.startForwards(r, p).catch((x) => log('err', `[split ${name}] could not restore the forward: ${x.message}`)); }
      throw e;
    } finally { this.busy.delete(name); }
  }

  /** Move the site: sync -> start on remote -> verify -> stop local copy -> forward the same local ports to the remote. Rolls back on any failure. */
  async offload(name: string): Promise<void> {
    const { c, p, r } = this.find(name);
    if (!p.ports?.length) throw new Error('Set the port(s) the site serves on first (e.g. 8000)');
    if (this.busy.has(name)) throw new Error('Another operation on this project is still running');
    this.busy.add(name); let localStopped = false;
    try {
      await this.prepareRemote(c, r, p, name, 'offload');
      log('info', `[offload ${name}] 5/6 stopping the local copy`); localStopped = true;
      await localStop(c, p);
      for (const n of p.ports) if (!(await waitFree(n, 30000))) throw new Error(`Local port ${n} is still in use after stopping the project (another program?)`);
      log('info', `[offload ${name}] 6/6 forwarding localhost:${p.ports.join(',')} -> remote`); await this.startForwards(r, p);
      for (const n of p.ports) {   // the tunnel needs a moment before the local port accepts connections: don't report DONE until it does
        let up = false; for (let i = 0; i < 30 && !up; i++) { up = (await tcpProbe('127.0.0.1', n, 1000)).ok; if (!up) await sleep(500); }
        if (!up) throw new Error(`The forward on localhost:${n} did not come up (ssh tunnel failed) - see the command log`);
      }
      p.mode = 'remote'; p.remote = r.name; p.failedOver = false; p.paused = false; this.fails.set(name, 0); this.save();
      log('info', `[offload ${name}] DONE - http://localhost:${p.ports[0]} is now served by ${r.name}`);
    } catch (e: any) {
      log('err', `[offload ${name}] failed: ${e.message} - rolling back`);
      for (const n of p.ports) this.fwd.stop(n);
      if (localStopped) { for (const n of p.ports) await waitFree(n, 5000); await localStart(c, p).catch((x) => log('err', `[offload ${name}] could not restart the local copy: ${x.message}`)); }
      throw e;
    } finally { this.busy.delete(name); }
  }

  /** Back to this PC (manual, or automatic failover when `reason` is 'failover' and the remote is unreachable). */
  async bringHome(name: string, reason: 'manual' | 'failover' | 'quit' = 'manual'): Promise<void> {
    const { c, p, r } = this.find(name);
    if (this.busy.has(name)) throw new Error('Another operation on this project is still running');
    this.busy.add(name);
    try {
      log('info', `[bring home ${name}] reason=${reason}`);
      const wasSplit = p.mode === 'split'; this.unsplit(p);
      for (const n of p.ports || []) this.fwd.stop(n);
      if (!wasSplit) for (const n of p.ports || []) await waitFree(n, 8000);
      await localStart(c, p);
      p.mode = 'local'; p.share = 0; p.failedOver = reason === 'failover'; if (reason === 'manual') p.paused = true;   // manual = the user wants it here: no automatic re-offload
      this.fails.set(name, 0); this.good.set(name, 0); this.save();
      log('info', `[bring home ${name}] DONE - served from this PC`);
      if (reason === 'manual' && !p.container) composeAction(r, p, 'stop').then((x) => log('info', `remote copy stopped (exit ${x.code})`), () => { /* remote unreachable: nothing to stop */ });
    } finally { this.busy.delete(name); }
  }

  /**
   * Offload ANY container of this PC. Compose-managed -> its compose project (files + images synced). Standalone -> first build a twin on the remote
   * (image, config, volume data), then the same forward/failover logic as everything else. The local copy is only stopped once the remote one answers.
   */
  async adoptAndOffload(name: string, share = 100, target?: string): Promise<string> {
    const c = this.cfg(); if (target && !c.remotes.some((x) => x.name === target)) throw new Error(`There is no PC named "${target}"`);
    const existing = c.projects.find((x) => x.container === name || x.name === name); if (existing && target && existing.remote !== target && isAway(existing)) throw new Error(`"${name}" already runs on ${remoteFor(c, existing.remote).name}. Bring it back first, then move it to ${target}.`);
    const r = remoteFor(c, target ?? existing?.remote);
    if (this.busy.has(name)) throw new Error('Another operation on this container is still running');
    const all = await listLocalContainers(c); const info = all.find((x) => x.name === name);
    if (!info) throw new Error(`There is no container named "${name}" on this PC`);
    if (info.composeProject && info.composeDir && findCompose(info.composeDir)) {
      const ports = [...new Set(all.filter((x) => x.composeProject === info.composeProject).flatMap((x) => x.ports))].sort((a, b) => a - b);
      if (!ports.length) throw new Error(`The compose project "${info.composeProject}" publishes no ports, so there is nothing to forward. Nothing was changed.`);
      let p = c.projects.find((x) => x.path === info.composeDir);
      if (!p) { p = { name: info.composeProject, path: info.composeDir, ports, failover: true, autoFailback: true, autoOffload: true, mode: 'local' }; c.projects.push(p); }
      else { p.ports = ports; p.autoOffload = true; p.paused = false; }
      if (target) p.remote = target;
      this.save(); if (share < 100) return await this.setShare(p.name, share); await this.offload(p.name); return `compose project "${p.name}" is now served by the remote`;
    }
    if (!info.ports.length) throw new Error(`"${name}" publishes no ports, so there is nothing to forward. Nothing was changed.`);
    let p = c.projects.find((x) => x.container === name);
    if (!p) { p = { name, path: '', container: name, ports: info.ports, failover: true, autoFailback: true, autoOffload: true, mode: 'local' }; c.projects.push(p); }
    else { p.ports = info.ports; p.autoOffload = true; p.paused = false; }
    if (target) p.remote = target;
    this.save();
    let note = '';
    if ((await ssh(r, `wsl.exe -e docker inspect ${name} --format ok`, { timeout: 20000 })).code !== 0) {   // remote has no twin yet: build one
      this.busy.add(name); let stopped = false;
      try {
        if (info.state === 'running') { log('info', `[adopt ${name}] stopping the local container for a consistent data copy`); await localStop(c, p); stopped = true; }
        note = await cloneContainerToRemote(c, r, name); log('info', `[adopt ${name}] ${note}`);
      } catch (e: any) {
        if (stopped) await localStart(c, p).catch((x) => log('err', `could not restart ${name} locally: ${x.message}`));
        throw e;
      } finally { this.busy.delete(name); }
    }
    if (share < 100) return `${await this.setShare(name, share)}${note ? ' (' + note + ')' : ''}`;
    await this.offload(name); return `"${name}" is now served by the remote${note ? ' (' + note + ')' : ''}`;
  }

  /** A split site: tell the proxy whether the remote copy is healthy (a dead ssh -L tunnel accepts connections and closes them, so only the poll can tell); rebuild the split after an app restart. */
  private async watchSplit(p: Project, s: Status, r: Remote, c: Config) {
    const port = p.ports![0]; const healthy = s.ssh.ok && (!s.portsUp || s.portsUp[String(port)]);
    if (!this.bal.has(port)) {      // the app was restarted: rebuild tunnel + proxy from the saved share
      if (!healthy || this.busy.has(p.name)) return;
      const share = p.share ?? 50; p.mode = 'local';
      try { await this.setShare(p.name, share); } catch (e: any) { log('err', `[split ${p.name}] restore failed: ${e.message}`); p.mode = 'split'; }
      return;
    }
    const n = healthy ? 0 : (this.fails.get(p.name) || 0) + 1; this.fails.set(p.name, n);
    if (healthy) { if (p.altPort && this.fwd.get(p.altPort)?.state === 'stopped') this.fwd.start(r, { name: p.name + '-alt', localPort: p.altPort, remotePort: port, remoteHost: '127.0.0.1' }).catch(() => 0); this.bal.setHealth(port, 'remote', true); }
    else { this.bal.setHealth(port, 'remote', false); if (n === 1) log('err', `[split ${p.name}] remote unhealthy - all connections go to this PC until it recovers`); }
    if (!healthy && n >= 3 && p.failover && !(await tcpProbe(localBackendHost(), port, 800)).ok) await localStart(c, p).catch((e) => log('err', `[split ${p.name}] could not start the local copy: ${e.message}`));
  }

  /** Feed every status poll in. Drives failover (3 bad polls in a row), optional failback, and re-creates forwards after an app restart. */
  /** Reachability of the PCs that are NOT the active one (the active PC's full status arrives in onStatus). Fed by the service's light probe. */
  private health = new Map<string, { ok: boolean; why: string }>();
  setHealth(pc: string, ok: boolean, why = '') { this.health.set(pc, { ok, why }); }
  healthOf = (pc: string): boolean | undefined => this.health.get(pc)?.ok;
  private statusOf(r: Remote): Status | null { const h = this.health.get(r.name); return h ? ({ ssh: { ok: h.ok, headline: h.why }, portsUp: undefined } as unknown as Status) : null; }

  async onStatus(s0: Status): Promise<void> {
    const c = this.cfg(), active = c.remotes[c.activeRemote];
    for (const p of c.projects) {
      if (!p.ports?.length || this.busy.has(p.name)) continue;
      const r = remoteFor(c, p.remote); const s = r === active ? s0 : this.statusOf(r); if (!s) continue;   // a site on another PC is judged by that PC's own reachability
      if (p.mode === 'split') { await this.watchSplit(p, s, r, c); continue; }
      if (p.mode === 'remote') {
        const portsOk = !s.ssh.ok || !s.portsUp || p.ports.every((n) => s.portsUp![String(n)]);
        const healthy = s.ssh.ok && portsOk;
        const n = healthy ? 0 : (this.fails.get(p.name) || 0) + 1; this.fails.set(p.name, n);
        if (healthy && p.ports.some((port) => !this.fwd.get(port) || this.fwd.get(port)!.state === 'stopped') && ((this.recon.set(p.name + '/fw', (this.recon.get(p.name + '/fw') || 0) + 1).get(p.name + '/fw')! - 1) % 5) === 0) {
          // a copy of the site is running on this PC again (Docker restart / manual start) and holds the port: stop it, then forward to the remote one
          this.busy.add(p.name);
          try { if (p.ports.some(() => true) && !(await portFree(p.ports[0]))) { log('info', `[${p.name}] port ${p.ports[0]} is held by a copy on this PC - stopping it so the remote one serves`); await localStop(c, p); await waitFree(p.ports[0], 30000); } await this.startForwards(r, p); }
          catch (e: any) { log('err', `forward restart: ${e.message}`); } finally { this.busy.delete(p.name); }
        }
        // a local copy that got started again (Docker restart, manual start) next to the remote one is stopped, so only one PC runs the site
        if (healthy && p.container && p.mode === 'remote' && p.ports.every((n) => this.fwd.get(n)?.state === 'active') && (this.recon.set(p.name, (this.recon.get(p.name) || 0) + 1).get(p.name)! % 10) === 0) {
          const ctx = await localCtx(c).catch(() => ''); const q = ctx ? await dk(['--context', ctx, 'ps', '-q', '--filter', `name=^${p.container}$`], { timeout: 10000, poll: true }) : null;
          if (q && q.code === 0 && q.stdout.trim()) { log('info', `[${p.name}] a second copy was running on this PC - stopping it (the remote one serves)`); await localStop(c, p).catch((e) => log('err', `[${p.name}] ${e.message}`)); }
        }
        if (!healthy && p.failover && n >= 3) {
          log('err', `[failover ${p.name}] remote unhealthy for ${n} polls (${s.ssh.ok ? 'ports down' : s.ssh.headline || 'ssh down'}) - starting on this PC`);
          await this.bringHome(p.name, 'failover').catch((e) => log('err', `[failover ${p.name}] FAILED: ${e.message}`));
        }
      } else if (!p.paused && (p.autoOffload || (p.failedOver && p.autoFailback))) {
        // prefer the remote: offload after 3 healthy polls (start-up) or ~15 (after a failover, to avoid flapping); retry a failed attempt only after ~20 polls
        const g = s.ssh.ok ? (this.good.get(p.name) || 0) + 1 : Math.min(0, this.good.get(p.name) || 0); this.good.set(p.name, g);
        if (g >= (p.failedOver ? 15 : 3)) {
          this.good.set(p.name, -20); log('info', `[${p.failedOver ? 'failback' : 'auto-offload'} ${p.name}] remote is healthy - moving the site there`);
          await this.offload(p.name).catch((e) => log('err', `[${p.failedOver ? 'failback' : 'auto-offload'} ${p.name}] ${e.message}`));
        }
      }
    }
  }
}

// ---------- ANY container on this PC: list them and build a faithful twin on the remote ----------
export interface LocalContainer { name: string; image: string; state: string; ports: number[]; composeProject?: string; composeDir?: string }
const shq = (s: string) => "'" + s.split("'").join("'\\''") + "'";   // POSIX single-quote escaping for scripts that run inside WSL

export function containerFromInspect(i: any): LocalContainer {
  const hp = new Set<number>();
  for (const binds of Object.values(i.HostConfig?.PortBindings || {})) for (const b of (binds as any[]) || []) { const n = Number(b.HostPort); if (n) hp.add(n); }
  const L = i.Config?.Labels || {};
  return { name: String(i.Name || '').replace(/^\//, ''), image: i.Config?.Image || '', state: i.State?.Status || '?', ports: [...hp].sort((a, b) => a - b),
    composeProject: L['com.docker.compose.project'], composeDir: L['com.docker.compose.project.working_dir'] };
}

export async function listLocalContainers(c: Config): Promise<LocalContainer[]> {
  if (!(await localDockerUp(c))) throw new Error('Docker is not running on this PC. Start Docker Desktop to list its containers.');
  const ctx = await localCtx(c);
  const ls = await dk(['--context', ctx, 'ps', '-a', '--format', '{{.Names}}'], { timeout: 20000 });
  const names = ls.stdout.split('\n').map((s) => s.trim()).filter((n) => CONTAINER_RE.test(n));
  if (!names.length) return [];
  const ins = await dk(['--context', ctx, 'inspect', ...names], { timeout: 30000 });
  if (ins.code !== 0) throw new Error('docker inspect failed: ' + ins.stderr.split('\n')[0]);
  return (JSON.parse(ins.stdout) as any[]).map(containerFromInspect);
}

/** `docker create` arguments that rebuild a container from its `docker inspect` JSON (image, env, ports, restart policy, user, cmd, mounts). Refuses what cannot move. */
export function createArgsFromInspect(i: any, o: { name?: string; portMap?: Record<string, number> } = {}): { args: string[]; mounts: { dest: string; vol: string }[] } {
  const hc = i.HostConfig || {}, cf = i.Config || {}, nm = hc.NetworkMode;
  if (hc.Privileged || (hc.Devices || []).length || (hc.DeviceRequests || []).length) throw new Error('privileged / device / GPU containers cannot be recreated on the remote (different hardware)');
  if (nm && !['default', 'bridge'].includes(nm)) throw new Error(`the container uses the custom Docker network "${nm}"; multi-container setups should be a docker compose project`);
  const name = o.name || String(i.Name || '').replace(/^\//, '');
  const a = ['--name', name];
  const rp = hc.RestartPolicy; if (rp?.Name && rp.Name !== 'no') a.push('--restart', rp.Name === 'on-failure' && rp.MaximumRetryCount ? `on-failure:${rp.MaximumRetryCount}` : rp.Name);
  for (const e of cf.Env || []) a.push('-e', e);
  if (cf.User) a.push('--user', cf.User);
  if (cf.WorkingDir) a.push('--workdir', cf.WorkingDir);
  if (hc.Memory > 0) a.push('--memory', String(hc.Memory));
  const seen = new Set<string>();
  for (const [cp, binds] of Object.entries(hc.PortBindings || {})) for (const b of (binds as any[]) || []) {
    const ip = b.HostIp && b.HostIp !== '0.0.0.0' && b.HostIp !== '::' ? b.HostIp + ':' : '';
    const spec = `${ip}${o.portMap?.[b.HostPort] ?? b.HostPort}:${cp}`; if (!seen.has(spec)) { seen.add(spec); a.push('-p', spec); }   // IPv4 + IPv6 bindings collapse to one
  }
  const mounts: { dest: string; vol: string }[] = [];
  (i.Mounts || []).forEach((m: any, idx: number) => {
    if (m.Type !== 'volume' && m.Type !== 'bind') return;
    if (/docker\.sock|docker_engine/i.test(m.Source || '')) throw new Error('containers that mount the Docker socket cannot be moved to another PC');
    if (!/^\/[\w./ +@-]*$/.test(m.Destination)) throw new Error('unsupported mount path: ' + m.Destination);
    const vol = `pcb-${name}-${idx}`; mounts.push({ dest: m.Destination, vol }); a.push('-v', `${vol}:${m.Destination}${m.RW === false ? ':ro' : ''}`);
  });
  const ep: string[] = cf.Entrypoint || []; if (ep.length) a.push('--entrypoint', ep[0]);
  return { args: [...a, cf.Image, ...ep.slice(1), ...(cf.Cmd || [])], mounts };
}

/** Stream a tar between two docker engines (`docker cp x -` | `docker cp - y`); aborts, killing both sides, if it exceeds maxBytes. */
export function copyBetween(src: { cmd: string; args: string[] }, dst: { cmd: string; args: string[] }, maxBytes: number, label: string): Promise<number> {
  return new Promise((resolve, reject) => {
    log('cmd', `$ ${label}`);
    const a = spawn(src.cmd, src.args, { windowsHide: true }), b = spawn(dst.cmd, dst.args, { windowsHide: true });
    let bytes = 0, ea = '', eb = '', ca: number | null = null, cb: number | null = null, done = false, over = false;
    const fin = (err?: Error) => { if (done) return; done = true; clearTimeout(t); err ? reject(err) : resolve(bytes); };
    const t = setTimeout(() => { killTree(a.pid); killTree(b.pid); fin(new Error(`copy of ${label} timed out`)); }, 1800000);
    a.stdout.on('data', (d) => { bytes += d.length; if (bytes > maxBytes && !over) { over = true; killTree(a.pid); killTree(b.pid); a.stdout.destroy(); b.stdin.destroy(); } });
    a.stdout.pipe(b.stdin); b.stdin.on('error', () => { /* receiver gone: reported via exit code */ });
    a.stderr.on('data', (d) => (ea += clean(d))); b.stderr.on('data', (d) => (eb += clean(d)));
    b.on('exit', (code) => { b.stdin.destroy(); if (code !== 0 && ca === null) { killTree(a.pid); a.stdout.destroy(); } });
    const chk = () => {
      if (ca === null || cb === null) return;
      over ? fin(new Error(`the data is larger than the ${Math.round(maxBytes / 1048576)} MB safety limit; copy it by hand or raise the limit`))
        : cb !== 0 ? fin(new Error('copying into the remote failed: ' + (eb.trim().split('\n').pop() || 'exit ' + cb)))
        : ca !== 0 ? fin(new Error('reading from the source failed: ' + (ea.trim().split('\n').pop() || 'exit ' + ca))) : fin();
    };
    a.on('close', (x) => { ca = x; chk(); }); b.on('close', (x) => { cb = x; chk(); });
    a.on('error', (e) => fin(e)); b.on('error', (e) => fin(e));
  });
}

/** Recreate a local standalone container on the remote (image + config + volume/bind data, capped at maxMB). No-op if the remote already has one of that name. */
export async function cloneContainerToRemote(c: Config, r: Remote, name: string, opt: { maxMB?: number; remoteName?: string; portMap?: Record<string, number>; source?: (args: string[]) => { cmd: string; args: string[] } } = {}): Promise<string> {
  const src = opt.source || dkSpec, ctx = await localCtx(c), twin = opt.remoteName || name;
  const sres = src(['--context', ctx, 'inspect', name]); const ins = await run(sres.cmd, sres.args, { timeout: 30000 });
  if (ins.code !== 0) throw new Error(`cannot inspect "${name}": ${ins.stderr.split('\n')[0]}`);
  const info = JSON.parse(ins.stdout)[0];
  if ((await ssh(r, `wsl.exe -e docker inspect ${twin} --format ok`, { timeout: 20000 })).code === 0) return `the remote already has "${twin}" - using it as is`;
  const { args, mounts } = createArgsFromInspect(info, { name: twin, portMap: opt.portMap });
  const img = await ensureImageOnRemote(c, r, info.Config.Image); if (img) log('info', 'image: ' + img);
  const cr = await wslSh(r, `docker create ${args.map(shq).join(' ')}`, { timeout: 120000 });
  if (cr.code !== 0) throw new Error('docker create on the remote failed: ' + (cr.stderr || cr.stdout).trim().split('\n').pop());
  try {
    let total = 0; const cap = (opt.maxMB ?? 1500) * 1048576;
    for (const m of mounts) {
      if (m.dest === '/') continue;
      const s = src(['--context', ctx, 'cp', `${name}:${m.dest}`, '-']);
      total += await copyBetween(s, { cmd: 'ssh', args: [...sshArgs(r), `wsl.exe -e docker cp - ${twin}:${path.posix.dirname(m.dest)}`] }, cap - total, `copy ${m.dest} of ${name} to the remote`);
    }
    return `created "${twin}" on the remote${mounts.length ? ` and copied ${(total / 1048576).toFixed(1)} MB of data` : ''}`;
  } catch (e) {
    await wslSh(r, `docker rm -f ${shq(twin)} >/dev/null 2>&1; ${mounts.map((m) => `docker volume rm ${shq(m.vol)} >/dev/null 2>&1`).join('; ')}`, { timeout: 60000 });
    throw e;
  }
}

// ---------- every listening port on THIS PC, with owner, purpose and resource use (read-only) ----------
export interface PortRow {
  port: number; pid: number; process: string; cmd: string; exposed: boolean; addrs: string[];
  cpu: number; ramMB: number; ioKBs: number; startedAt?: string;
  kind: 'docker' | 'forward' | 'bridge' | 'process'; purpose: string; container?: string; remoteTarget?: string;
  containerCpu?: string; containerMem?: string;
  move: { ok: boolean; action?: 'offload'; state?: 'remote'; reason?: string };
}
const PORTS_PS = `$ErrorActionPreference='SilentlyContinue'
$perf=@{}; Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | % { $perf[[int]$_.IDProcess]=$_ }
$proc=@{}; Get-CimInstance Win32_Process | % { $proc[[int]$_.ProcessId]=$_ }
$o=@(Get-NetTCPConnection -State Listen | % { $p=$proc[[int]$_.OwningProcess]; $f=$perf[[int]$_.OwningProcess]
 [pscustomobject]@{addr=[string]$_.LocalAddress;port=[int]$_.LocalPort;pid=[int]$_.OwningProcess;name=[string]$p.Name;cmd=[string]$p.CommandLine;ramMB=[math]::Round([double]$f.WorkingSetPrivate/1MB,1);cpu=[double]$f.PercentProcessorTime;ioKBs=[math]::Round(([double]$f.IOReadBytesPersec+[double]$f.IOWriteBytesPersec)/1KB,1);started=$(if($p.CreationDate){$p.CreationDate.ToString('o')})} })
ConvertTo-Json -InputObject $o -Compress -Depth 3`;

/** Purpose guess from the process command line (uvicorn module, node script, python script...). */
export function guessPurpose(name: string, cmd: string): string {
  const uv = cmd.match(/uvicorn\s+([\w.]+:\w+)/); if (uv) return `Python API (uvicorn ${uv[1]})`;
  const script = (cmd.match(/(?:node|python[\w.]*|pythonw)(?:\.exe)?"?\s+(?:-[\w-]+\s+)*"?([^\s"]+\.(?:js|mjs|cjs|py|ts))/i) || [])[1];
  if (/camofox|camoufox/i.test(cmd)) return 'Camofox browser service' + (script ? ` (${script.split(/[\/]/).pop()})` : '');
  if (script) return `${/py/i.test(name) ? 'Python' : 'Node'} script ${script.split(/[\/]/).pop()}`;
  if (/svchost|System$|lsass|services|wininit|spoolsv/i.test(name)) return 'Windows system service';
  return cmd ? cmd.replace(/^"[^"]*"\s*/, '').slice(0, 90) || name : name;
}

/** Which process listens on this TCP port on THIS PC: one fast `netstat` call (the full port table above takes 40 s on a busy PC and fails the app plan / move). */
export async function pidOnPort(port: number): Promise<number | null> {
  const r = await run('netstat', ['-ano', '-p', 'tcp'], { timeout: 20000, poll: true });
  if (r.code !== 0) throw new Error('could not read the port table: ' + (r.stderr.trim().split('\n')[0] || 'netstat failed or timed out'));
  for (const ln of r.stdout.split('\n')) { const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(ln); if (m && Number(m[1]) === port) return Number(m[2]) || null; }
  return null;
}

export async function listLocalPorts(c: Config, selfPid: number, uiPort: number): Promise<PortRow[]> {
  const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PORTS_PS, 'utf16le').toString('base64')], { timeout: 45000, poll: true });   // a busy PC can take longer than 20 s
  if (r.code !== 0) throw new Error('could not read the port table: ' + (r.stderr.trim().split('\n')[0] || 'timed out'));
  const raw: any[] = JSON.parse(r.stdout.trim() || '[]'); const list = Array.isArray(raw) ? raw : [raw];
  // Docker: published ports -> container (+ live usage), only if the engine answers quickly
  const byPort = new Map<number, { name: string; cpu?: string; mem?: string }>();
  const ps = await dk(['ps', '--format', '{{.Names}}|{{.Ports}}'], { timeout: 6000, poll: true });
  if (ps.code === 0) {
    const stats = new Map<string, { cpu: string; mem: string }>();
    const st = await dk(['stats', '--no-stream', '--format', '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}'], { timeout: 10000, poll: true });
    if (st.code === 0) for (const l of st.stdout.split('\n')) { const [n, cpu, mem] = l.trim().split('|'); if (n) stats.set(n, { cpu, mem: (mem || '').split('/')[0].trim() }); }
    for (const l of ps.stdout.split('\n')) {
      const [n, ports] = l.trim().split('|'); if (!n) continue;
      for (const m of (ports || '').matchAll(/(?:[\d.:[\]]+:)?(\d+)->/g)) byPort.set(Number(m[1]), { name: n, ...stats.get(n) });
    }
  }
  const rows = new Map<number, PortRow>();
  for (const x of list) {
    const row: PortRow = rows.get(x.port) ?? { port: x.port, pid: x.pid, process: x.name || '?', cmd: x.cmd || '', exposed: false, addrs: [], cpu: 0, ramMB: 0, ioKBs: 0, startedAt: x.started,
      kind: 'process', purpose: '', move: { ok: false } };
    if (!rows.has(x.port)) rows.set(x.port, row);
    if (!row.addrs.includes(x.addr)) row.addrs.push(x.addr);
    if (!/^(127\.|::1$)/.test(x.addr)) row.exposed = true;
    row.cpu = Math.max(row.cpu, x.cpu || 0); row.ramMB = Math.max(row.ramMB, x.ramMB || 0); row.ioKBs = Math.max(row.ioKBs, x.ioKBs || 0);
  }
  for (const row of rows.values()) {
    const d = byPort.get(row.port); const fw = row.cmd.match(/-L\s+(?:127\.0\.0\.1:)?\d+:([\w.-]+:\d+)/);
    const moved = c.projects.find((p) => isAway(p) && (p.ports || []).includes(row.port));
    if (row.pid === selfPid || row.port === uiPort) { row.kind = 'bridge'; row.purpose = row.port === uiPort ? 'PC Bridge window (this app)' : 'PC Bridge load balancer (split between PCs)'; row.move.reason = 'This is PC Bridge itself.'; }
    else if (/^ssh(\.exe)?$/i.test(row.process) && fw) { row.kind = 'forward'; row.remoteTarget = fw[1]; row.purpose = `PC Bridge forward -> remote ${fw[1]}`; row.move = { ok: true, state: 'remote', reason: 'Already answered by the remote PC.' }; }
    else if (d) {
      row.kind = 'docker'; row.container = d.name; row.containerCpu = d.cpu; row.containerMem = d.mem; row.purpose = `Docker container "${d.name}"`;
      row.move = moved ? { ok: true, state: 'remote' } : { ok: true, action: 'offload' };
    } else {
      row.purpose = guessPurpose(row.process, row.cmd);
      row.move = { ok: false, reason: 'A plain Windows program (not in Docker), so it cannot run on the other PC as is. Put it in a container and it becomes movable; or run it on the other PC and forward to it.' };
    }
  }
  return [...rows.values()].sort((a, b) => a.port - b.port);
}
