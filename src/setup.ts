// "Connect a PC" wizard + self tests. Everything here is read-only on both PCs, with ONE exception that needs an explicit click
// (installShim: creates docker.cmd on the remote). SSH keys, authorized_keys, sshd_config, firewall and Tailscale are never touched:
// when the remote does not accept our key we only SHOW the user what to do.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as core from './core';

export interface Step { id: string; title: string; ok: boolean | null; detail: string; fix?: string; action?: { id: 'install-shim' | 'add-routes'; label: string; preview: string; routes?: string[] } }
export interface Candidate { name?: string; host: string; user: string; keyPath?: string; port?: number; routes?: string[] }
export interface Peer { name: string; dns: string; ips: string[]; ip4?: string; os: string; online: boolean; sshOpen?: boolean; self?: boolean }
export interface TestResult { name: string; ok: boolean; detail: string; ms: number; warn?: boolean }

const SHIM_TEXT = '@wsl.exe -e docker %*';
const SHIM_PATH = '%LOCALAPPDATA%\\Microsoft\\WindowsApps\\docker.cmd';

export function parsePeers(json: any): Peer[] {
  const mk = (p: any, self = false): Peer => { const ips: string[] = p.TailscaleIPs || []; return { name: String(p.HostName || ''), dns: String(p.DNSName || '').replace(/\.$/, ''), ips, ip4: ips.find((i) => /^\d+\.\d+\.\d+\.\d+$/.test(i)), os: String(p.OS || ''), online: self ? true : !!p.Online, self }; };
  return [...(json?.Self ? [mk(json.Self, true)] : []), ...Object.values<any>(json?.Peer || {}).map((p) => mk(p))];
}

/** Everything on this tailnet that could be the PC to connect (also tells which ones answer on the SSH port). */
export async function discoverPeers(sshPort = 22): Promise<Peer[]> {
  const r = await core.run('tailscale', ['status', '--json'], { timeout: 8000, poll: true });
  if (r.code !== 0) throw new Error('Tailscale is not answering on this PC (' + (r.stderr.trim().split('\n')[0] || 'is it running and signed in?') + ')');
  const peers = parsePeers(JSON.parse(r.stdout));
  await Promise.all(peers.filter((p) => p.online && !p.self && p.ip4).map(async (p) => { p.sshOpen = (await core.tcpProbe(p.ip4!, sshPort, 1500)).ok; }));
  return peers;
}

const toRemote = (c: Candidate): core.Remote => { const r = toRemote0(c); const bad = core.validateConfig({ ...core.defaultConfig(), remotes: [r], activeRemote: 0 }).filter((x) => x.startsWith('Remote')); if (bad.length) throw new Error(bad.join('; ')); return r; };
const toRemote0 = (c: Candidate): core.Remote => ({ name: c.name || c.host, host: c.host, user: c.user, keyPath: c.keyPath || path.join(os.homedir(), '.ssh', 'id_ed25519'), port: c.port || 22, contextName: 'remote', routes: c.routes });

const SYS_PS = `$ErrorActionPreference='SilentlyContinue'; $o=@{}
$o.os=(Get-CimInstance Win32_OperatingSystem).Caption; $o.host=$env:COMPUTERNAME
$o.ramGB=[math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB,1)
$o.wsl=@((& wsl.exe -l -q 2>$null) | % { ($_ -replace "\\0",'').Trim() } | ? { $_ })
$o.docker=((& wsl.exe -e docker version --format '{{.Server.Version}}' 2>&1 | Out-String) -replace "\\0",'').Trim()
$o.shim=[bool](Test-Path "$env:LOCALAPPDATA\\Microsoft\\WindowsApps\\docker.cmd")
$o.lan=@(Get-NetIPConfiguration | ? { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | % { $_.IPv4Address.IPAddress })
ConvertTo-Json -InputObject $o -Compress`;

