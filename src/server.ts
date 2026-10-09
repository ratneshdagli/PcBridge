// PC Bridge service: a tiny Node process (no Electron). Serves the UI + a JSON API on 127.0.0.1 only; the UI is shown in an Edge/Chrome
// --app window (reuses the browser that is already running) and a small PowerShell tray icon. Nothing listens on a public interface.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import * as core from './core';
import * as setup from './setup';
import * as programs from './programs';
import * as apps from './apps';
import { PublicApi, newToken, defaultApi } from './publicapi';

const dataDir = process.env.PCB_USERDATA || path.join(process.env.APPDATA || os.homedir(), 'pc-bridge');
const cfgFile = path.join(dataDir, 'config.json'), svcFile = path.join(dataDir, 'service.json'), trayFile = path.join(dataDir, 'tray.txt');
const uiDir = process.env.PCB_UI || path.join(__dirname, '..', '..', 'renderer');
const token = crypto.randomBytes(24).toString('hex');
fs.mkdirSync(dataDir, { recursive: true });

// ---- single instance: a second launch just opens another window on the running service ----
async function existing(): Promise<{ port: number; token: string } | null> {
  try {
    const s = JSON.parse(fs.readFileSync(svcFile, 'utf8'));
    const r = await fetch(`http://127.0.0.1:${s.port}/ping`, { signal: AbortSignal.timeout(1500) });
    return r.ok && (await r.text()) === 'pc-bridge' ? s : null;
  } catch { return null; }
}

// ---- UI window: Edge/Chrome in --app mode (chromeless). Prefer the browser already running so no new browser process is started. ----
function openUi(port: number, tok: string) {
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean) as string[];
  const cand = ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe'].flatMap((b) => pf.map((p) => path.join(p, b))).filter((f) => fs.existsSync(f));
  const tl = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }).stdout || '';
  const running = cand.find((f) => tl.toLowerCase().includes(path.basename(f).toLowerCase())) || cand[0];
  const url = `http://127.0.0.1:${port}/?t=${tok}`;
  if (!running) { spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref(); return; }
  spawn(running, [`--app=${url}`, '--window-size=1120,800'], { detached: true, stdio: 'ignore' }).unref();
}

if (!process.env.PCB_FORCE_NEW) {
  existing().then((s) => { if (s) { if (!process.argv.includes('--hidden')) openUi(s.port, s.token); process.exit(0); } main(); });
} else main();

function main() {
  let config: core.Config; let last: core.Status | null = null, wake: (() => void) | null = null, quitting = false, updating = false;
  const fwd = new core.Forwarder(); let off: core.Offloader;
  const remote = () => config.remotes[config.activeRemote];
  const clients = new Set<http.ServerResponse>();
  const send = (ev: string, d: unknown) => { const m = `event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`; for (const c of clients) c.write(m); };
  const l = core.loadConfig(cfgFile); config = l.config; if (l.warning) core.log('err', l.warning);
  off = new core.Offloader(() => config, () => { core.saveConfig(cfgFile, config); send('projects', config.projects); }, fwd);
  core.onLog((e) => send('log', e));
  setInterval(() => { if (clients.size) send('fwd', fwd.list()); }, 1000);

  // ---- tray (opt-in with --tray, PowerShell NotifyIcon; a compiled helper exe gets quarantined by Defender). Colour/tooltip go through tray.txt; menu clicks come back on stdout. ----
  let tray: ChildProcess | null = null;
  const paintTray = (s: core.Status | null) => {
    const ok = s?.ssh.ok; const txt = !s ? 'grey|PC Bridge: checking…' : ok ? `green|PC Bridge: ${remote().name} online (${s.ssh.latencyMs} ms)` : `red|PC Bridge: ${remote().name} OFFLINE`;
    try { fs.writeFileSync(trayFile, txt); } catch { /* tray is cosmetic */ }
  };
  function startTray() {
    if (!process.argv.includes('--tray') && !process.env.PCB_TRAY) return;   // opt-in: the PowerShell tray costs ~70 MB, more than the whole service
    const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$f='${trayFile.replace(/'/g, "''")}'
$n=New-Object Windows.Forms.NotifyIcon; $n.Visible=$true
$cache=@{}
function Dot($c){ if(-not $cache[$c]){ $b=New-Object Drawing.Bitmap 16,16; $g=[Drawing.Graphics]::FromImage($b); $g.SmoothingMode='AntiAlias'
 $col=@{green='#22c55e';red='#ef4444';grey='#94a3b8'}[$c]; $g.FillEllipse((New-Object Drawing.SolidBrush ([Drawing.ColorTranslator]::FromHtml($col))),1,1,14,14); $cache[$c]=[Drawing.Icon]::FromHandle($b.GetHicon()) }; $cache[$c] }
