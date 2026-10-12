// Move a plain program (Node, Python, anything started by one command) to the remote PC and forward its port.
// Everything on the remote lives under one root folder on a NON-C drive (default E:\PCBridge): tools, program files, logs, temp, npm cache.
// Nothing is installed (no installer, PATH, registry, service or admin): a portable Node zip is unpacked into <root>\tools and programs
// run under a small restarting supervisor started with WMI so it survives the ssh session.
import * as core from './core';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface Program {
  name: string; dir: string;            // local folder with the program's files
  cmd: string;                          // start command, run inside the folder (e.g. "node server.js")
  port: number;                         // port it serves on (same number on both PCs)
  mode?: 'local' | 'remote';            // where it runs now ('local' = not managed / this PC)
  env?: Record<string, string>;
  runtime?: 'node' | 'python';          // default: guessed from the folder (package.json -> node, requirements.txt / pyproject.toml / "python ..." -> python)
  needs?: number[];                     // ports of services that stay on THIS PC (e.g. LM Studio 1234): while the program runs elsewhere they are reachable there on localhost:port
  omitDev?: boolean;                    // Node: install only "dependencies" on the other PC (npm install --omit=dev); for apps whose devDependencies (tests, tooling) can't install there
  ignoreScripts?: boolean;              // Node: install dependencies with --ignore-scripts (no native compiling on a PC without Visual Studio; packages that ship ready-made binaries still work), then run the program's own "postinstall"
  failover?: boolean;                   // remote dies -> start it on this PC again (default on)
  remote?: string;                      // NAME of the PC it runs on when moved (default: the active PC)
  python?: string;                      // Python: version for the venv on the other PC (e.g. "3.13"); default 3.12
  requirements?: string;                // Python: install from this file of the folder (e.g. requirements.lock) instead of requirements.txt / pyproject.toml; if pyproject.toml exists the project itself is then added with --no-deps
  pullExcludes?: string[];              // folders (relative to the program's folder, e.g. "data") that "bring home", Quit and failover do NOT copy back from the other PC; pushing them still works
  requireFast?: boolean;                // the copy must go over the home network: refuse up front (nothing is copied) instead of crawling through Tailscale
  synced?: number;                      // ms timestamp of the last full copy or push to the other PC: "push" without a file list sends what changed after it
}
export const runtimeOf = (p: Program): 'node' | 'python' => p.runtime ?? (fs.existsSync(path.join(p.dir, 'package.json')) ? 'node' : fs.existsSync(path.join(p.dir, 'requirements.txt')) || fs.existsSync(path.join(p.dir, 'pyproject.toml')) || /^\s*(python|py|uv)\b/i.test(p.cmd) ? 'python' : 'node');
export const DEFAULT_ROOT = 'E:\\PCBridge';
export const ROOT_RE = /^[A-Za-z]:\\[A-Za-z0-9_.\\-]*$/;
export const PROG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
export const root = (c: core.Config) => (c.remoteRoot || DEFAULT_ROOT).replace(/\\+$/, '');

export function validatePrograms(c: core.Config): string[] {
  const e: string[] = []; const seen = new Set<string>(), ports = new Map<number, string>();
  if (c.remoteRoot && (!ROOT_RE.test(c.remoteRoot) || /^c:/i.test(c.remoteRoot))) e.push('Remote folder must look like E:\\PCBridge and may not be on C:');
  for (const p of c.programs || []) {
    if (!PROG_RE.test(p.name || '')) e.push(`Program "${p.name}": name may use letters, digits, - and _ (max 40)`);
    if (seen.has(p.name)) e.push(`Program "${p.name}" is listed twice`); seen.add(p.name);
    if (!p.dir || !path.isAbsolute(p.dir)) e.push(`Program "${p.name}": folder must be a full path`);
    if (!p.cmd || /[\r\n\0]/.test(p.cmd) || p.cmd.length > 500) e.push(`Program "${p.name}": start command is empty, too long or has line breaks`);
    if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) e.push(`Program "${p.name}": port must be 1-65535`);
    else if (ports.has(p.port)) e.push(`Program "${p.name}": port ${p.port} is already used by program "${ports.get(p.port)}"`); else ports.set(p.port, p.name);
    if (p.needs !== undefined && (!Array.isArray(p.needs) || p.needs.length > 20 || p.needs.some((x) => !Number.isInteger(x) || x < 1 || x > 65535 || x === p.port))) e.push(`Program "${p.name}": "needs" must be a list of ports (not its own port)`);
    if (p.runtime && p.runtime !== 'node' && p.runtime !== 'python') e.push(`Program "${p.name}": runtime must be node or python`);
    if (p.python !== undefined && !/^3\.\d{1,2}(\.\d{1,2})?$/.test(String(p.python))) e.push(`Program "${p.name}": python must look like 3.13`);
    if (p.requirements !== undefined && !/^[\w.-]{1,80}$/.test(String(p.requirements))) e.push(`Program "${p.name}": requirements must be a file name in the program's folder`);
    if (p.pullExcludes !== undefined && (!Array.isArray(p.pullExcludes) || p.pullExcludes.length > 50 || p.pullExcludes.some((x) => !/^[\w.-]+(\/[\w.-]+)*$/.test(String(x)) || String(x).split('/').includes('..')))) e.push(`Program "${p.name}": pullExcludes must be folder names inside the program's folder (like data or data/raw)`);
    for (const [k, v] of Object.entries(p.env || {})) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || /[\r\n\0]/.test(String(v))) e.push(`Program "${p.name}": bad environment entry ${k}`);
  }
  return e;
}