/** Step-by-step readiness check of a PC. Never changes anything. */
export async function checkRemote(c: Candidate): Promise<{ steps: Step[]; ready: boolean; info?: { host: string; os: string; ramGB: number; lan: string[] } }> {
  const r = toRemote(c); const steps: Step[] = []; const add = (s: Step) => steps.push(s);
  // 1 key
  const keyOk = fs.existsSync(r.keyPath);
  const keys = (() => { try { return fs.readdirSync(path.join(os.homedir(), '.ssh')).filter((f) => /^id_/.test(f) && !f.endsWith('.pub')); } catch { return []; } })();
  add({ id: 'key', title: 'SSH key on this PC', ok: keyOk, detail: keyOk ? r.keyPath : `${r.keyPath} does not exist`, fix: keyOk ? undefined : keys.length ? `Keys found in ~/.ssh: ${keys.join(', ')}. Use one of those as the key path.` : 'No SSH key found. Create one yourself with: ssh-keygen -t ed25519 (PC Bridge never creates or changes keys).' });
  // 2 reachability of every address
  const addrs = [r.host, ...(r.routes || [])]; const probes = await Promise.all(addrs.map(async (h) => ({ h, t: await core.tcpProbe(h, r.port, 2500) })));
  const reach = probes.filter((x) => x.t.ok);
  add({ id: 'reach', title: `PC answers on SSH port ${r.port}`, ok: reach.length > 0, detail: probes.map((x) => `${x.h}: ${x.t.ok ? x.t.ms + ' ms' : x.t.error}`).join(' · '),
    fix: reach.length ? undefined : 'Make sure the PC is on, signed in to Tailscale (or on the same network), and the OpenSSH Server service is running (Start-Service sshd).' });
  if (!reach.length || !keyOk) return { steps, ready: false };
  // 3 login with the existing key
  const t0 = Date.now(); const first = reach[0].h; const rr = { ...r, host: first, routes: undefined } as core.Remote;
  const login = await core.ssh(rr, 'echo PCB_OK', { timeout: 15000 });
  const logged = login.code === 0 && login.stdout.includes('PCB_OK');
  const pub = (() => { try { return fs.readFileSync(r.keyPath + '.pub', 'utf8').trim(); } catch { return ''; } })();
  add({ id: 'login', title: `Sign in as ${r.user} with your key (no password)`, ok: logged, detail: logged ? `ok in ${Date.now() - t0} ms` : (login.stderr.trim().split('\n').pop() || 'failed'),
    fix: logged ? undefined : `The PC does not accept this key for "${r.user}". On THAT PC add your public key yourself (PC Bridge never edits authorized_keys):\n` + (pub ? `  ${pub}\n` : '  (your .pub file was not found)\n') + 'Normal account: C:\\Users\\<user>\\.ssh\\authorized_keys · Administrator account: C:\\ProgramData\\ssh\\administrators_authorized_keys. Also check the user name.' });
  if (!logged) return { steps, ready: false };
  // 4 what is on that PC
  const sys = await core.psRemote(rr, SYS_PS, { timeout: 40000 }); let j: any = {};
  try { j = JSON.parse(sys.stdout.split('\n').filter((l) => l.trim().startsWith('{')).pop() || '{}'); } catch { /* reported below */ }
  const wsl: string[] = Array.isArray(j.wsl) ? j.wsl : j.wsl ? [j.wsl] : []; const lan: string[] = (Array.isArray(j.lan) ? j.lan : j.lan ? [j.lan] : []).filter((x: string) => /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(x));
  add({ id: 'system', title: 'The PC', ok: !!j.host, detail: j.host ? `${j.host} · ${j.os} · ${j.ramGB} GB RAM` : 'could not read system info' });
  add({ id: 'wsl', title: 'Linux (WSL) for Docker', ok: wsl.length > 0, detail: wsl.length ? wsl.join(', ') : 'WSL is not installed', fix: wsl.length ? undefined : 'Docker work needs WSL2 with Docker Engine on that PC. Install it there yourself (wsl --install, then Docker Engine in Ubuntu); PC Bridge does not install anything without being asked.' });
  const dockerOk = /^\d+\./.test(j.docker || ''); add({ id: 'docker', title: 'Docker Engine on that PC', ok: dockerOk, detail: dockerOk ? 'version ' + j.docker : (j.docker || 'not answering') });
  if (dockerOk) add({ id: 'shim', title: 'docker command reachable over SSH (docker.cmd)', ok: !!j.shim, detail: j.shim ? 'present' : 'missing: remote "docker context" would fail',
    fix: j.shim ? undefined : `Creates one file on that PC: ${SHIM_PATH} containing "${SHIM_TEXT}" (so ssh sessions can call docker inside WSL). Nothing else is changed. Delete the file to undo.`,
    action: j.shim ? undefined : { id: 'install-shim', label: 'Yes, create docker.cmd on that PC', preview: `${SHIM_PATH}\n${SHIM_TEXT}` } });
  // 5 same-network address (faster than Tailscale, and a fallback when Tailscale is down)
  const known = new Set(addrs); const fresh = lan.filter((x) => !known.has(x));
  if (lan.length) {
    const lp = await Promise.all(lan.map(async (h) => ({ h, t: await core.tcpProbe(h, r.port, 2000) }))); const reachable = lp.filter((x) => x.t.ok).map((x) => x.h);
    add({ id: 'lan', title: 'Same Wi-Fi / LAN address', ok: reachable.length > 0 ? true : null, detail: lp.map((x) => `${x.h}: ${x.t.ok ? 'reachable from this PC (' + x.t.ms + ' ms)' : 'not reachable from here (other network)'}`).join(' · '),
      action: fresh.some((h) => reachable.includes(h)) ? { id: 'add-routes', label: 'Use it as a backup address', preview: `Adds ${fresh.filter((h) => reachable.includes(h)).join(', ')} as a fallback address of this PC. It is only used while the Tailscale address stops answering.`, routes: fresh.filter((h) => reachable.includes(h)) } : undefined });
  }
  return { steps, ready: steps.filter((s) => s.id !== 'lan').every((s) => s.ok !== false || s.id === 'shim'), info: { host: j.host, os: j.os, ramGB: j.ramGB, lan } };
}