$m=New-Object Windows.Forms.ContextMenuStrip
$m.Items.Add('Open PC Bridge').add_Click({[Console]::Out.WriteLine('open')}) | Out-Null
$m.Items.Add('Open remote shell').add_Click({[Console]::Out.WriteLine('shell')}) | Out-Null
$m.Items.Add('Quit (things on the other PC come back after 10 min)').add_Click({[Console]::Out.WriteLine('quit')}) | Out-Null
$n.ContextMenuStrip=$m; $n.add_MouseClick({ if($_.Button -eq 'Left'){[Console]::Out.WriteLine('open')} })
$t=New-Object Windows.Forms.Timer; $t.Interval=2000
$t.add_Tick({ if(-not (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue)){ $n.Visible=$false; [Windows.Forms.Application]::Exit() }; try{ $p=(Get-Content $f -Raw).Split('|'); $n.Icon=Dot $p[0]; $n.Text=$p[1].Substring(0,[Math]::Min(60,$p[1].Length)) }catch{} })
$t.Start(); $n.Icon=Dot 'grey'; [Windows.Forms.Application]::Run()`;
    tray = spawn('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = ''; tray.stdout!.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const c = buf.slice(0, i).trim(); buf = buf.slice(i + 1); onTray(c); } });
    tray.on('exit', () => { tray = null; });
  }
  function onTray(c: string) {
    if (c === 'open') openUi(port, token);
    else if (c === 'shell') core.openShell(remote()).catch((e) => core.log('err', e.message));
    else if (c === 'quit') softQuit();
  }

  // ---- status poller: one batched ssh call per cycle, never overlapping, hard timeouts inside core ----
  let cycle = 0, autoDone = false;
  async function tick() {
    let s: core.Status;
    const ports = config.projects.filter(core.isAway).flatMap((p) => p.ports || []);
    try { s = await core.getStatus(remote(), cycle++ % 3 === 0, ports); }
    catch (e: any) { s = { ts: Date.now(), tailscale: { state: 'unknown', detail: '' }, context: '?', contextIsRemote: false,
      ssh: { ok: false, latencyMs: null, error: 'internal error: ' + e.message, ...core.diagnoseSsh('', { state: 'unknown', detail: '' }) } }; }
    s.local = await core.localMetrics().catch(() => undefined);
    if (!autoDone && s.ssh.ok) {
      autoDone = true;
      for (const f of config.forwards.filter((x) => x.autoStart)) fwd.start(remote(), f).catch((e) => core.log('err', `auto-start forward ${f.localPort}: ${e.message}`));
    }
    if (last && last.ssh.ok !== s.ssh.ok) core.log('info', s.ssh.ok ? 'Remote came ONLINE' : 'Remote went OFFLINE: ' + (s.ssh.headline ?? s.ssh.error));
    last = s; send('status', s); paintTray(s);
    keepOthersAwake(); probeOthers().catch(() => 0);
    if (config.apps?.length || config.programs?.some((p) => p.needs?.length) || apps.hasLinks()) try { apps.syncLinks(config, adeps(), fwd); } catch (e: any) { core.log('err', 'app links: ' + e.message); }
    off.onStatus(s).catch((e) => core.log('err', 'offload monitor: ' + e.message));
    if (config.autoUpdate && s.ssh.ok && !updating && (config.programs || []).some((p) => p.mode === 'remote') && Date.now() - (config.programsUpdatedAt || 0) > 7 * 86400000) { updating = true; core.log('info', 'Weekly update of the remote tools and libraries'); (H['programs:update'](true) as Promise<unknown>).catch((e) => core.log('err', 'auto update: ' + e.message)).finally(() => { updating = false; config.programsUpdatedAt = Date.now(); core.saveConfig(cfgFile, config); }); }
    if (config.programs?.length) programs.watchPrograms(config, (r) => (r === remote() ? s.ssh.ok : off.healthOf(r.name)), pdeps()).catch((e) => core.log('err', 'program monitor: ' + e.message));
    await new Promise<void>((res) => { const t = setTimeout(res, 3000); wake = () => { clearTimeout(t); res(); }; });
    wake = null; if (!quitting) setImmediate(tick);
  }

  // a PC that runs moved containers needs its WSL kept awake too (id -1, -2, ... in the Forwarder)
  const keepOthersAwake = () => { if (!config.keepAwake) return; config.remotes.forEach((r, i) => { if (i !== config.activeRemote && config.projects.some((p) => core.isAway(p) && p.remote === r.name)) fwd.startKeepAwake(r, -(i + 1)); }); };
  // PCs other than the active one: a light ssh probe every ~9 s so sites/programs living there get failover and recovery too
  let probeN = 0, probing = false;
  async function probeOthers() {
    if (probing || probeN++ % 3 !== 0) return; probing = true;
    try { const used = new Set([...config.projects, ...(config.programs || [])].filter((p) => p.remote && p.remote !== remote().name).map((p) => p.remote!));
      await Promise.all(config.remotes.filter((r) => used.has(r.name)).map(async (r) => { const x = await core.ssh(r, 'echo ok', { timeout: 8000, poll: true }); off.setHealth(r.name, x.code === 0, x.code === 0 ? '' : 'ssh to ' + r.name + ' failed'); })); } finally { probing = false; }
  }
  // ---- API: every handler returns {ok,data}|{ok:false,error}; nothing throws into the UI ----
  const H: Record<string, (...a: any[]) => Promise<unknown> | unknown> = {};
  const proj = (name: string) => { const p = config.projects.find((x) => x.name === name); if (!p) throw new Error(`Unknown project "${name}"`); return p; };
  const composeProj = (name: string) => { const p = proj(name); if (p.container) throw new Error(`"${name}" is a single-container project: use Offload / Bring back (there are no files to sync).`); return p; };
  const persist = () => { const errs = core.validateConfig(config); if (errs.length) throw new Error(errs.join('\n')); core.saveConfig(cfgFile, config); };
  const refresh = () => wake?.();
  const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  const launcher = process.env.PCB_LAUNCHER || path.join(__dirname, '..', '..', 'PC-Bridge.vbs');
  const psPick = (title: string) => new Promise<string>((res) => {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $d=New-Object Windows.Forms.FolderBrowserDialog; $d.Description='${title}'; if($d.ShowDialog() -eq 'OK'){$d.SelectedPath}`;
    const c = spawn('powershell', ['-STA', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { windowsHide: true }); let o = '';
    c.stdout.on('data', (d) => (o += d)); c.on('exit', () => res(o.trim()));
  });

  H['config:get'] = () => ({ config, file: cfgFile, fwd: fwd.list(), status: last, openAtLogin: spawnSync('reg', ['query', RUN_KEY, '/v', 'PCBridge'], { windowsHide: true }).status === 0 });
  H['config:save'] = (c: core.Config) => {
    const prevRemote = JSON.stringify(remote()); const next: core.Config = { ...config, ...c };
    const errs = core.validateConfig(next); if (errs.length) throw new Error(errs.join('\n'));
    for (const [i, r] of next.remotes.entries()) { const old = config.remotes[i]; if (old && old.name !== r.name) for (const p of [...next.projects, ...(next.programs || [])]) if (p.remote === old.name) p.remote = r.name; }   // renamed PC: moved items follow it
    config = next; core.saveConfig(cfgFile, config);
    if (JSON.stringify(remote()) !== prevRemote) { fwd.stopAll(); if (config.keepAwake) setTimeout(() => fwd.startKeepAwake(remote()), 600); core.log('info', 'Remote settings changed: forwards stopped, keep-awake restarted'); }
    refresh(); return config;
  };
  H['config:reveal'] = () => { spawn('explorer', ['/select,' + cfgFile], { windowsHide: true, stdio: 'ignore' }).unref(); };
  H['login:set'] = (on: boolean) => {      // opt-in: per-user "start with Windows" (HKCU Run), removed again when switched off
    const r = on ? spawnSync('reg', ['add', RUN_KEY, '/v', 'PCBridge', '/t', 'REG_SZ', '/d', `wscript.exe "${launcher}" --hidden`, '/f'], { windowsHide: true })
      : spawnSync('reg', ['delete', RUN_KEY, '/v', 'PCBridge', '/f'], { windowsHide: true });
    if (r.status !== 0 && on) throw new Error('could not write the startup entry'); return on;
  };
  H['status:refresh'] = () => { refresh(); };
  H['ctx:remote'] = async () => { await core.useRemoteDocker(config); persist(); refresh(); };
  H['ctx:local'] = async () => { await core.useLocalDocker(config); refresh(); };
  H['proj:add'] = async () => {
    const dir = await psPick('Pick a project folder containing docker-compose.yml'); if (!dir) return null;
    if (!core.findCompose(dir)) throw new Error('That folder has no docker-compose.yml / compose.yaml');
    let name = path.basename(dir), i = 2; while (config.projects.some((p) => p.name === name)) name = `${path.basename(dir)}-${i++}`;
    config.projects.push({ name, path: dir }); persist(); return name;
  };
  H['proj:remove'] = (name: string) => {
    if (proj(name).mode === 'remote') throw new Error('This project is currently served from the remote. Bring it back to this PC first.');
    config.projects = config.projects.filter((p) => p.name !== name); persist();
  };
  H['proj:set'] = (name: string, v: { ports: number[]; failover: boolean; autoFailback: boolean; autoOffload?: boolean }) => {
    const p = proj(name); const old = { ports: p.ports, failover: p.failover, autoFailback: p.autoFailback, autoOffload: p.autoOffload };
    if (p.mode === 'remote' && JSON.stringify(v.ports) !== JSON.stringify(p.ports)) throw new Error('Bring the project back to this PC before changing its ports.');
    Object.assign(p, { ports: v.ports, failover: v.failover, autoFailback: v.autoFailback }); if (v.autoOffload !== undefined) p.autoOffload = v.autoOffload;
    try { persist(); } catch (e) { Object.assign(p, old); throw e; }
  };
  H['proj:offload'] = async (name: string) => { await off.offload(name); refresh(); };
  H['proj:home'] = async (name: string) => { await off.bringHome(name, 'manual'); refresh(); };
  H['proj:sync'] = (name: string) => core.syncProject(remote(), composeProj(name), config.syncExcludes);
  H['proj:run'] = async (name: string) => {
    const p = composeProj(name);
    await core.syncProject(remote(), p, config.syncExcludes);
    if (config.keepAwake) fwd.startKeepAwake(remote());
    const r = await core.composeAction(remote(), p, 'up'); refresh();
    if (r.code !== 0) throw new Error(`docker compose up failed (exit ${r.code}):\n${(r.stdout + r.stderr).split('\n').slice(-15).join('\n')}`);
    return r.stdout.split('\n').slice(-15).join('\n');
  };
  H['proj:action'] = async (name: string, action: core.ComposeAction) => {
    const r = await core.composeAction(remote(), composeProj(name), action); refresh();
    if (r.code !== 0 && action !== 'logs') throw new Error(`exit ${r.code}: ${(r.stdout + r.stderr).trim().split('\n').slice(-10).join('\n')}`);
    return (r.stdout + r.stderr).trim();
  };
  H['containers:list'] = () => core.listLocalContainers(config).then((list) => list.map((c) => { const p = config.projects.find((q) => q.container === c.name || (c.composeDir && q.path === c.composeDir)); const pc = core.remoteFor(config, p?.remote); const own = pc.name === remote().name; const rc = own ? last?.docker?.containers.find((x) => x.name === c.name.toLowerCase()) : undefined; const twin = own ? !!rc : !!p && core.isAway(p), remoteRunning = own ? rc?.state === 'running' : !!p && core.isAway(p) && off.healthOf(pc.name) === true; return { ...c, offloaded: !!p && core.isAway(p), project: p?.name ?? null, pc: pc.name, mode: p?.mode ?? 'local', share: p?.share ?? (p?.mode === 'remote' ? 100 : 0), twin, remoteRunning }; }));
  H['ports:list'] = async () => ({ local: await core.listLocalPorts(config, process.pid, port), remote: last?.docker?.containers ?? [], remoteOnline: !!last?.ssh.ok });
  // ---- public local API for other programs (toggle in the UI; off by default) ----
  const pub = new PublicApi({ cfg: () => config, save: () => core.saveConfig(cfgFile, config), H, status: () => last, version: String(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version), balStats: () => (H['bal:stats'] as () => unknown)() });
  const apiCfg = () => (config.api ??= defaultApi());
  H['api:get'] = () => ({ ...apiCfg(), base: `http://127.0.0.1:${apiCfg().port}/api/v1`, docs: `http://127.0.0.1:${apiCfg().port}/api/v1/docs`, usage: pub.usage() });
  H['api:set'] = async (v: { enabled?: boolean; control?: boolean; port?: number }) => {
    const a = apiCfg(); const old = { ...a };
    if (v.port !== undefined) a.port = Number(v.port); if (v.control !== undefined) a.control = !!v.control; if (v.enabled !== undefined) a.enabled = !!v.enabled;
    if (a.enabled && !a.token) a.token = newToken();
    try { persist(); await pub.apply(); } catch (e) { Object.assign(a, old); persist(); await pub.apply().catch(() => 0); throw e; }
    return H['api:get']();
  };
  H['api:guide'] = (withToken?: boolean) => pub.guide(apiCfg().port, withToken ? apiCfg().token : '<TOKEN>');
  H['api:token'] = async () => { apiCfg().token = newToken(); persist(); return H['api:get'](); };
  H['api:test'] = async () => {       // calls every read endpoint of the running API with the real token, the way another program would
    const a = apiCfg(); if (!a.enabled || !pub.running) throw new Error('The API is switched off');
    const out: setup.TestResult[] = []; const base = `http://127.0.0.1:${a.port}/api/v1`;
    const one = async (name: string, url: string, init: RequestInit, want: number, check?: (j: any) => boolean) => { const t0 = Date.now(); try { const r = await fetch(url, { ...init, signal: AbortSignal.timeout(60000) }); const j = await r.json().catch(() => null); out.push({ name, ok: r.status === want && (!check || check(j)), detail: `HTTP ${r.status}`, ms: Date.now() - t0 }); } catch (e: any) { out.push({ name, ok: false, detail: e.message, ms: Date.now() - t0 }); } };
    const auth = { headers: { Authorization: 'Bearer ' + a.token, 'X-Client-Name': 'pc-bridge-selftest' } };
    await one('GET /health (no token)', base + '/health', {}, 200, (j) => j?.ok === true);
    await one('GET /status without token is refused', base + '/status', {}, 401);
    await one('GET /status with a wrong token is refused', base + '/status', { headers: { Authorization: 'Bearer pcb_wrong' } }, 401);
    for (const r of pub.routes.filter((x) => x.scope === 'read' && !x.path.includes(':') && !['/test/all', '/peers', '/containers', '/overview'].includes(x.path))) await one('GET ' + r.path, base + r.path, auth, 200);
    if (!a.control) await one('POST /refresh is refused while control is off', base + '/refresh', { method: 'POST', ...auth }, 403);
    return out;
  };
  // ---- connect another PC / switch PCs ----
  /** Pin every moved site/program to the PC it lives on, so changing the "active" PC never re-points them. */
  const pinAway = () => { for (const p of [...config.projects.filter(core.isAway), ...(config.programs || []).filter((q) => q.mode === 'remote')]) if (!p.remote) p.remote = remote().name; };
  const switchActive = (i: number) => {
    if (i === config.activeRemote) return;
    pinAway();
    config.activeRemote = i; for (const f of config.forwards) fwd.stop(f.localPort); fwd.stop(0);   // user forwards + keep-awake belong to the active PC; sites keep their own tunnels
    if (config.keepAwake) setTimeout(() => fwd.startKeepAwake(remote()), 600); core.log('info', 'Active PC is now ' + remote().name);
  };
  H['setup:discover'] = () => setup.discoverPeers();
  H['setup:check'] = (c: setup.Candidate) => setup.checkRemote(c);
  H['setup:installShim'] = (c: setup.Candidate, confirm: boolean) => setup.installShim(c, confirm);
  H['setup:apply'] = (c: setup.Candidate, makeActive: boolean) => {
    const next: core.Config = JSON.parse(JSON.stringify(config)); const before = config.activeRemote; const i = setup.applyRemote(next, c, false);
    const errs = core.validateConfig(next); if (errs.length) throw new Error(errs.join('\n'));
    config.remotes = next.remotes; if (makeActive) switchActive(i); else config.activeRemote = before;
    persist(); refresh(); return { index: i, active: config.activeRemote === i };
  };
  H['remote:use'] = (i: number) => { if (!Number.isInteger(i) || !config.remotes[i]) throw new Error('No such PC'); switchActive(i); persist(); refresh(); return remote().name; };
  // ---- Test buttons ----
  const tctx = (): setup.TestCtx => ({ config, fwd, off, status: last, selfPid: process.pid, uiPort: port });
  H['test:all'] = () => setup.testAll(tctx());
  H['test:connection'] = () => setup.testConnection(tctx());
  H['test:project'] = (name: string) => setup.testProject(tctx(), name);
  H['test:balance'] = (name: string, n?: number) => setup.testBalance(tctx(), name, n);
  H['test:port'] = (p: number) => setup.testPort(p);
  // ---- plain programs (Node / Python / anything): copy to the remote's E: drive, run supervised, forward the port ----
  const pdeps = (): programs.ProgramDeps => ({ fwd, save: () => core.saveConfig(cfgFile, config), localPidOnPort: (n) => core.pidOnPort(n) });
  const rp = (p: { remote?: string }) => core.remoteFor(config, p.remote);
  const prog = (name: string) => { const p = (config.programs || []).find((x) => x.name === name); if (!p) throw new Error(`Unknown program "${name}"`); return p; };
  H['programs:list'] = async () => { const list = config.programs || []; return Promise.all(list.map(async (p) => ({ ...p, pc: rp(p).name, live: p.mode === 'remote' ? await programs.remoteState(config, rp(p), p).catch(() => null) : null, holder: p.mode === 'remote' ? null : await core.pidOnPort(p.port).catch(() => null) }))); };
  H['programs:add'] = (p: programs.Program) => {
    const entry: programs.Program = { name: String(p.name), dir: String(p.dir), cmd: String(p.cmd), port: Number(p.port), mode: 'local', env: p.env, ...(p.runtime ? { runtime: p.runtime } : {}), ...(p.failover !== undefined ? { failover: !!p.failover } : {}), ...(p.needs?.length ? { needs: p.needs.map(Number) } : {}), ...(p.omitDev ? { omitDev: true } : {}), ...(p.ignoreScripts ? { ignoreScripts: true } : {}), ...(p.python ? { python: String(p.python) } : {}), ...(p.requirements ? { requirements: String(p.requirements) } : {}), ...(p.pullExcludes?.length ? { pullExcludes: p.pullExcludes.map(String) } : {}), ...(p.requireFast ? { requireFast: true } : {}) };
    const old = config.programs || []; const i = old.findIndex((x) => x.name === entry.name);
    if (i >= 0 && old[i].mode === 'remote') throw new Error(`"${entry.name}" is running on another PC; bring it home first, then register it again`);
    config.programs = i >= 0 ? old.map((x, j) => (j === i ? entry : x)) : [...old, entry];   // registering an existing name updates it in place
    try { persist(); } catch (e) { config.programs = old; throw e; } return true;
  };
  H['programs:remove'] = (name: string) => { const p = prog(name); const inApp = (config.apps || []).find((x) => x.members.some((m) => m.kind === 'program' && m.name === name)); if (inApp) throw new Error(`It is part of the app "${inApp.name}": take it out of the app first`); if (p.mode === 'remote') throw new Error('Bring it back to this PC first'); config.programs = (config.programs || []).filter((x) => x !== p); persist(); return true; };
  H['programs:prepare'] = (target?: string) => programs.prepareRemote(config, core.remoteFor(config, target));
  H['programs:move'] = async (name: string, stopLocalPid?: number, target?: string) => { const p = prog(name); const oldRemote = p.remote; if (target) { if (!config.remotes.some((x) => x.name === target)) throw new Error(`There is no PC named "${target}"`); p.remote = target; } try { const m = await programs.moveProgram(config, rp(p), name, pdeps(), stopLocalPid); refresh(); return m; } catch (e) { if (p.mode !== 'remote') p.remote = oldRemote; throw e; } };   // a failed move leaves the program exactly as it was
  H['programs:home'] = async (name: string) => { const m = await programs.bringProgramHome(config, rp(prog(name)), name, pdeps()); refresh(); return m; };
  H['programs:update'] = async (apply: boolean) => { const pcs = [...new Set([remote(), ...(config.programs || []).filter((p) => p.mode === 'remote').map(rp)])]; const rows: programs.UpdateRow[] = []; for (const r of pcs) for (const x of await programs.updateRemote(config, r, pdeps(), apply === true)) rows.push(pcs.length > 1 ? { ...x, name: `[${r.name}] ${x.name}` } : x); refresh(); return rows; };
  H['programs:autoupdate'] = (on: boolean) => { config.autoUpdate = on === true; persist(); return config.autoUpdate; };
  H['programs:logs'] = (name: string) => programs.remoteLog(config, rp(prog(name)), name);
  H['programs:push'] = (name: string, files?: string[], restart?: boolean) => programs.pushFiles(config, rp(prog(name)), name, pdeps(), Array.isArray(files) ? files : undefined, restart === true);
  H['test:program'] = (name: string) => programs.testProgram(config, rp(prog(name)), name);
  // ---- apps: groups of programs/containers moved as one ----
  const projOf = (m: apps.AppMember) => config.projects.find((x) => x.container === m.name || (m.project !== undefined && x.name === m.project));
  const pcUp = (name: string) => (name === remote().name ? last?.ssh.ok ?? null : off.healthOf(name) ?? null);
  const adeps = (): apps.AppDeps => ({
    where: (m) => { if (m.kind === 'program') { const p = (config.programs || []).find((x) => x.name === m.name); return p?.mode === 'remote' ? rp(p).name : apps.HERE; } const p = projOf(m); return p && core.isAway(p) ? core.remoteFor(config, p.remote).name : apps.HERE; },
    ports: (m) => (m.kind === 'program' ? [(config.programs || []).find((x) => x.name === m.name)?.port ?? 0].filter(Boolean) : projOf(m)?.ports ?? m.ports ?? []),
    holder: (m) => pdeps().localPidOnPort(prog(m.name).port),
    moveProgram: (n, pid, t) => H['programs:move'](n, pid, t) as Promise<string>, homeProgram: (n) => H['programs:home'](n) as Promise<string>,
    offloadContainer: async (m, t) => { const before = new Set(config.projects.map((x) => x.name)); const r = (await H['containers:offload'](m.name, 100, t)) as string; const p = projOf(m) ?? config.projects.find((x) => !before.has(x.name)); if (p) { m.project = p.name; m.ports = p.ports; } return r; },
    homeContainer: async (m) => { const p = projOf(m); if (p && core.isAway(p)) await H['proj:home'](p.name); },
    testPort: async (n) => { const t = await setup.testPort(n); return { ok: t.ok, detail: t.detail, ms: t.ms }; },
    save: () => core.saveConfig(cfgFile, config),
  });
  const app = (name: string) => { const a = (config.apps || []).find((x) => x.name === name); if (!a) throw new Error(`Unknown app "${name}"`); return a; };
  const afterApp = () => { try { apps.syncLinks(config, adeps(), fwd); } catch (e: any) { core.log('err', 'app links: ' + e.message); } refresh(); };
  H['apps:list'] = () => (config.apps || []).map((a) => { const st = apps.statusApp(config, adeps(), a); return { ...st, members: st.members.map((m) => ({ ...m, up: m.pc === 'this PC' ? null : pcUp(m.pc) })) }; });
  H['apps:save'] = async (a: apps.App, original?: string) => {
    if (!a || typeof a.name !== 'string' || !Array.isArray(a.members)) throw new Error('An app needs a name and members');
    const clean: apps.App = { name: a.name.trim(), members: a.members.map((m) => ({ kind: m.kind, name: String(m.name).trim(), ...(m.target ? { target: m.target } : {}), ...(m.project ? { project: m.project } : {}), ...(m.ports ? { ports: m.ports } : {}) })), ...(a.target ? { target: a.target } : {}), ...(a.note ? { note: String(a.note) } : {}) };
    if (!clean.name) throw new Error('Give the app a name');
    if (clean.members.some((m) => !m.name)) throw new Error('A part has no name: choose a program or container, or remove that row');
    if (clean.members.some((m) => m.kind === 'container' && !m.ports?.length)) { const list = await core.listLocalContainers(config).catch(() => []); for (const m of clean.members) if (m.kind === 'container' && !m.ports?.length) { const c = list.find((x) => x.name === m.name); if (c?.ports.length) m.ports = c.ports; } }
    const old = config.apps; const name0 = original ?? clean.name; const i = (config.apps || []).findIndex((x) => x.name === name0);
    if (original === undefined && i >= 0) throw new Error(`An app named "${clean.name}" already exists; pick another name or edit that one`);
    config.apps = i < 0 ? [...(config.apps || []), clean] : (config.apps || []).map((x, j) => (j === i ? clean : x));
    try { persist(); } catch (e) { config.apps = old; throw e; } afterApp(); return true;
  };
  H['apps:remove'] = (name: string) => { app(name); config.apps = (config.apps || []).filter((x) => x.name !== name); persist(); afterApp(); return true; };
  H['apps:plan'] = (name: string, target?: string) => apps.planApp(config, adeps(), name, target);
  H['apps:send'] = async (name: string, target?: string, stopLocal?: boolean) => { try { return await apps.sendApp(config, adeps(), name, { target, stopLocal: stopLocal === true }); } finally { afterApp(); } };
  H['apps:home'] = async (name: string) => { try { return await apps.homeApp(config, adeps(), name); } finally { afterApp(); } };
  H['apps:test'] = (name: string) => apps.testApp(config, adeps(), name);
  H['apps:export'] = (name: string, withEnv?: boolean) => apps.exportApp(config, name, withEnv === true);
  H['apps:import'] = (manifest: unknown, baseDir: string, rename?: string) => { const r = apps.importApp(config, manifest, baseDir, rename); try { persist(); } catch (e) { throw e; } afterApp(); return r; };
  H['containers:offload'] = async (name: string, share = 100, target?: string) => { const m = await off.adoptAndOffload(name, share, target); refresh(); return m; };
  H['proj:share'] = async (name: string, share: number) => { const m = await off.setShare(name, share); refresh(); return m; };
  H['bal:stats'] = () => Object.fromEntries(config.projects.filter((p) => p.mode === 'split').map((p) => [p.name, { share: p.share, port: p.ports![0], backends: off.bal.stats(p.ports![0]) }]));
  H['container'] = async (name: string, action: 'start' | 'stop' | 'restart' | 'logs') => {
    const r = await core.containerAction(remote(), action, name); refresh();
    if (r.code !== 0 && action !== 'logs') throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim());
    return (r.stdout + r.stderr).trim();
  };
  H['wake'] = async () => { const r = await core.wakeDocker(remote()); refresh(); if (r.code !== 0) throw new Error((r.stderr || r.stdout || 'wake failed').trim()); return r.stdout.trim(); };
  H['keepawake'] = (on: boolean) => { config.keepAwake = on; persist(); if (on) fwd.startKeepAwake(remote()); else fwd.stop(0); return fwd.list(); };
  H['fwd:add'] = (f: core.Forward) => { config.forwards.push({ ...f, autoStart: !!f.autoStart }); try { persist(); } catch (e) { config.forwards.pop(); throw e; } };
  H['fwd:remove'] = (localPort: number) => { fwd.stop(localPort); config.forwards = config.forwards.filter((f) => f.localPort !== localPort); persist(); };
  H['fwd:start'] = async (localPort: number) => { const f = config.forwards.find((x) => x.localPort === localPort); if (!f) throw new Error('Unknown forward'); await fwd.start(remote(), f); };
  H['fwd:stop'] = (localPort: number) => fwd.stop(localPort);
  H['fwd:test'] = async (localPort: number) => {
    const r = await core.testForward(localPort); if (!r.ok) throw new Error(`localhost:${localPort}: ${r.error}`);
    return `localhost:${localPort} answered HTTP ${r.status} in ${r.ms} ms${r.server ? ' (server: ' + r.server + ')' : ''}`;
  };
  H['shell:open'] = () => core.openShell(remote());
  H['logs:all'] = () => core.logs.slice(-1500);
  H['logs:clear'] = () => { core.logs.length = 0; };
  H['app:quit'] = () => { setTimeout(() => softQuit(), 50); return 'quitting'; };
  H['pcs:list'] = () => config.remotes.map((r, i) => ({ name: r.name, host: r.host, user: r.user, active: i === config.activeRemote, reachable: i === config.activeRemote ? (last ? last.ssh.ok : null) : off.healthOf(r.name) ?? null,
    sites: config.projects.filter((p) => core.isAway(p) && core.remoteFor(config, p.remote).name === r.name).map((p) => ({ name: p.name, mode: p.mode, share: p.share ?? 100 })),
    programs: (config.programs || []).filter((p) => p.mode === 'remote' && rp(p).name === r.name).map((p) => ({ name: p.name, port: p.port })) }));
  H['app:stats'] = () => ({ rssMB: Math.round(process.memoryUsage().rss / 1048576), heapMB: Math.round(process.memoryUsage().heapUsed / 1048576), uptimeS: Math.round(process.uptime()) });

  // ---- quit: never leave localhost ports dead - put offloaded sites back on this PC before exiting ----
  let quitP: Promise<void> | null = null;
  function quit(): Promise<void> {
    return quitP ??= (async () => {
      quitting = true;
      const awayProgs = (config.programs || []).filter((p) => p.mode === 'remote');
      const away = config.projects.filter(core.isAway);
      if (awayProgs.length) { core.log('info', `Quitting: bringing ${awayProgs.map((p) => p.name).join(', ')} back to this PC first`); await Promise.race([Promise.all(awayProgs.map((p) => programs.bringProgramHome(config, rp(p), p.name, pdeps()).catch((x) => core.log('err', `restore ${p.name}: ${x.message}`)))), new Promise((r) => setTimeout(r, 120000))]); }
      if (away.length) {
        core.log('info', `Quitting: bringing ${away.map((p) => p.name).join(', ')} back to this PC first`);
        try { fs.writeFileSync(trayFile, 'grey|PC Bridge: moving sites back to this PC before quitting…'); } catch { /* cosmetic */ }
        await Promise.race([Promise.all(away.map(async (p) => { for (let i = 0; i < 240 && off.isBusy(p.name); i++) await new Promise((r) => setTimeout(r, 500)); return off.bringHome(p.name, 'quit').catch((x) => core.log('err', `restore ${p.name}: ${x.message}`)); })), new Promise((r) => setTimeout(r, 240000))]);
      }
      fwd.stopAll(); off.bal.stopAll(); void pub.stop(); try { tray?.kill(); } catch { /* gone */ } try { fs.unlinkSync(svcFile); } catch { /* gone */ }
      server.close(); setTimeout(() => process.exit(0), 300);
    })();
  }

  // ---- HTTP: 127.0.0.1 only; requests need the per-run token (cookie) and a matching Host/Origin, so other web pages cannot drive it ----
  const MIME: Record<string, string> = { '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  let port = 0;
  const server = http.createServer(async (req, res) => {
    const host = req.headers.host || '', url = new URL(req.url || '/', 'http://x');
    if (host !== `127.0.0.1:${port}`) { res.writeHead(403).end('bad host'); return; }
    if (url.pathname === '/ping') { res.writeHead(200).end('pc-bridge'); return; }
    if (url.searchParams.get('t') === token) { if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; core.log('info', 'PC Bridge opened again: what runs on the other PC stays there'); paintTray(last); } res.writeHead(302, { 'Set-Cookie': `pcb=${token}; HttpOnly; SameSite=Strict; Path=/`, Location: '/' }).end(); return; }
    if (!(req.headers.cookie || '').split(/;\s*/).includes('pcb=' + token)) { res.writeHead(401).end('open PC Bridge from its launcher'); return; }
    const origin = req.headers.origin; if (origin && origin !== `http://127.0.0.1:${port}`) { res.writeHead(403).end('bad origin'); return; }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); res.write('retry: 2000\n\n'); clients.add(res); req.on('close', () => clients.delete(res));
      if (last) res.write(`event: status\ndata: ${JSON.stringify(last)}\n\n`); return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const ch = decodeURIComponent(url.pathname.slice(5)); let body = ''; for await (const c of req) { body += c; if (body.length > 1e6) { res.writeHead(413).end(); return; } }
      const fn = Object.hasOwn(H, ch) ? H[ch] : null; res.setHeader('Content-Type', 'application/json');
      if (!fn) { res.writeHead(404).end(JSON.stringify({ ok: false, error: 'blocked channel ' + ch })); return; }
      try { const args = body ? JSON.parse(body) : []; res.end(JSON.stringify({ ok: true, data: (await fn(...args)) ?? null })); }
      catch (e: any) { core.log('err', `${ch}: ${e.message}`); res.end(JSON.stringify({ ok: false, error: e.message })); }
      return;
    }
    const file = url.pathname === '/' ? 'index.html' : path.basename(url.pathname), ext = path.extname(file);
    const p = path.join(uiDir, file);
    if (req.method !== 'GET' || !MIME[ext] || !fs.existsSync(p)) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext], 'Cache-Control': 'no-store' }).end(fs.readFileSync(p));
  });
  server.listen(0, '127.0.0.1', () => {
    port = (server.address() as any).port;
    fs.writeFileSync(svcFile, JSON.stringify({ port, token, pid: process.pid }));
    core.log('info', `PC Bridge service on http://127.0.0.1:${port}`);
    if (config.keepAwake) fwd.startKeepAwake(remote());
    startTray(); paintTray(null); tick();
    if (apiCfg().enabled) pub.apply().catch((e) => core.log('err', 'API: ' + e.message));
    if (!process.argv.includes('--hidden') && !process.env.PCB_NO_UI) openUi(port, token);
    if (process.env.PCB_PRINT) console.log(JSON.stringify({ port, token }));
  });
  // Quit from the tray or the app: things that run on another PC stay there for GRACE_MS (their localhost ports keep working, the service keeps running
  // hidden); opening PC Bridge again in that time cancels the return. When nobody has, the normal quit above brings them back. Quit twice = now.
  // Shutdown signals still quit at once (the PC is going down).
  const GRACE_MS = 600000; let graceTimer: NodeJS.Timeout | null = null;
  function softQuit() {
    const away = (config.programs || []).some((p) => p.mode === 'remote') || config.projects.some(core.isAway);
    if (!away || graceTimer) { if (graceTimer) clearTimeout(graceTimer); void quit(); return; }
    const at = new Date(Date.now() + GRACE_MS).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    core.log('info', `Quit: what runs on another PC stays there until ${at}; if PC Bridge is not opened again by then it all comes back to this PC`);
    try { fs.writeFileSync(trayFile, `grey|PC Bridge is closed: things stay on the other PC until ${at}, open it again to keep them there`); } catch { /* cosmetic */ }
    graceTimer = setTimeout(() => void quit(), GRACE_MS);
  }
  process.on('SIGINT', () => void quit()); process.on('SIGTERM', () => void quit());
  process.on('uncaughtException', (e) => core.log('err', 'uncaught: ' + e.message));
  process.on('unhandledRejection', (e: any) => core.log('err', 'unhandled: ' + (e?.message ?? e)));
}
