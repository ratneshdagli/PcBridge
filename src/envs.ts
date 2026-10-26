// Global envs: finds .env files on this PC (and in the PC Bridge folder of the other PCs) so every environment variable can be read in one place.
// Values live in memory only for the answer: nothing is written to disk, nothing is cached, nothing is sent anywhere, and the local API never serves them.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import * as core from './core';
import * as programs from './programs';

export interface EnvVar { key: string; value: string; line: number }
export interface EnvFile { pc: string; path: string; dir: string; folder: string; name: string; kind: 'example' | 'file'; size: number; mtime: number; vars: EnvVar[]; text: string }
export interface EnvScan { files: EnvFile[]; scannedDirs: number; ms: number; truncated: boolean; notes: string[] }

const NAME_RE = /^(?!gradlew\.env$)(?:\.env(?:\..+)?|.+\.env)$/i;   // .env  .env.local  .env.production  prod.env  (not gradlew.env: Android build output)
const EXAMPLE_RE = /example|sample|template|dist/i;               // .env.example: the shape of the file, not real values
const MAX_FILE = 256 * 1024, MAX_FILES = 1500, MAX_MS = 90000, MAX_DEPTH = 9, PARALLEL = 16;
// tool caches, not anyone's own settings: Claude's plugin/project caches
const SKIP_PATH = /\\\.claude\\(plugins|projects|file-history|shell-snapshots)(\\|$)/i;
// folders that never hold a project's own settings (dependencies, caches, build output, Windows itself). A folder called env/.env is a Python virtualenv.
const SKIP = new Set(['node_modules', '.git', '.hg', '.svn', '.venv', 'venv', 'env', '.env', '__pycache__', 'site-packages', '.next', '.nuxt', '.turbo', 'dist', 'build', 'target', 'coverage', '.tox', '.cache', '.gradle', '.m2', '.npm', '.cargo', '.rustup', '.docker', '.ollama', 'anaconda3', 'miniconda3',
  'appdata', 'windows', 'program files', 'program files (x86)', 'programdata', '$recycle.bin', 'system volume information', '$winreagent', 'recovery', 'onedrivetemp', 'perflogs', 'wsl',
  'ephemeral', '.dart_tool', '.symlinks', 'pods', '.pub-cache', 'vendor']);   // Flutter / Dart / PHP generated folders (their *.env files are build output)
const win = path.win32;

/** KEY=VALUE lines (also "export KEY=VALUE", quotes, trailing # comments). ponytail: a value spread over several lines is read as its first line only. */
export function parseEnv(text: string): EnvVar[] {
  const out: EnvVar[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const l = raw.trim(); if (!l || l.startsWith('#')) return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(l); if (!m) return;
    let v = m[2]; const q = v[0];
    if ((q === '"' || q === "'") && v.lastIndexOf(q) > 0) v = v.slice(1, v.lastIndexOf(q)); else v = v.replace(/\s+#.*$/, '');
    out.push({ key: m[1], value: v, line: i + 1 });
  });
  return out;
}

const make = (pc: string, full: string, size: number, mtime: number, text: string): EnvFile => {
  const dir = win.dirname(full), name = win.basename(full);
  return { pc, path: full, dir, folder: win.basename(dir) || dir, name, kind: EXAMPLE_RE.test(name) ? 'example' : 'file', size, mtime, vars: parseEnv(text), text };
};

interface State { pc: string; files: EnvFile[]; seen: Set<string>; dirs: number; t0: number; truncated: boolean; stop: boolean; notes: string[] }
/** Reads one folder: queues its sub folders, reads its env files. */
async function visit(dir: string, depth: number, st: State, queue: [string, number][]): Promise<void> {
  if (st.stop) return;
  if (Date.now() - st.t0 > MAX_MS) { st.truncated = st.stop = true; return; }
  const key = dir.toLowerCase(); if (st.seen.has(key)) return; st.seen.add(key);
  let ents: fs.Dirent[]; try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }   // no access: skip
  st.dirs++;
  for (const e of ents) {
    if (st.stop) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < MAX_DEPTH && !SKIP.has(e.name.toLowerCase()) && !SKIP_PATH.test(full)) queue.push([full, depth + 1]); }   // symlinks/junctions are not followed
    else if (e.isFile() && NAME_RE.test(e.name)) {
      if (st.files.length >= MAX_FILES) { st.truncated = st.stop = true; return; }
      try {
        const s = await fs.promises.stat(full);
        if (s.size > MAX_FILE) { st.notes.push(`skipped ${full}: ${Math.round(s.size / 1024)} KB is too big for an env file`); continue; }
        st.files.push(make(st.pc, full, s.size, s.mtimeMs, (await fs.promises.readFile(full, 'utf8')).replace(/^\uFEFF/, '')));
      } catch { /* unreadable: skip */ }
    }
  }
}
/** Walks all roots with a few folders read at the same time (a disk with tens of thousands of folders takes minutes one by one). */
function walkAll(roots: string[], st: State): Promise<void> {
  const queue: [string, number][] = roots.slice().reverse().map((r) => [r, 0]); let active = 0;
  return new Promise<void>((done) => {
    const pump = () => {
      while (active < PARALLEL && queue.length && !st.stop) { const [d, depth] = queue.pop()!; active++; visit(d, depth, st, queue).finally(() => { active--; pump(); }); }
      if (!active && (!queue.length || st.stop)) done();
    };
    pump();
  });
}