/** The ONE remote change the wizard can make, only after the user clicked the button that shows the exact file + content. Idempotent: never overwrites. */
export async function installShim(c: Candidate, confirm: boolean): Promise<string> {
  if (confirm !== true) throw new Error('This changes the remote PC: it needs your explicit confirmation');
  const r = toRemote(c);
  const x = await core.psRemote(r, `$f=Join-Path $env:LOCALAPPDATA 'Microsoft\\WindowsApps\\docker.cmd'; if(Test-Path $f){'EXISTS'} else { Set-Content -Path $f -Value '${SHIM_TEXT}' -Encoding ascii; 'CREATED' }`, { timeout: 30000 });
  if (x.code !== 0) throw new Error('could not create the file: ' + (x.stderr || x.stdout).trim().split('\n')[0]);
  return x.stdout.includes('EXISTS') ? 'docker.cmd was already there (not changed)' : 'created docker.cmd on the remote PC';
}

/** Add (or update) a PC in the config and optionally make it the active one. Returns the new index. */
export function applyRemote(cfg: core.Config, c: Candidate, makeActive: boolean): number {
  const nr = toRemote(c); let i = cfg.remotes.findIndex((x) => x.host === nr.host && x.user === nr.user);
  if (i < 0) { cfg.remotes.push(nr); i = cfg.remotes.length - 1; } else cfg.remotes[i] = { ...cfg.remotes[i], ...nr, contextName: cfg.remotes[i].contextName, routes: [...new Set([...(cfg.remotes[i].routes || []), ...(nr.routes || [])])] };
  if (makeActive) cfg.activeRemote = i;
  return i;
}

// ---------- self tests (every "Test" button in the UI calls these; so can anything else) ----------
const timed = async (name: string, fn: () => Promise<{ ok: boolean; detail: string; warn?: boolean }>): Promise<TestResult> => {
  const t0 = Date.now(); try { const r = await fn(); return { name, ...r, ms: Date.now() - t0 }; } catch (e: any) { return { name, ok: false, detail: String(e.message || e).split('\n')[0], ms: Date.now() - t0 }; }
};

export interface TestCtx { config: core.Config; fwd: core.Forwarder; off: core.Offloader; status: core.Status | null; selfPid: number; uiPort: number }

