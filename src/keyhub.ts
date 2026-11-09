// PC Bridge's side of the key gateway (keygw.ts): start it, read its numbers for the "API keys" tab, test the keys, switch "start with Windows".
// The gateway is a separate process: PC Bridge only starts it (detached) and never holds a key.
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { spawn } from 'child_process';
import { KEYGW_PORT, keygwDir, daysOf } from './keygw';

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
export function setAutostart(on: boolean): boolean {
  const f = startupVbs();
  if (!on) { fs.rmSync(f, { force: true }); return false; }
  fs.writeFileSync(f, `' Starts the PC Bridge key gateway (Groq / Gemini keys) when you sign in. Delete this file to stop that.\r\nCreateObject("WScript.Shell").Run """${process.execPath}"" ""${path.join(__dirname, 'keygw.js')}""", 0, False\r\n`);
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
/** Show keys.json in Explorer (created empty if missing so there is something to open). */
export function reveal(): string {
  const f = keysFile(); fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({ groq: [], gemini: [] }, null, 2));
  spawn('explorer.exe', ['/select,' + f], { detached: true, stdio: 'ignore' }).unref(); return f;
}