// ---- the supervisor that runs on the remote (plain Node; restarts the program with back-off, logs to <root>\logs) ----
const SUPERVISOR = `'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const j = JSON.parse(Buffer.from(process.argv[3], 'base64').toString());
fs.mkdirSync(j.runDir, { recursive: true }); fs.mkdirSync(path.dirname(j.log), { recursive: true });
fs.writeFileSync(path.join(j.runDir, j.name + '.pid'), String(process.pid));
try { if (fs.statSync(j.log).size > 5e6) fs.truncateSync(j.log, 0); } catch (e) {}
const out = fs.openSync(j.log, 'a'); let delay = 1000;
const env = Object.assign({}, process.env, j.env, { PATH: (j.venv ? j.venv + ';' : '') + j.nodeDir + ';' + process.env.PATH, VIRTUAL_ENV: j.venv ? j.venv.replace(/\\\\Scripts$/, '') : undefined, TEMP: j.tmp, TMP: j.tmp, npm_config_cache: j.npmCache });
(function start() {
  const t = Date.now(); fs.writeSync(out, '[supervisor] start ' + new Date().toISOString() + '\\n');
  const c = cp.spawn('cmd.exe', ['/d', '/s', '/c', '"' + j.cmd + '"'], { cwd: j.dir, env, stdio: ['ignore', out, out], windowsHide: true, windowsVerbatimArguments: true });
  c.on('exit', (code) => { fs.writeSync(out, '[supervisor] exited ' + code + '\\n'); delay = Date.now() - t > 60000 ? 1000 : Math.min(delay * 2, 30000); setTimeout(start, delay); });
  c.on('error', (e) => { fs.writeSync(out, '[supervisor] ' + e.message + '\\n'); setTimeout(start, 30000); });
})();
`;