export async function testConnection(ctx: TestCtx): Promise<TestResult[]> {
  const r = ctx.config.remotes[ctx.config.activeRemote]; const out: TestResult[] = [];
  out.push(await timed('This PC: CPU / RAM / disks readable', async () => { await core.localMetrics(); await new Promise((x) => setTimeout(x, 600)); const m = await core.localMetrics(); return { ok: m.ramTotalMB > 0 && m.disks.length > 0, detail: `${m.host}: ${m.cpu}% CPU, ${(m.ramUsedMB / 1024).toFixed(1)}/${(m.ramTotalMB / 1024).toFixed(1)} GB RAM, ${m.disks.length} drives` }; }));
  out.push(await timed('Tailscale on this PC', async () => { const ts = await core.tailscaleState(r); return { ok: ts.state !== 'offline', warn: ts.state === 'unknown', detail: `${ts.state}: ${ts.detail}` }; }));
  out.push(await timed('Address of the remote PC (Tailscale / LAN backup)', async () => { const i = await core.probeRoutes(r); const up = i.candidates.filter((x) => x.ms !== null); return { ok: up.length > 0, warn: !i.primary, detail: `using ${i.host}${i.primary ? '' : ' (backup address: the main one is not answering)'} · ` + i.candidates.map((x) => `${x.host} ${x.ms === null ? 'down' : x.ms + ' ms'}`).join(', ') }; }));
  out.push(await timed('SSH sign-in with the key (no password)', async () => { const x = await core.ssh(r, 'echo PCB_OK', { timeout: 15000 }); return { ok: x.code === 0 && x.stdout.includes('PCB_OK'), detail: x.code === 0 ? `ok, ${x.ms} ms` : (x.stderr.trim().split('\n').pop() || 'failed') }; }));
  out.push(await timed('Remote Docker engine answers', async () => { const x = await core.wslSh(r, 'docker version --format "{{.Server.Version}}"', { timeout: 40000 }); return { ok: /^\d+\./.test(x.stdout.trim()), detail: x.stdout.trim().split('\n')[0] || x.stderr.trim().split('\n')[0] }; }));
  out.push(await timed('docker.cmd shim (remote "docker context" works)', async () => { const x = await core.ssh(r, 'where docker', { timeout: 15000 }); return { ok: x.code === 0, detail: x.code === 0 ? x.stdout.trim().split('\n')[0] : 'missing on the remote' }; }));
  out.push(await timed('Docker on this PC (needed for failover; not started by this test)', async () => { const x = await core.dk(['info', '--format', '{{.ServerVersion}}'], { timeout: 15000 }); return { ok: true, warn: x.code !== 0, detail: x.code === 0 ? 'running ' + x.stdout.trim() : 'off (fine while sites run on the remote; failover or Bring back would start Docker Desktop first)' }; }));
  return out;
}

export async function testPort(port: number): Promise<TestResult> {
  return timed(`localhost:${port} answers`, async () => { const t = await core.tcpProbe('127.0.0.1', port, 2000); if (!t.ok) return { ok: false, detail: 'nothing listens (' + t.error + ')' }; const h = await core.testForward(port); return { ok: true, detail: h.ok ? `HTTP ${h.status} in ${h.ms} ms${h.server ? ' (' + h.server + ')' : ''}` : `TCP ok in ${t.ms} ms (not HTTP)` }; });
}