/** Existing drive letters except C: (C: is covered through the user's own folder; Windows and Program Files hold no project settings). */
async function drives(): Promise<string[]> {
  const out: string[] = [];
  await Promise.all('DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async (l) => {
    try { await Promise.race([fs.promises.statfs(`${l}:\\`), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 1500))]); out.push(`${l}:\\`); } catch { /* no such drive (or asleep) */ }
  }));
  return out.sort();
}

const REMOTE_PS = String.raw`$ProgressPreference='SilentlyContinue'
$r='%ROOT%'
$f=@(Get-ChildItem -LiteralPath $r -Recurse -Force -File -Depth 5 -ErrorAction SilentlyContinue | ?{ $_.Name -match '^\.env(\..+)?$|\.env$' -and $_.Length -le 262144 -and $_.FullName -notmatch '\\(node_modules|\.venv|\.git|__pycache__)\\' } | select -First 300)
$o=@($f | %{ [pscustomobject]@{ path=$_.FullName; size=$_.Length; mtime=$_.LastWriteTimeUtc.ToString('o'); b64=[Convert]::ToBase64String([IO.File]::ReadAllBytes($_.FullName)) } })
'__ENV__'+(ConvertTo-Json -Compress -Depth 3 -InputObject $o)`;

async function scanRemote(c: core.Config, r: core.Remote): Promise<EnvFile[]> {
  const root = programs.root(c) + '\\apps';
  // poll:true keeps the file contents out of the command log (the log is readable through the API)
  const x = await core.psRemote(r, REMOTE_PS.replace('%ROOT%', root), { timeout: 60000, poll: true });
  const line = x.stdout.split('\n').find((l) => l.startsWith('__ENV__'));
  if (!line) throw new Error(`${r.name}: no answer (${(x.stderr || (x.timedOut ? 'timed out' : 'exit ' + x.code)).split('\n')[0]})`);
  // contents travel as base64: PowerShell 5.1's JSON writer leaves some control characters unescaped
  const arr = JSON.parse(line.trim().slice(7)) as { path: string; size: number; mtime: string; b64: string }[];
  return arr.map((f) => make(r.name, f.path, f.size, Date.parse(f.mtime) || 0, Buffer.from(String(f.b64 || ''), 'base64').toString('utf8').replace(/^\uFEFF/, '')));
}

let known = new Set<string>();   // local paths of the last scan: the only ones "Open folder" will accept
export async function scanEnvs(c: core.Config, remotes: core.Remote[], opt: { extra?: unknown; includeRemote?: boolean } = {}): Promise<EnvScan> {
  const t0 = Date.now(); const notes: string[] = [];
  const extra = (Array.isArray(opt.extra) ? opt.extra : []).map(String).map((s) => s.trim()).filter(Boolean);
  for (const x of extra) if (x.length > 260 || !path.isAbsolute(x) || !fs.existsSync(x)) throw new Error(`"${x}" is not a folder on this PC (use a full path like D:\\code)`);
  const roots = [...extra, ...(c.programs || []).filter((p) => p.mode !== 'remote').map((p) => p.dir), ...(c.projects || []).map((p) => p.path).filter(Boolean), os.homedir(), ...(await drives())];
  const st: State = { pc: 'this PC', files: [], seen: new Set(), dirs: 0, t0, truncated: false, stop: false, notes };
  await walkAll(roots.filter((r) => fs.existsSync(r)), st);
  known = new Set(st.files.map((f) => f.path));
  const files = [...st.files];
  if (opt.includeRemote !== false) for (const r of remotes) { try { files.push(...(await scanRemote(c, r))); } catch (e: any) { notes.push(String(e.message || e).split('\n')[0]); } }
  files.sort((a, b) => a.folder.toLowerCase().localeCompare(b.folder.toLowerCase()) || a.dir.localeCompare(b.dir) || a.name.localeCompare(b.name));
  return { files, scannedDirs: st.dirs, ms: Date.now() - t0, truncated: st.truncated, notes };
}

/** Show a file from the last scan in Explorer. Only paths the scan returned are accepted. */
export function revealEnv(p: string): string {
  if (!known.has(p)) throw new Error('That file was not in the last scan: scan again first');
  spawn('explorer.exe', ['/select,' + p], { detached: true, stdio: 'ignore' }).unref();
  return 'opened ' + win.dirname(p);
}