const ps = (c: core.Config, s: string) => `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $root='${root(c)}'; $env:TEMP="$root\\tmp"; $env:TMP="$root\\tmp"; $env:npm_config_cache="$root\\npm-cache"\n` + s;
const lines = (x: core.RunResult) => x.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
const clixmlErr = (s: string) => [...s.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => m[1].replace(/_x000D__x000A_/g, ' ').replace(/_x[0-9A-Fa-f]{4}_/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim()).filter(Boolean).join(' ');
const fail = (what: string, x: core.RunResult) => new Error(`${what}: ${clixmlErr(x.stderr) || (x.stderr || x.stdout).replace(/#< CLIXML[\s\S]*/, '').trim().split('\n')[0] || 'exit ' + x.code}`.slice(0, 600));

/** Create the root folder on the remote's non-C drive and unpack portable Node there (checksum verified). Idempotent. */
export async function prepareRemote(c: core.Config, r: core.Remote): Promise<string[]> {
  const v = process.version; const drive = root(c)[0].toUpperCase();
  // three short remote calls: one -EncodedCommand line is limited to ~8 KB by Windows
  const x0 = await core.psRemote(r, ps(c, `
$d=Get-PSDrive -Name '${drive}' -ErrorAction SilentlyContinue; if(-not $d){ throw 'drive ${drive}: does not exist on the remote PC' }
if($d.Free -lt 2GB){ throw ('drive ${drive}: has only {0:N1} GB free' -f ($d.Free/1GB)) }
foreach($s in 'tools','apps','logs','run','tmp','npm-cache'){ New-Item -ItemType Directory -Force -Path "$root\\$s" | Out-Null }
'ok folders on ${drive}: ' + $root
`), { timeout: 60000 });
  if (x0.code !== 0) throw fail('preparing the remote failed', x0);
  const xs = await core.psRemote(r, ps(c, `[IO.File]::WriteAllBytes("$root\\supervisor.js",[Convert]::FromBase64String('${Buffer.from(SUPERVISOR).toString('base64')}')); 'ok supervisor written'`), { timeout: 60000 });
  if (xs.code !== 0) throw fail('writing the supervisor failed', xs);
  const x = await core.psRemote(r, ps(c, `
if(Test-Path "$root\\tools\\node\\node.exe"){ 'ok node already there: ' + (& "$root\\tools\\node\\node.exe" -v) } else {
  [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
  $v='${v}'; $base="https://nodejs.org/dist/$v"; $zip="$root\\tools\\node.zip"
  Invoke-WebRequest "$base/node-$v-win-x64.zip" -OutFile $zip -UseBasicParsing
  $want=(((Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content -split "\`n") | ? { $_ -match "node-$v-win-x64.zip" } | select -First 1) -split '\\s+' | select -First 1
  if((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $want.ToLower()){ Remove-Item $zip -Force; throw 'Node download failed its SHA-256 check' }
  Expand-Archive $zip -DestinationPath "$root\\tools\\_n" -Force; Move-Item "$root\\tools\\_n\\node-$v-win-x64" "$root\\tools\\node"; Remove-Item "$root\\tools\\_n",$zip -Recurse -Force
  'ok node ' + (& "$root\\tools\\node\\node.exe" -v) + ' installed (checksum verified)' }
`), { timeout: 600000 });
  if (x.code !== 0) throw fail('preparing the remote failed', x);
  return [...lines(x0), ...lines(xs), ...lines(x)].filter((l) => l.startsWith('ok'));
}

/** Python programs: portable `uv` (one exe, checksum verified) under <root>\tools\uv. uv downloads Python itself, into <root>\python (never C:). Idempotent. */
export async function preparePython(c: core.Config, r: core.Remote): Promise<string[]> {
  const x = await core.psRemote(r, ps(c, `
$uv="$root\\tools\\uv\\uv.exe"
if(Test-Path $uv){ 'ok uv already there: ' + (& $uv --version) } else {
  [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
  $u='https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip'; $zip="$root\\tools\\uv.zip"
  Invoke-WebRequest $u -OutFile $zip -UseBasicParsing
  $sc=(Invoke-WebRequest "$u.sha256" -UseBasicParsing).Content; if($sc -is [byte[]]){ $sc=[Text.Encoding]::ASCII.GetString($sc) }
  $want=($sc.ToString().Trim() -split '\\s+')[0]
  if((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $want.ToLower()){ Remove-Item $zip -Force; throw 'uv download failed its SHA-256 check' }
  New-Item -ItemType Directory -Force "$root\\tools\\uv" | Out-Null; Expand-Archive $zip -DestinationPath "$root\\tools\\uv" -Force; Remove-Item $zip -Force
  $f=Get-ChildItem "$root\\tools\\uv" -Recurse -Filter uv.exe | select -First 1; if($f.DirectoryName -ne "$root\\tools\\uv"){ Move-Item "$($f.DirectoryName)\\*" "$root\\tools\\uv" -Force }
  'ok uv ' + (& $uv --version) + ' installed (checksum verified)' }
`), { timeout: 600000 });
  if (x.code !== 0) throw fail('installing uv failed', x);
  return lines(x).filter((l) => l.startsWith('ok'));
}

/** Copy the folder (tar | ssh | tar, Windows tar on both ends) into <root>\\apps\\<name>.
 *  The pipe tar -> ssh is made by cmd.exe itself, so no data passes through this Node process (inside the running service that data path was
 *  measured at ~50 KB/s while the same pipeline run on its own moved 4 MB/s). */
async function copyDir(c: core.Config, r: core.Remote, p: Program): Promise<string> {
  if (!fs.existsSync(p.dir) || !fs.statSync(p.dir).isDirectory()) throw new Error(`Folder not found: ${p.dir}`);
  const dest = `${root(c)}\\apps\\${p.name}`;
  const mk = await core.psRemote(r, ps(c, `New-Item -ItemType Directory -Force -Path "${dest}" | Out-Null; 'ok'`), { timeout: 60000 });
  if (mk.code !== 0) throw fail('creating the folder on the other PC failed', mk);
  const q = cq;
  // gzip: about a third fewer bytes for code + databases on a thin link; patient keepalives (a copy that saturates the uplink delays the answers for a while)
  const targs = ['-czf', '-', ...c.syncExcludes.flatMap((e) => ['--exclude', e]), '-C', p.dir, '.'];
  const { sargs, ms, lan, sx } = await bulkArgs(r);
  if (p.requireFast && !lan) throw new Error(`${p.name}: the copy must go over the home network, but this PC cannot reach ${r.name} on its LAN address right now (other network, or fast copy is off). Nothing was copied.`);
  const line = `tar ${targs.map(q).join(' ')} | ${sx} ${sargs.map(q).join(' ')} tar -xzf - -C ${dest}`;
  core.log('cmd', `$ ${line}`);
  core.log('info', `[program ${p.name}] copying over ${lan ? 'the home network' : 'Tailscale'} (${sargs[sargs.length - 1].split('@')[1]}), limit ${Math.round(ms / 60000)} min`);
  const t0 = Date.now();
  try {
    const { code, err } = await runPipeline(line, ms, 'copy');
    if (code !== 0) throw new Error('copy failed: ' + (err.trim().split('\n')[0] || 'exit ' + code));
    core.log('info', `[program ${p.name}] copy finished after ${Math.round((Date.now() - t0) / 1000)} s`); return `${lan ? 'the home network' : 'Tailscale'} (${sargs[sargs.length - 1].split('@')[1]}) in ${Math.round((Date.now() - t0) / 1000)} s`;
  } catch (e) { core.log('info', `[program ${p.name}] copy failed after ${Math.round((Date.now() - t0) / 1000)} s`); throw e; }
}

/** ssh arguments + time limit for a big copy: patient keepalives; on the home-network address (~17x faster) the limit is 3 h instead of 15 min. */
async function bulkArgs(r: core.Remote): Promise<{ sargs: string[]; ms: number; lan: boolean; sx: string }> {
  const a = await core.bulkSshArgs(r), lan = a.join(' ') !== core.sshArgs(r).join(' ');
  return { sargs: a.map((x) => x.replace('ServerAliveInterval=10', 'ServerAliveInterval=15').replace('ServerAliveCountMax=2', 'ServerAliveCountMax=8')), ms: lan ? 10800000 : 900000, lan, sx: fastSsh() };
}

const cq = (s: string) => (/^[\w@.:\\/=,+-]+$/.test(s) ? s : `"${s.replace(/"/g, '')}"`);   // cmd quoting; folder names never contain quotes

/** Run a cmd.exe pipeline (tar | ssh ...) completely outside this service: a small batch file started through WMI (Win32_Process.Create), so
 *  the pipeline's parent is not this process. Measured: the same copy ran at ~15 MB/s from a normal process but at 50-110 KB/s when it was a child of
 *  the long-running service (cause not found), also through a helper node. The batch file writes its stderr and exit code to files that are polled here;
 *  no data passes through this process. */
function runPipeline(line: string, ms: number, what: string): Promise<{ code: number | null; err: string }> {
  return new Promise((resolve, reject) => {
    const base = path.join(os.tmpdir(), `pcb-pipe-${process.pid}-${Date.now()}`), bat = base + '.cmd', errf = base + '.err', codef = base + '.code';
    fs.writeFileSync(bat, `@echo off\r\n(${line.replace(/%/g, '%%')}) 2> "${errf}"\r\necho %errorlevel% > "${codef}"\r\n`);
    const clean = () => { for (const f of [bat, errf, codef]) try { fs.unlinkSync(f); } catch { /* already gone */ } };
    const launch = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /d /c "${bat.replace(/'/g, "''")}"' }).ProcessId`], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let pid = 0, out = ''; launch.stdout!.on('data', (d) => (out += d)); launch.on('close', () => { pid = parseInt(out.trim(), 10) || 0; if (!pid) end(new Error(`could not start the ${what}`)); });
    let done = false; const t0 = Date.now();
    const end = (e?: Error, code: number | null = null) => {
      if (done) return; done = true; clearInterval(poll);
      let err = ''; try { err = fs.readFileSync(errf, 'utf8'); } catch { /* none */ } clean(); e ? reject(e) : resolve({ code, err });
    };
    const poll = setInterval(() => {
      if (fs.existsSync(codef)) { let c = NaN; try { c = parseInt(fs.readFileSync(codef, 'utf8').trim(), 10); } catch { /* retry next tick */ } if (!isNaN(c)) end(undefined, c); }
      else if (Date.now() - t0 > ms) { if (pid) core.killTree(pid); end(new Error(`${what} timed out after ${Math.round(ms / 60000)} minutes`)); }
    }, 1000);
  });
}

export /** Remote -> this PC for files the program changed there (data, databases, uploads). Never overwrites a newer local file; skips dependencies and logs. */
function copyBack(c: core.Config, r: core.Remote, p: Program): Promise<void> {
  const src = `${root(c)}\\apps\\${p.name}`;
  const ex = [...c.syncExcludes, '.venv', 'node_modules', ...(p.pullExcludes || []).map((x) => './' + x)].flatMap((e) => ['--exclude', e]);   // "./data" = only that folder at the top, not any "data" deeper down
  // the data pipe is made by cmd.exe (not by this process); the local tar's exit code is ignored (non-zero for "newer file kept": that is the point),
  // so the remote tar reports success itself with a marker on stderr
  return bulkArgs(r).then(({ sargs, ms, sx }) => {
  const line = `${sx} ${sargs.map(cq).join(' ')} "tar -cf - ${ex.join(' ')} -C ${src} . && echo PCB_OK 1>&2" | tar -xf - --keep-newer-files -C ${cq(p.dir)}`;
  core.log('cmd', `$ ${line}`);
  return runPipeline(line, Math.max(ms, 600000), 'copy back'); }).then(({ err }) => { if (!err.includes('PCB_OK')) throw new Error(err.trim().split('\n').filter((l) => l.trim())[0] || 'copy back failed'); });
}

/** Send only some files of a moved program to its PC (no full copy, no reinstall, no restart unless asked). files = paths relative to the program's folder;
 *  without it: every file changed since the last copy or push. dependencies (node_modules, .venv) and syncExcludes are never sent. */
export async function pushFiles(c: core.Config, r: core.Remote, name: string, d: ProgramDeps, files?: string[], restart?: boolean): Promise<string> {
  const p = (c.programs || []).find((x) => x.name === name); if (!p) throw new Error(`No program named "${name}"`);
  if (p.mode !== 'remote') throw new Error(`${name} runs on this PC: there is nothing to push`);
  const base = path.resolve(p.dir), skip = new Set([...c.syncExcludes, '.venv', 'node_modules']), started = Date.now();
  let list: string[] = [];
  if (files && files.length) {
    for (const f of files) {
      const full = path.resolve(base, String(f)); const rel = path.relative(base, full);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`"${f}" is not inside the program's folder`);
      if (rel.split(path.sep).some((s) => skip.has(s))) throw new Error(`"${f}" is in an excluded folder (${[...skip].join(', ')})`);
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error(`"${f}" is not a file in ${p.dir}`);
      list.push(rel.split(path.sep).join('/'));
    }
  } else {
    if (!p.synced) throw new Error(`${name} was moved before PC Bridge recorded when it was last copied: pass "files" (paths relative to its folder). After one push, "push" without files works.`);
    const since = p.synced;
    const walk = (dir: string, rel: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (skip.has(e.name)) continue; const full = path.join(dir, e.name), rp2 = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(full, rp2); else if (e.isFile() && fs.statSync(full).mtimeMs > since) list.push(rp2); } };
    walk(base, '');
  }
  if (!list.length) return `${name}: nothing changed since the last copy`;
  if (list.length > 5000) throw new Error(`${list.length} files changed: send the whole program again instead`);
  const dest = `${root(c)}\\apps\\${name}`, lf = path.join(os.tmpdir(), `pcb-push-${process.pid}-${started}.txt`);
  fs.writeFileSync(lf, list.join('\n') + '\n');
  try {
    const { sargs, ms, sx } = await bulkArgs(r);
    const line = `tar -czf - -C ${cq(base)} -T ${cq(lf)} | ${sx} ${sargs.map(cq).join(' ')} tar -xzf - -C ${dest}`;
    core.log('cmd', `$ ${line}`);
    const { code, err } = await runPipeline(line, Math.max(ms, 600000), 'push');
    if (code !== 0) throw new Error('push failed: ' + (err.trim().split('\n')[0] || 'exit ' + code));
  } finally { try { fs.unlinkSync(lf); } catch { /* temp file already gone */ } }
  p.synced = started; d.save();
  if (restart) await remoteStart(c, r, p);
  core.log('info', `[program ${name}] pushed ${list.length} file(s) to ${r.name}${restart ? ' and restarted it' : ''}`);
  return `${name}: ${list.length} file(s) sent to ${r.name}${restart ? ', program restarted' : ' (not restarted)'}: ${list.slice(0, 8).join(', ')}${list.length > 8 ? ', ...' : ''}`;
}

