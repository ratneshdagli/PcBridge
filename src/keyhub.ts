// PC Bridge's side of the key gateway (keygw.ts): start it, read its numbers for the "API keys" tab, test the keys, switch "start with Windows".
// The gateway is a separate process: PC Bridge only starts it (detached) and never holds a key.
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import { KEYGW_PORT, REMOTE_PORT, keygwDir, daysOf } from './keygw';

const keysFile = () => path.join(keygwDir(), 'keys.json');
const startupVbs = () => path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'PC-Bridge-KeyGateway.vbs');

function ask(p: string, method = 'GET', timeout = 3000): Promise<any> {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: KEYGW_PORT, path: p, method, timeout }, (res) => { let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve(null); } }); });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
    r.end();
  });
}

export const autostartOn = () => fs.existsSync(startupVbs());
const TASK = 'PCBridgeKeyGateway';
/** "Always on": a Startup shortcut (sign-in) plus a Task Scheduler job that runs it every minute. A second start finds the port taken and exits, so the job only matters when the gateway has died. */
export function setAutostart(on: boolean): boolean {
  const f = startupVbs();
  if (!on) { fs.rmSync(f, { force: true }); spawnSync('schtasks', ['/Delete', '/TN', TASK, '/F'], { windowsHide: true }); return false; }
  fs.writeFileSync(f, `' Starts the PC Bridge key gateway (Groq / Gemini keys) when you sign in, and every minute if it is not running. Switch it off in PC Bridge > API keys.\r\nCreateObject("WScript.Shell").Run """${process.execPath}"" ""${path.join(__dirname, 'keygw.js')}""", 0, False\r\n`);
  const t = spawnSync('schtasks', ['/Create', '/TN', TASK, '/TR', `wscript.exe "${f}"`, '/SC', 'MINUTE', '/MO', '1', '/F'], { windowsHide: true });
  if (t.status !== 0) console.error('key gateway watchdog task not created: ' + String(t.stderr || t.stdout).trim());
  return true;
}

/** Start the gateway as its own hidden process; it keeps running when PC Bridge closes. A second start finds the port taken and exits. */
export function start(): void {
  const dir = keygwDir(); fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, 'gw.log');
  try { if (fs.statSync(logFile).size > 1e6) fs.truncateSync(logFile, 0); } catch { /* no log yet */ }
  const fd = fs.openSync(logFile, 'a');
  spawn(process.execPath, [path.join(__dirname, 'keygw.js')], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true }).unref();
}
/** Called when PC Bridge starts: bring the gateway up if there are keys and nothing answers. */
export async function ensure(): Promise<void> { if (fs.existsSync(keysFile()) && !(await ask('/_health'))) start(); }

export async function status() {
  const live = await ask('/_stats');
  if (live) return { up: true, autostart: autostartOn(), hasKeys: true, port: KEYGW_PORT, ...live };
  let days: unknown[] = []; try { days = daysOf(JSON.parse(fs.readFileSync(path.join(keygwDir(), 'stats.json'), 'utf8')).days || {}); } catch { /* none yet */ }
  return { up: false, autostart: autostartOn(), hasKeys: fs.existsSync(keysFile()), keysFile: keysFile(), port: KEYGW_PORT, providers: { groq: [], gemini: [] }, clients: [], days };
}
export const check = async () => (await ask('/_check', 'POST', 120000)) ?? { error: 'the gateway is not running' };
// ---- remote access for the phone: Tailscale Funnel -> the gateway's token-protected listener (REMOTE_PORT). The token lives only in remote.json (user-only, outside the repo). ----
type Remote = { enabled?: boolean; token?: string; rpm?: number };
const remoteFile = () => path.join(keygwDir(), 'remote.json');
const readRemote = (): Remote => { try { return JSON.parse(fs.readFileSync(remoteFile(), 'utf8')); } catch { return {}; } };
function writeRemote(r: Remote) { fs.mkdirSync(keygwDir(), { recursive: true }); fs.writeFileSync(remoteFile(), JSON.stringify(r, null, 2)); spawnSync('icacls', [remoteFile(), '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(R,W)`], { windowsHide: true }); }
const newToken = () => 'pcb_' + crypto.randomBytes(24).toString('hex');
const tsExe = () => { const p = 'C:\\Program Files\\Tailscale\\tailscale.exe'; return fs.existsSync(p) ? p : 'tailscale'; };
function ts(args: string[]) { const r = spawnSync(tsExe(), args, { windowsHide: true, encoding: 'utf8', timeout: 20000 }); return { code: r.status, out: String((r.stdout || '') + (r.stderr || '')).trim() }; }
export function remoteStatus() {
  const r = readRemote(); let host = ''; try { host = JSON.parse(ts(['status', '--json']).out).Self.DNSName.replace(/\.$/, ''); } catch { /* tailscale not available */ }
  const f = ts(['funnel', 'status']).out;
  return { enabled: !!(r.enabled && r.token), hasToken: !!r.token, rpm: r.rpm || 120, host, url: host ? 'https://' + host : '', funnelOn: new RegExp(':' + REMOTE_PORT + '\\b').test(f) && /funnel on/i.test(f) };
}
export function remoteSet(on: boolean): { enabled: boolean; funnel: boolean; message: string } {
  const r = readRemote();
  if (!on) { r.enabled = false; writeRemote(r); const f = ts(['funnel', '--https=443', 'off']); return { enabled: false, funnel: false, message: f.out.slice(0, 200) }; }
  if (!r.token) r.token = newToken(); r.enabled = true; r.rpm ||= 120; writeRemote(r);
  const f = ts(['funnel', '--bg', String(REMOTE_PORT)]), link = /https:\/\/login\.tailscale\.com\S+/.exec(f.out)?.[0];
  return { enabled: true, funnel: f.code === 0, message: f.code === 0 ? 'on' : link ? 'Open this link once to allow Funnel for this PC, then switch remote access on again: ' + link : f.out.slice(0, 300) || 'the Tailscale tunnel did not start' };
}
export function remoteRotate(): boolean { const r = readRemote(); r.token = newToken(); writeRemote(r); return true; }
export const remoteToken = (): string => readRemote().token || '';
/** Show keys.json in Explorer (created empty if missing so there is something to open). */
export function reveal(): string {
  const f = keysFile(); fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({ groq: [], gemini: [] }, null, 2));
  spawn('explorer.exe', ['/select,' + f], { detached: true, stdio: 'ignore' }).unref(); return f;
}