/** One project: is it really served where the config says, and is that answer healthy? */
export async function testProject(ctx: TestCtx, name: string): Promise<TestResult[]> {
  const p = ctx.config.projects.find((x) => x.name === name); if (!p) throw new Error(`Unknown project "${name}"`);
  const r = ctx.config.remotes[ctx.config.activeRemote]; const out: TestResult[] = []; const port = p.ports?.[0]; if (!port) return [{ name: 'Port configured', ok: false, detail: 'no port set', ms: 0 }];
  const mode = p.mode ?? 'local';
  out.push({ name: 'Where it runs', ok: true, detail: mode === 'split' ? `split: ${100 - (p.share ?? 0)}% this PC / ${p.share}% remote` : mode === 'remote' ? 'remote PC (100%)' : 'this PC (100%)', ms: 0 });
  out.push(await testPort(port));
  if (mode === 'remote' || mode === 'split') out.push(await timed('Remote copy is up (checked on the remote PC)', async () => { const s = await core.getStatus(r, false, [port]); return { ok: !!s.portsUp?.[String(port)], detail: s.ssh.ok ? `port ${port} ${s.portsUp?.[String(port)] ? 'open' : 'CLOSED'} on ${r.name}` : 'remote unreachable' }; }));
  if (mode === 'remote') out.push(await timed('Tunnel to the remote is active', async () => ({ ok: ctx.fwd.get(port)?.state === 'active', detail: ctx.fwd.get(port)?.state ?? 'no tunnel' })));
  if (mode === 'split') {
    out.push(await timed('Load balancer is listening', async () => ({ ok: ctx.off.bal.has(port), detail: ctx.off.bal.has(port) ? 'on 127.0.0.1 and ::1' : 'not running' })));
    out.push(...(await testBalance(ctx, name, 20)));
  }
  if (mode === 'local' && p.failover) out.push(await timed('Docker on this PC', async () => { const x = await core.dk(['info', '--format', '{{.ServerVersion}}'], { timeout: 15000 }); return { ok: x.code === 0, detail: x.code === 0 ? 'running' : 'not running' }; }));
  return out;
}

/** Sends n real connections to localhost:port and shows how they were shared between the PCs, next to the target. */
export async function testBalance(ctx: TestCtx, name: string, n = 40): Promise<TestResult[]> {
  const p = ctx.config.projects.find((x) => x.name === name); if (!p?.ports?.length) throw new Error(`Unknown project "${name}"`);
  const port = p.ports[0]; if (p.mode !== 'split') return [{ name: 'Load split', ok: true, warn: true, detail: `${name} is not split (it is served by ${p.mode === 'remote' ? 'the remote PC' : 'this PC'} alone); choose a share first`, ms: 0 }];
  return [await timed(`Load split over ${n} new connections`, async () => {
    ctx.off.bal.resetStats(port); let okN = 0;
    for (let i = 0; i < n; i++) { const t = await core.tcpProbe('127.0.0.1', port, 3000); if (t.ok) okN++; }
    await new Promise((x) => setTimeout(x, 300)); const st = ctx.off.bal.stats(port); const remote = st.find((b) => b.name === 'remote'), local = st.find((b) => b.name === 'local');
    const total = (remote?.conns ?? 0) + (local?.conns ?? 0); const want = p.share ?? 0; const got = total ? Math.round(((remote?.conns ?? 0) * 100) / total) : 0;
    return { ok: okN === n && Math.abs(got - want) <= 8, detail: `${okN}/${n} connected · remote ${remote?.conns}, this PC ${local?.conns} → ${got}% to remote (target ${want}%)${remote?.down ? ' · remote currently marked DOWN' : ''}` };
  })];
}

export async function testAll(ctx: TestCtx): Promise<TestResult[]> {
  const out = await testConnection(ctx);
  for (const f of ctx.config.forwards) out.push(await timed(`Forward ${f.name}: localhost:${f.localPort} → ${f.remoteHost}:${f.remotePort}`, async () => { const s = ctx.fwd.get(f.localPort); if (!s || s.state === 'stopped') return { ok: true, warn: true, detail: 'not started (nothing to test)' }; const t = await testPort(f.localPort); return { ok: t.ok, detail: t.detail }; }));
  for (const p of ctx.config.projects) for (const t of await testProject(ctx, p.name).catch((e) => [{ name: 'Project ' + p.name, ok: false, detail: e.message, ms: 0 }])) out.push({ ...t, name: `${p.name}: ${t.name}` });
  out.push(await timed('Ports screen can read this PC', async () => { const rows = await core.listLocalPorts(ctx.config, ctx.selfPid, ctx.uiPort); return { ok: rows.some((x) => x.port === ctx.uiPort), detail: `${rows.length} ports, PC Bridge's own port found` }; }));
  return out;
}