const spec =(c: core.Config, p: Program) => Buffer.from(JSON.stringify({ name: p.name, dir: `${root(c)}\\apps\\${p.name}`, cmd: p.cmd, env: p.env || {}, log: `${root(c)}\\logs\\${p.name}.log`, runDir: `${root(c)}\\run`, nodeDir: `${root(c)}\\tools\\node`, venv: runtimeOf(p) === 'python' ? `${root(c)}\\apps\\${p.name}\\.venv\\Scripts` : '', tmp: `${root(c)}\\tmp`, npmCache: `${root(c)}\\npm-cache` })).toString('base64');

export async function remoteStop(c: core.Config, r: core.Remote, p: Program): Promise<void> {
  const x = await core.psRemote(r, ps(c, `$f="$root\\run\\${p.name}.pid"; if(Test-Path $f){ $id=[int](Get-Content $f); $ErrorActionPreference='Continue'; & taskkill /PID $id /T /F 2>&1 | Out-Null; Remove-Item $f -Force -ErrorAction SilentlyContinue }; 'ok'`), { timeout: 30000 });
  if (x.code !== 0) throw fail('could not stop the remote copy', x);
}
export async function remoteStart(c: core.Config, r: core.Remote, p: Program): Promise<void> {
  await remoteStop(c, r, p);
  const x = await core.psRemote(r, ps(c, `$cl='"'+"$root\\tools\\node\\node.exe"+'" "'+"$root\\supervisor.js"+'" ${p.name} ${spec(c, p)}'
$res=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$cl; CurrentDirectory="$root"}
if($res.ReturnValue -ne 0){ throw ('could not start the supervisor, code ' + $res.ReturnValue) }; 'ok'`), { timeout: 30000 });
  if (x.code !== 0) throw fail('could not start the program on the remote', x);
}
export interface RemoteState { supervisor: boolean; portUp: boolean; node: boolean; owner?: string }
export async function remoteState(c: core.Config, r: core.Remote, p: Program): Promise<RemoteState> {
  const x = await core.psRemote(r, ps(c, `$f="$root\\run\\${p.name}.pid"; $s=$false; if(Test-Path $f){ $s=[bool](Get-Process -Id ([int](Get-Content $f)) -ErrorAction SilentlyContinue) }
$u=$false; try{ $t=New-Object Net.Sockets.TcpClient; $a=$t.BeginConnect('127.0.0.1',${p.port},$null,$null); $u=$a.AsyncWaitHandle.WaitOne(1500) -and $t.Connected; $t.Close() }catch{}
$o=''; if($u){ try{ $n=@(Get-NetTCPConnection -LocalPort ${p.port} -State Listen -ErrorAction Stop | Where-Object { $_.LocalAddress -in '127.0.0.1','0.0.0.0','::','::1' } | ForEach-Object { (Get-Process -Id $_.OwningProcess -ErrorAction Stop).ProcessName }); $o=$(if($n -match '^sshd?$'){ 'sshd' } else { $n | Select-Object -First 1 }) }catch{} }
"S=$s U=$u N=$(Test-Path "$root\\tools\\node\\node.exe") O=$o"`), { timeout: 20000, poll: true });
  // an ssh tunnel that squats on the port accepts connections too: that is not the program answering
  const owner = (/O=(\S*)/.exec(x.stdout) || [])[1] || '';
  return { supervisor: /S=True/.test(x.stdout), portUp: /U=True/.test(x.stdout) && !/^(sshd|ssh)$/i.test(owner), node: /N=True/.test(x.stdout), owner };
}
export async function remoteLog(c: core.Config, r: core.Remote, name: string): Promise<string> {
  if (!PROG_RE.test(name)) throw new Error('bad name');
  const x = await core.psRemote(r, ps(c, `$f="$root\\logs\\${name}.log"; if(Test-Path $f){ Get-Content $f -Tail 200 } else { '(no log yet)' }`), { timeout: 20000 });
  return x.stdout.replace(/#< CLIXML[\s\S]*/, '').trim();
}

export interface ProgramDeps { fwd: core.Forwarder; save: () => void; localPidOnPort: (port: number) => Promise<number | null>; relink?: () => void }
/** Move: prepare remote, copy, npm install (if package.json), start under the supervisor, wait for the port, forward localhost:port. Rolls back to "local" on failure. */
export async function moveProgram(c: core.Config, r: core.Remote, name: string, d: ProgramDeps, stopLocalPid?: number): Promise<string> {
  const p = (c.programs || []).find((x) => x.name === name); if (!p) throw new Error(`Unknown program "${name}"`);
  if (p.mode === 'remote') throw new Error('Already on the remote PC');
  const holder = await d.localPidOnPort(p.port);
  if (holder) {
    if (stopLocalPid !== holder) throw new Error(`Port ${p.port} is used by process ${holder} on this PC. Stop it (PC Bridge asks you first) so the forward can take its place.`);
    core.log('info', `[program ${name}] stopping local process ${holder} that holds port ${p.port} (you confirmed)`); core.killTree(holder);
    for (let i = 0; i < 20 && !(await core.portFree(p.port)); i++) await new Promise((res) => setTimeout(res, 500));
    if (!(await core.portFree(p.port))) throw new Error(`Port ${p.port} is still in use after stopping process ${holder}`);
  }
  const startedAt = Date.now();
  try {
    core.log('info', `[program ${name}] 1/5 preparing ${root(c)} on the remote`); await prepareRemote(c, r);
    await remoteStop(c, r, p).catch(() => 0);   // a stale copy still running there (after a failover or a crash loop) locks its venv and files
    // hand-copied folder: an empty file named .pcb-preseeded inside <root>\apps\<name> on the other PC means "already there"; used once, then removed
    let copied = ''; const mark = `${root(c)}\\apps\\${p.name}\\.pcb-preseeded`;
    const seeded = await core.psRemote(r, ps(c, `if(Test-Path -LiteralPath "${mark}"){ Remove-Item -LiteralPath "${mark}" -Force; 'seeded' } else { 'no' }`), { timeout: 60000 });
    if (seeded.stdout.includes('seeded')) core.log('info', `[program ${name}] 2/5 using the folder already copied by hand (.pcb-preseeded found)`);
    else { core.log('info', `[program ${name}] 2/5 copying ${p.dir}`); copied = await copyDir(c, r, p); }
    if (runtimeOf(p) === 'python') {
      core.log('info', `[program ${name}] 3/5 Python environment on the remote (uv, venv under ${root(c)})`); await preparePython(c, r);
      const x = await core.psRemote(r, ps(c, `$env:UV_CACHE_DIR="$root\\uv-cache"; $env:UV_PYTHON_INSTALL_DIR="$root\\python"; $uv="$root\\tools\\uv\\uv.exe"; $app="$root\\apps\\${p.name}"; Set-Location $app; $ErrorActionPreference='Continue'   # uv prints progress on stderr
$py="$app\\.venv\\Scripts\\python.exe"
$o=(& $uv venv "$app\\.venv" --python ${p.python || '3.12'} --managed-python --allow-existing 2>&1 | Out-String); if($LASTEXITCODE -ne 0){ throw ('uv venv failed (python ${p.python || '3.12'}): ' + ($o -replace '\\s+',' ')) }
${p.requirements
        ? `if(-not (Test-Path -LiteralPath "${p.requirements}")){ throw 'requirements file ${p.requirements} is not in the program folder' }
$o=(& $uv pip install -r "${p.requirements}" --python $py 2>&1 | Out-String); if($LASTEXITCODE -ne 0){ throw ('installing ${p.requirements} failed: ' + (($o -split "\`n" | ? { $_ -match 'error|No solution|not found|Because' } | select -First 4) -join ' | ')) }
if(Test-Path pyproject.toml){ $o=(& $uv pip install -e . --no-deps --python $py 2>&1 | Out-String); if($LASTEXITCODE -ne 0){ throw ('installing the project itself failed: ' + (($o -split "\`n" | ? { $_ -match 'error' } | select -First 3) -join ' | ')) } }`
        : `$o=''; if(Test-Path requirements.txt){ $o=(& $uv pip install -r requirements.txt --python $py 2>&1 | Out-String) } elseif(Test-Path pyproject.toml){ $o=(& $uv pip install -e . --python $py 2>&1 | Out-String) }
if($LASTEXITCODE -ne 0){ throw ('pip install failed: ' + (($o -split "\`n" | ? { $_ -match 'error|No solution|not found|Because' } | select -First 4) -join ' | ')) }`}
'ok'`), { timeout: 1200000, stream: true });
      if (x.code !== 0) throw fail('Python setup failed', x);
    } else if (fs.existsSync(path.join(p.dir, 'package.json'))) {
      core.log('info', `[program ${name}] 3/5 npm install on the remote`);
      const x = await core.psRemote(r, ps(c, `$env:PATH="$root\\tools\\node;"+$env:PATH; Set-Location "$root\\apps\\${p.name}"; $ErrorActionPreference='Continue'   # npm prints warnings (EBADENGINE...) on stderr: only its exit code counts
& "$root\\tools\\node\\npm.cmd" install --no-audit --no-fund${p.omitDev ? ' --omit=dev' : ''}${p.ignoreScripts ? ' --ignore-scripts' : ''} 2>&1 | Select-Object -Last 5; $c=$LASTEXITCODE${p.ignoreScripts ? `
if($c -eq 0){ & "$root\\tools\\node\\npm.cmd" run --if-present postinstall 2>&1 | Select-Object -Last 5; $c=$LASTEXITCODE }` : ''}
exit $c`), { timeout: 900000, stream: true });
      if (x.code !== 0) throw fail('npm install failed', x);
    }
    // the program now counts as being on the target: drop any reverse link that holds its port there, or it could never bind
    core.movingTo.set(name, r.name); d.relink?.(); await new Promise((res) => setTimeout(res, 1500));
    core.log('info', `[program ${name}] 4/5 starting on the remote`); await remoteStart(c, r, p);
    let up = false; for (let i = 0; i < 40 && !up; i++) { up = (await remoteState(c, r, p)).portUp; if (!up) await new Promise((res) => setTimeout(res, 1500)); }
    if (!up) throw new Error(`It started but nothing answers on port ${p.port} on the remote. Log:\n` + (await remoteLog(c, r, p.name).catch(() => '')).split('\n').slice(-8).join('\n'));
    core.log('info', `[program ${name}] 5/5 forwarding localhost:${p.port}`); await d.fwd.start(r, { name: p.name, localPort: p.port, remotePort: p.port, remoteHost: '127.0.0.1' });
    for (let i = 0; i < 20 && (await core.tcpProbe('127.0.0.1', p.port, 800)).ok === false; i++) await new Promise((res) => setTimeout(res, 400));
    p.mode = 'remote'; p.remote = r.name; p.synced = startedAt; d.save(); core.movingTo.delete(name); d.relink?.(); return `${name} now runs on ${r.name} (${root(c)}\\apps\\${name}); localhost:${p.port} goes there${seeded.stdout.includes('seeded') ? '' : '; copied over ' + copied}`;
  } catch (e) {
    core.movingTo.delete(name); d.relink?.();   // failed: the links that were dropped come back
    d.fwd.stop(p.port); await remoteStop(c, r, p).catch(() => 0);
    if (holder) core.log('err', `[program ${name}] failed; the local process I stopped (${holder}) is NOT restarted automatically - start it yourself or press "Bring back"`);
    throw e;
  }
}

/** Back to this PC: stop the forward and the remote copy, start the program here from its folder. */
export async function bringProgramHome(c: core.Config, r: core.Remote, name: string, d: ProgramDeps): Promise<string> {
  const p = (c.programs || []).find((x) => x.name === name); if (!p) throw new Error(`Unknown program "${name}"`);
  d.fwd.stop(p.port);
  await copyBack(c, r, p).then(() => core.log('info', `[program ${name}] files the program changed on the remote were copied back (newer files only)`), (e) => core.log('err', `[program ${name}] could not copy files back: ${e.message}`));
  await remoteStop(c, r, p).catch((e) => core.log('err', `[program ${name}] remote stop: ${e.message}`));
  for (let i = 0; i < 20 && !(await core.portFree(p.port)); i++) await new Promise((res) => setTimeout(res, 400));
  const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${p.cmd}"`], { cwd: p.dir, env: { ...process.env, ...(p.env || {}) }, detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
  child.on('error', (e) => core.log('err', `[program ${name}] could not start here: ${e.message}`)); child.unref(); p.mode = 'local'; d.save(); core.log('info', `[program ${name}] started on this PC: ${p.cmd}`);
  return `${name} runs on this PC again`;
}

/** Self test used by the Test buttons and the API: PASS/FAIL rows. */
export async function testProgram(c: core.Config, r: core.Remote, name: string): Promise<{ name: string; ok: boolean; detail: string; ms: number }[]> {
  const p = (c.programs || []).find((x) => x.name === name); if (!p) throw new Error(`Unknown program "${name}"`);
  const out: { name: string; ok: boolean; detail: string; ms: number }[] = []; const t = Date.now();
  const add = (n: string, ok: boolean, detail: string) => out.push({ name: n, ok, detail, ms: Date.now() - t });
  add('remote folder is not on C:', !/^c:/i.test(root(c)), root(c));
  add('local folder exists', fs.existsSync(p.dir), p.dir);
  if (p.mode === 'remote') {
    const s = await remoteState(c, r, p).catch(() => null);
    add('remote supervisor is running', !!s?.supervisor, s ? String(s.supervisor) : 'remote unreachable');
    add('program answers on the remote', !!s?.portUp, `127.0.0.1:${p.port} on the remote` + (s?.owner ? ` (held by ${s.owner})` : ''));
    add('localhost forward answers here', (await core.tcpProbe('127.0.0.1', p.port, 2000)).ok, `127.0.0.1:${p.port}`);
  } else add('runs on this PC', true, 'not moved');
  return out;
}

// ---------- updates: portable Node, uv, every program's libraries (all under <root>), plus a read-only look at the remote's apt packages ----------
export interface UpdateRow { name: string; current: string; latest: string; state: 'current' | 'outdated' | 'updated' | 'failed' | 'info'; detail: string }
const out1 = (x: core.RunResult) => x.stdout.replace(/#< CLIXML[\s\S]*/, '').trim();
const remotePrograms = (c: core.Config, r: core.Remote) => (c.programs || []).filter((p) => p.mode === 'remote' && core.remoteFor(c, p.remote).name === r.name);

/** apply=false: only report what is outdated. apply=true: update and restart the affected programs. Never touches anything outside <root> (apt is report-only). */
export async function updateRemote(c: core.Config, r: core.Remote, d: ProgramDeps, apply: boolean): Promise<UpdateRow[]> {
  const rows: UpdateRow[] = []; const row = (name: string, current: string, latest: string, state: UpdateRow['state'], detail = '') => rows.push({ name, current, latest, state, detail });
  const progs = remotePrograms(c, r); const touched = new Set<string>();
  // 1. Node: newest release of the SAME major version (a major jump is reported, never applied automatically)
  const n = await core.psRemote(r, ps(c, `$cur=(& "$root\\tools\\node\\node.exe" -v); $m=($cur -replace '^v(\\d+)\\..*','$1')
$idx=Invoke-RestMethod https://nodejs.org/dist/index.json -UseBasicParsing; $same=($idx | ? { $_.version -like "v$m.*" } | select -First 1).version; $newest=($idx | select -First 1).version
"$cur|$same|$newest"`), { timeout: 60000 });
  if (n.code === 0) {
    const [cur, same, newest] = out1(n).split('|'); const major = newest && same && newest.split('.')[0] !== same.split('.')[0];
    if (cur === same) row('Node (remote, portable)', cur, same, 'current', major ? `a newer major exists (${newest}); not applied automatically` : '');
    else if (!apply) row('Node (remote, portable)', cur, same, 'outdated');
    else {
      try {
        for (const p of progs) await remoteStop(c, r, p);
        const x = await core.psRemote(r, ps(c, `[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
$v='${same}'; $base="https://nodejs.org/dist/$v"; $zip="$root\\tools\\node-new.zip"
Invoke-WebRequest "$base/node-$v-win-x64.zip" -OutFile $zip -UseBasicParsing
$want=(((Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content -split "\`n") | ? { $_ -match "node-$v-win-x64.zip" } | select -First 1) -split '\\s+' | select -First 1
if((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $want.ToLower()){ Remove-Item $zip -Force; throw 'Node download failed its SHA-256 check' }
Remove-Item "$root\\tools\\_n" -Recurse -Force -ErrorAction SilentlyContinue; Expand-Archive $zip -DestinationPath "$root\\tools\\_n" -Force
Remove-Item "$root\\tools\\node.old" -Recurse -Force -ErrorAction SilentlyContinue; Rename-Item "$root\\tools\\node" 'node.old'
try { Move-Item "$root\\tools\\_n\\node-$v-win-x64" "$root\\tools\\node" } catch { Rename-Item "$root\\tools\\node.old" 'node'; throw }
Remove-Item "$root\\tools\\node.old","$root\\tools\\_n",$zip -Recurse -Force; (& "$root\\tools\\node\\node.exe" -v)`), { timeout: 600000 });
        if (x.code !== 0) throw fail('Node update failed', x);
        row('Node (remote, portable)', cur, same, 'updated', 'checksum verified'); progs.forEach((p) => touched.add(p.name));
      } catch (e: any) { row('Node (remote, portable)', cur, same, 'failed', e.message); progs.forEach((p) => touched.add(p.name)); }   // restart them either way (the old Node is restored on failure)
    }
  } else row('Node (remote, portable)', '?', '?', 'failed', fail('could not read the Node version', n).message);
  // 2. uv (only if Python was ever prepared)
  const uvv = await core.psRemote(r, ps(c, `$uv="$root\\tools\\uv\\uv.exe"; if(Test-Path $uv){ $ErrorActionPreference='Continue'; if(${apply ? '$true' : '$false'}){ & $uv self update 2>&1 | Out-Null }; (& $uv --version) } else { 'none' }`), { timeout: 120000 });
  if (out1(uvv) && out1(uvv) !== 'none') row('uv (Python tool)', out1(uvv), apply ? 'latest' : '(updated with "Update everything")', apply ? 'updated' : 'info');
  // 3. every program's libraries
  for (const p of progs) {
    const py = runtimeOf(p) === 'python'; const app = `$root\\apps\\${p.name}`;
    const x = await core.psRemote(r, ps(c, py
      ? `$ErrorActionPreference='Continue'; $env:UV_CACHE_DIR="$root\\uv-cache"; $env:UV_PYTHON_INSTALL_DIR="$root\\python"; $uv="$root\\tools\\uv\\uv.exe"; Set-Location "${app}"; $py="${app}\\.venv\\Scripts\\python.exe"
if(${apply ? '$true' : '$false'}){ if(Test-Path requirements.txt){ & $uv pip install -r requirements.txt --upgrade --python $py 2>&1 | Out-Null } }
$o=(& $uv pip list --outdated --python $py 2>&1 | Out-String); $cnt=(($o -split "\`n") | ? { $_ -match '^\\S+\\s+\\d' }).Count; "$cnt"`
      : `$ErrorActionPreference='Continue'; $env:PATH="$root\\tools\\node;"+$env:PATH; Set-Location "${app}"; if(-not (Test-Path package.json)){ '0'; exit }
if(${apply ? '$true' : '$false'}){ & "$root\\tools\\node\\npm.cmd" update --no-audit --no-fund 2>&1 | Out-Null }
$j=(& "$root\\tools\\node\\npm.cmd" outdated --json 2>$null | Out-String); if($j.Trim()){ ((($j | ConvertFrom-Json).PSObject.Properties) | measure).Count } else { 0 }`), { timeout: 900000 });
    const cnt = Number(out1(x).split('\n').pop()) || 0;
    if (x.code !== 0) row(`${p.name} libraries`, '', '', 'failed', fail('update check failed', x).message);
    else if (apply) { row(`${p.name} libraries`, '', '', 'updated', cnt ? `${cnt} still behind their allowed range` : 'up to date within the ranges in package.json / requirements.txt'); touched.add(p.name); }
    else row(`${p.name} libraries`, '', '', cnt ? 'outdated' : 'current', cnt ? `${cnt} package(s) can be updated` : '');
  }
  // 4. the supervisor script itself
  if (apply) { const s = await core.psRemote(r, ps(c, `[IO.File]::WriteAllBytes("$root\\supervisor.js",[Convert]::FromBase64String('${Buffer.from(SUPERVISOR).toString('base64')}')); 'ok'`), { timeout: 60000 }); row('PC Bridge supervisor', '', '', s.code === 0 ? 'updated' : 'failed', s.code === 0 ? '' : fail('write failed', s).message); }
  // 5. remote apt packages (Docker engine lives in WSL): report only, never applied from here
  const apt = await core.wslSh(r, 'apt-get -s upgrade 2>/dev/null | grep -c "^Inst" || true', { timeout: 60000 });
  const na = Number(apt.stdout.trim().split('\n').pop()); row('Linux packages in WSL (Docker engine)', '', '', 'info', Number.isFinite(na) ? (na ? `${na} upgradable (from the package list as of its last refresh) - update them inside WSL yourself: sudo apt update && sudo apt upgrade` : 'nothing upgradable in the cached list') : 'could not check');
  // restart the programs whose runtime or libraries changed
  for (const name of touched) {
    const p = progs.find((q) => q.name === name)!;
    try { await remoteStart(c, r, p); let up = false; for (let i = 0; i < 30 && !up; i++) { up = (await remoteState(c, r, p)).portUp; if (!up) await new Promise((res) => setTimeout(res, 1500)); } row(`${p.name} restarted`, '', '', up ? 'info' : 'failed', up ? 'answering again' : 'did not answer after the update - see its log'); }
    catch (e: any) { row(`${p.name} restarted`, '', '', 'failed', e.message); }
  }
  if (apply) { c.programsUpdatedAt = Date.now(); d.save(); }
  return rows;
}

const strikes = new Map<string, number>(); const polls = new Map<string, number>();
/** Called on every status poll. Remote reachable: keep the forward up and re-start a supervisor that vanished (remote reboot). Remote dead for 3 polls: run it on this PC (failover). */
export async function watchPrograms(c: core.Config, reachable: (r: core.Remote) => boolean | undefined, d: ProgramDeps): Promise<void> {
  for (const p of c.programs || []) {
    if (p.mode !== 'remote') continue;
    const r = core.remoteFor(c, p.remote); const sshOk = reachable(r); if (sshOk === undefined) continue;   // not probed yet
    if (!sshOk) {
      const n = (strikes.get(p.name) || 0) + 1; strikes.set(p.name, n);
      if (n >= 3 && p.failover !== false) { strikes.set(p.name, 0); core.log('err', `[program ${p.name}] remote unreachable for ${n} polls - starting it on this PC`); await bringProgramHome(c, r, p.name, d).catch((e) => core.log('err', `[program ${p.name}] failover failed: ${e.message}`)); }
      continue;
    }
    strikes.set(p.name, 0);
    const f = d.fwd.get(p.port); if (!f || f.state === 'stopped') d.fwd.start(r, { name: p.name, localPort: p.port, remotePort: p.port, remoteHost: '127.0.0.1' }).catch((e) => core.log('err', `[program ${p.name}] forward restart: ${e.message}`));
    const k = (polls.get(p.name) || 0) + 1; polls.set(p.name, k);
    if (k % 5 === 0) { const s = await remoteState(c, r, p).catch(() => null); if (s && !s.supervisor) { core.log('info', `[program ${p.name}] supervisor was gone on the remote (reboot?) - starting it again`); await remoteStart(c, r, p).catch((e) => core.log('err', `[program ${p.name}] restart failed: ${e.message}`)); } }
  }
}

/** ssh for big copies. Measured on this PC: Windows' own System32 ssh.exe reads a piped stream at 0.2 MB/s, Git-for-Windows' ssh at 30-88 MB/s.
 *  Uses Git's ssh when found (Program Files, or next to git.exe on PATH), else plain "ssh". Git's ssh takes the same options and key path. */
let fastSshCache: string | undefined;
function fastSsh(): string {
  if (fastSshCache !== undefined) return fastSshCache;
  const cands = [path.join(process.env.ProgramFiles || 'C:\Program Files', 'Git', 'usr', 'bin', 'ssh.exe'), ...(process.env.PATH || '').split(';').filter(Boolean).map((d) => path.join(d, '..', 'usr', 'bin', 'ssh.exe'))];
  const hit = cands.map((c) => path.normalize(c)).find((c) => fs.existsSync(c));
  return (fastSshCache = hit ? cq(hit) : 'ssh');
}
