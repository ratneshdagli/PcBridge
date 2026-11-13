// Key gateway: ONE local door for Groq and Gemini API calls.
// A program calls http://127.0.0.1:8795/<groq|gemini>/<program-name>/<the normal path> with no key. The gateway adds a key from the pool,
// moves to the next account when one hits a limit, and counts every call per day, per account and per program.
// It is its own process (PC Bridge only starts it and shows its numbers), so the keys keep working when PC Bridge is closed.
// Only the two fixed provider hosts are ever contacted, only from this PC (loopback), and a key never appears in any answer or log line.
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';

export type Provider = 'groq' | 'gemini';
export const PROVIDERS: Provider[] = ['groq', 'gemini'];
export const KEYGW_PORT = 8795;
const HOSTS: Record<Provider, string> = { groq: 'https://api.groq.com', gemini: 'https://generativelanguage.googleapis.com' };
export const keygwDir = () => path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'pc-bridge', 'keygw');

export interface Cnt { req: number; ok: number; limited: number; err: number; tok: number }
export interface Day { keys: Record<string, Cnt>; clients: Record<string, Cnt>; pairs: Record<string, Cnt> }
interface Rec { provider: Provider; label: string; key: string; cool: Map<string, { until: number; why: string }> }   // cool: model (or "*" for the whole key) -> until when it is skipped
export interface Opts { port?: number; dir?: string; hosts?: Partial<Record<Provider, string>>; log?: (s: string) => void; firstByteMs?: number; budgetMs?: number }

const blank = (): Cnt => ({ req: 0, ok: 0, limited: 0, err: 0, tok: 0 });
const ymd = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;   // this PC's day: what "per day" means on the dashboard
function bump(m: Record<string, Cnt>, k: string, o: 'ok' | 'limited' | 'err', tok = 0) { const c = (m[k] ||= blank()); c.req++; c[o]++; c.tok += tok; }
/** The last `n` days, newest first, with per-provider totals (what the dashboard's history table shows). */
export function daysOf(days: Record<string, Day>, n = 14) {
  return Object.keys(days).sort().slice(-n).reverse().map((date) => {
    const row: Record<string, unknown> = { date };
    for (const p of PROVIDERS) { const t = blank(); for (const [k, c] of Object.entries(days[date].keys)) if (k.startsWith(p + '/')) { t.req += c.req; t.ok += c.ok; t.limited += c.limited; t.err += c.err; t.tok += c.tok; } row[p] = t; }
    return row;
  });
}
/** When the provider's daily quota starts over: Groq at 00:00 UTC, Gemini at midnight Pacific (about 08:00 UTC). */
const nextReset = (p: Provider) => { const n = new Date(), t = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), p === 'gemini' ? 8 : 0); return t > Date.now() + 60000 ? t : t + 86400000; };
const DROP = new Set(['host', 'connection', 'content-length', 'authorization', 'x-goog-api-key', 'x-api-key', 'accept-encoding', 'transfer-encoding', 'keep-alive', 'upgrade', 'expect']);
const BODY_LIMIT = 32 * 1024 * 1024;

export async function startGateway(o: Opts = {}) {
  const dir = o.dir || keygwDir(); fs.mkdirSync(dir, { recursive: true });
  const keysFile = path.join(dir, 'keys.json'), statsFile = path.join(dir, 'stats.json');
  const hosts: Record<Provider, string> = { ...HOSTS, ...(o.hosts || {}) };
  const log = o.log || ((s: string) => console.log(new Date().toISOString().slice(11, 19) + ' ' + s));
  const agent = new https.Agent({ keepAlive: true, maxSockets: 64 });
  const FIRST_BYTE_MS = o.firstByteMs ?? (Number(process.env.KEYGW_FIRST_BYTE_MS) || 25000);   // a key that has not started answering by then is skipped (streams send headers at once)
  const SMALL_FIRST_BYTE_MS = Number(process.env.KEYGW_SMALL_FIRST_BYTE_MS) || 12000;           // same, for small requests (under 16 KB), e.g. a voice assistant's short question
  const seenModels: Record<Provider, Set<string>> = { groq: new Set(), gemini: new Set() };      // models callers asked for, so /_models can say how many accounts can serve each right now
  const BUDGET_MS = o.budgetMs ?? (Number(process.env.KEYGW_BUDGET_MS) || 45000);              // after this much total time no further account is tried: the caller gets the error and can fall back
  const startedAt = Date.now();

  // ---- keys: re-read when the file changes, so adding or removing an account needs no restart ----
  let pool: Record<Provider, Rec[]> = { groq: [], gemini: [] }, keysMtime = 0, keysChecked = 0;
  function loadKeys() {
    if (Date.now() - keysChecked < 2000) return; keysChecked = Date.now();
    let st: fs.Stats; try { st = fs.statSync(keysFile); } catch { return; }
    if (st.mtimeMs === keysMtime) return; keysMtime = st.mtimeMs;
    try {
      const j = JSON.parse(fs.readFileSync(keysFile, 'utf8').replace(/^﻿/, '')), next: Record<Provider, Rec[]> = { groq: [], gemini: [] };
      for (const p of PROVIDERS) for (const k of Array.isArray(j[p]) ? j[p] : []) {
        if (typeof k?.label !== 'string' || typeof k?.key !== 'string' || k.key.trim().length < 8) continue;
        const key = k.key.trim(), label = k.label.slice(0, 60), old = pool[p].find((x) => x.label === label && x.key === key);
        next[p].push(old || { provider: p, label, key, cool: new Map() });
      }
      pool = next; log(`keys loaded: groq ${pool.groq.length}, gemini ${pool.gemini.length}`);
    } catch (e: any) { log('keys.json unreadable: ' + e.message); }
  }

  // ---- numbers: kept in memory, saved every few seconds, 45 days ----
  let stats: { days: Record<string, Day> } = { days: {} }, dirty = false;
  try { stats = JSON.parse(fs.readFileSync(statsFile, 'utf8')); if (!stats.days) stats = { days: {} }; } catch { /* first run */ }
  const today = () => (stats.days[ymd()] ||= { keys: {}, clients: {}, pairs: {} });
  function save() {
    if (!dirty) return; dirty = false;
    for (const d of Object.keys(stats.days).sort().slice(0, -45)) delete stats.days[d];
    try { fs.writeFileSync(statsFile + '.tmp', JSON.stringify(stats)); fs.renameSync(statsFile + '.tmp', statsFile); } catch (e: any) { log('stats not saved: ' + e.message); }
  }
  const saver = setInterval(save, 5000); saver.unref();

  // ---- choosing and cooling keys ----
  const waitOf = (k: Rec, model: string) => Math.max(k.cool.get('*')?.until ?? 0, k.cool.get(model)?.until ?? 0);
  /** The usable key with the fewest calls today (spreads the load, so per-minute limits are hit later). */
  function pick(p: Provider, model: string, tried: Set<Rec>): Rec | undefined {
    const now = Date.now(), d = today().keys;
    return pool[p].filter((k) => !tried.has(k) && waitOf(k, model) <= now).sort((a, b) => (d[`${p}/${a.label}`]?.req ?? 0) - (d[`${p}/${b.label}`]?.req ?? 0))[0];
  }
  function cool(k: Rec, st: number, model: string, h: http.IncomingHttpHeaders, text: string) {
    if (st !== 429) { k.cool.set('*', { until: Date.now() + 600000, why: st === 401 ? 'key rejected (401)' : 'key refused (403)' }); return; }   // retried after 10 min, in case it was a blip
    const t = text.toLowerCase(), daily = /per ?day|daily|\brpd\b|\btpd\b/.test(t), hdr = Number(h['retry-after']), body = /"retrydelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(t);
    let ms = daily ? (hdr > 0 ? hdr * 1000 : nextReset(k.provider) - Date.now()) : hdr > 0 ? hdr * 1000 : body ? Number(body[1]) * 1000 : 60000;
    ms = Math.min(Math.max(ms, 1000), 26 * 3600000);
    k.cool.set(model, { until: Date.now() + ms, why: daily ? 'daily limit' : 'rate limit' });
  }

  /** Skip this account for this model for a while (a provider-side problem, not a limit of ours). */
  const rest = (k: Rec, model: string, ms: number, why: string) => k.cool.set(model, { until: Date.now() + ms, why });
  function call(p: Provider, k: Rec, method: string, upPath: string, hdrs: http.OutgoingHttpHeaders, body: Buffer, firstByte = FIRST_BYTE_MS): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      const u = new URL(hosts[p]), auth = p === 'gemini' && !upPath.startsWith('/v1beta/openai') ? { 'x-goog-api-key': k.key } : { authorization: 'Bearer ' + k.key };
      const r = (u.protocol === 'http:' ? http : https).request({ hostname: u.hostname, port: u.port ? Number(u.port) : undefined, path: upPath, method, agent: u.protocol === 'http:' ? undefined : agent, timeout: 180000,
        headers: { ...hdrs, host: u.host, 'accept-encoding': 'identity', 'content-length': body.length, ...auth } }, (res) => { clearTimeout(slow); resolve(res); });
      const slow = setTimeout(() => r.destroy(new Error(`no answer within ${Math.round(firstByte / 1000)}s`)), firstByte);
      r.on('error', (e) => { clearTimeout(slow); reject(e); }); r.on('timeout', () => r.destroy(new Error('upstream timeout')));
      r.end(body);
    });
  }
  const readText = (r: http.IncomingMessage, max: number) => new Promise<string>((resolve) => { let s = ''; r.setEncoding('utf8'); r.on('data', (c) => { if (s.length < max) s += c; }); r.on('end', () => resolve(s)); r.on('error', () => resolve(s)); });
  const send = (res: http.ServerResponse, code: number, body: unknown, extra: http.OutgoingHttpHeaders = {}) => { if (res.headersSent) { res.end(); return; } res.writeHead(code, { 'content-type': 'application/json', ...extra }); res.end(JSON.stringify(body)); };

  function view() {
    const d = today(), now = Date.now(), providers: Record<string, unknown[]> = {};
    for (const p of PROVIDERS) providers[p] = pool[p].map((k) => {
      const cools = [...k.cool].filter(([, v]) => v.until > now).map(([model, v]) => ({ model, until: v.until, why: v.why }));
      return { label: k.label, state: cools.some((c) => c.model === '*') ? 'rejected' : cools.length ? 'cooling' : 'ready', cool: cools, ...(d.keys[`${p}/${k.label}`] || blank()) };
    });
    const clients = Object.entries(d.clients).map(([k, c]) => {
      const [client, provider] = k.split('|');
      const accounts = Object.entries(d.pairs).filter(([pk]) => pk.startsWith(client + '|' + provider + '/')).map(([pk, pc]) => ({ label: pk.slice(client.length + provider.length + 2), req: pc.req }));
      return { client, provider, ...c, accounts };
    }).sort((a, b) => b.req - a.req);
    const models: Record<string, unknown[]> = {};
    for (const p of PROVIDERS) models[p] = [...seenModels[p]].map((m) => ({ model: m, usable: pool[p].filter((k) => waitOf(k, m) <= now).length, total: pool[p].length }));
    return { now, date: ymd(), models, port: (server.address() as any)?.port, pid: process.pid, startedAt, keysFile, providers, clients, days: daysOf(stats.days) };
  }

  async function check() {
    const out: Record<string, unknown>[] = [];
    for (const p of PROVIDERS) for (const k of pool[p]) {
      try {
        const r = await call(p, k, 'GET', p === 'groq' ? '/openai/v1/models' : '/v1beta/models?pageSize=1', {}, Buffer.alloc(0)), st = r.statusCode || 0, text = st < 300 ? '' : await readText(r, 400);
        if (st < 300) r.resume();
        out.push({ provider: p, label: k.label, status: st, ok: st < 300, ...(text ? { message: text.split(k.key).join('[key]').slice(0, 200) } : {}) });
      } catch (e: any) { out.push({ provider: p, label: k.label, status: 0, ok: false, message: e.message }); }
    }
    return out;
  }

  const server = http.createServer(async (req, res) => {
    try {
      // only programs on this PC: a web page in a browser (it sends Origin) or a rebinding trick (odd Host) is refused
      if (req.headers.origin || !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(req.headers.host || ''))) return send(res, 403, { error: 'local programs only' });
      loadKeys();
      const url = new URL(req.url || '/', 'http://x'), parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === '_health') return send(res, 200, { ok: true });
      if (parts[0] === '_stats') return send(res, 200, view());
      if (parts[0] === '_models') return send(res, 200, view().models);   // per provider: model -> how many accounts can serve it right now
      if (parts[0] === '_check' && req.method === 'POST') return send(res, 200, await check());
      const p = parts[0] as Provider, who = (parts[1] || '').toLowerCase();
      if (!PROVIDERS.includes(p) || !/^[a-z0-9._-]{1,40}$/.test(who)) return send(res, 404, { error: 'use /groq/<program-name>/... or /gemini/<program-name>/... (the rest is the provider\'s normal path)' });
      if (!pool[p].length) return send(res, 503, { error: { message: `no ${p} keys in ${keysFile}`, type: 'keygw_no_keys' } });

      const chunks: Buffer[] = []; let n = 0;
      for await (const c of req) { n += (c as Buffer).length; if (n > BODY_LIMIT) return send(res, 413, { error: 'request too large' }); chunks.push(c as Buffer); }
      const body = Buffer.concat(chunks), q = new URLSearchParams(url.search); q.delete('key');
      const upPath = '/' + parts.slice(2).join('/') + (q.toString() ? '?' + q.toString() : '');
      let model = '*'; const m = /models\/([^:/?]+)/.exec(upPath);
      if (m) model = decodeURIComponent(m[1]); else if (body.length && body.length < 8e6 && /json/.test(String(req.headers['content-type']))) { try { model = String(JSON.parse(body.toString('utf8')).model || '*'); } catch { /* not JSON */ } }
      if (model !== '*' && model.length <= 80 && seenModels[p].size < 60) seenModels[p].add(model);
      const hdrs: http.OutgoingHttpHeaders = {}; for (const [k, v] of Object.entries(req.headers)) if (!DROP.has(k)) hdrs[k] = v;

      const tried = new Set<Rec>(), t0 = Date.now(); let last: { status: number; headers: http.IncomingHttpHeaders; text: string } | null = null, failure = '';
      for (;;) {
        if (Date.now() - t0 > BUDGET_MS) { log(`${p} ${who}: time budget used up (${model})`); break; }
        const k = pick(p, model, tried); if (!k) break; tried.add(k);
        let up: http.IncomingMessage;
        // a small request should start answering quickly, and no attempt may run past the total budget
        const wait = Math.max(1000, Math.min(body.length < 16384 ? Math.min(FIRST_BYTE_MS, SMALL_FIRST_BYTE_MS) : FIRST_BYTE_MS, BUDGET_MS - (Date.now() - t0)));
        try { up = await call(p, k, req.method || 'GET', upPath, hdrs, body, wait); }
        catch (e: any) { rest(k, model, 30000, 'no answer'); bump(today().keys, `${p}/${k.label}`, 'err'); dirty = true; failure = e.message; log(`${p} ${who} ${k.label}: ${e.message} -> next account`); continue; }
        const st = up.statusCode || 502, d = today();
        if (st === 429 || st === 401 || st === 403) {   // this account cannot serve it right now: remember why, try the next one
          const text = await readText(up, 65536); cool(k, st, model, up.headers, text);
          bump(d.keys, `${p}/${k.label}`, st === 429 ? 'limited' : 'err'); dirty = true; last = { status: st, headers: up.headers, text };
          log(`${p} ${who} ${st} on ${k.label} (${model}) -> next account`); continue;
        }
        if (st >= 500 && st !== 501 || st === 404) {   // provider trouble (overloaded) or "this model is not available to this account": try another account, and skip this one for this model for a while
          const text = await readText(up, 65536), gone = st === 404 && /no longer available|not available|not supported|not found for api version/i.test(text);
          if (st === 404 && !gone) { res.writeHead(404, { 'content-type': String(up.headers['content-type'] || 'application/json') }); res.end(text); bump(d.clients, `${who}|${p}`, 'err'); dirty = true; return; }   // a plain not-found (bad path): not an account problem
          rest(k, model, gone ? 6 * 3600000 : st === 503 ? 15000 : 30000, gone ? 'model not available to this account' : `provider error ${st}`);
          bump(d.keys, `${p}/${k.label}`, 'err'); dirty = true; last = { status: st, headers: up.headers, text };
          log(`${p} ${who} ${st} on ${k.label} (${model}) -> next account`); continue;
        }
        const out = { ...up.headers }; delete out['connection']; delete out['keep-alive']; delete out['transfer-encoding'];
        res.writeHead(st, out);
        let tail = '', done = false;   // token totals sit at the end of the answer (JSON body or the last stream event)
        up.on('data', (c: Buffer) => { tail = (tail + c.toString('latin1')).slice(-16384); });
        const fin = () => {
          if (done) return; done = true;
          const t = [...tail.matchAll(/"(?:total_tokens|totalTokenCount)"\s*:\s*(\d+)/g)].pop(), tok = t ? Number(t[1]) : 0, o2 = st < 400 ? 'ok' : 'err', dd = today();
          bump(dd.keys, `${p}/${k.label}`, o2, tok); bump(dd.clients, `${who}|${p}`, o2, tok); bump(dd.pairs, `${who}|${p}/${k.label}`, o2, tok); dirty = true;
          log(`${p} ${who} ${st} ${model} via ${k.label} ${Date.now() - t0}ms${tok ? ' ' + tok + ' tok' : ''}`);
        };
        up.on('end', fin); res.on('close', () => { fin(); up.destroy(); });
        up.pipe(res); return;
      }
      // every account is cooling or failed
      if (!last && failure) { bump(today().clients, `${who}|${p}`, 'err'); dirty = true; return send(res, 504, { error: { message: `${p} did not answer: ${failure}`, type: 'keygw_upstream' } }); }
      const dd = today(), soon = Math.max(1, Math.ceil((Math.min(...pool[p].map((k) => waitOf(k, model))) - Date.now()) / 1000));
      bump(dd.clients, `${who}|${p}`, last && last.status !== 429 ? 'err' : 'limited'); dirty = true;
      log(`${p} ${who}: all ${pool[p].length} accounts limited (${model}), first free in ${soon}s`);
      if (last) { res.writeHead(last.status, { 'content-type': String(last.headers['content-type'] || 'application/json'), 'retry-after': String(soon) }); res.end(last.text); return; }   // the provider's own answer, so the caller sees the real reason
      return send(res, 429, { error: { message: `all ${pool[p].length} ${p} accounts are cooling down; first one is free again in ${soon}s`, type: 'keygw_exhausted' } }, { 'retry-after': String(soon) });
    } catch (e: any) { log('error: ' + e.message); send(res, 500, { error: e.message }); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(o.port ?? KEYGW_PORT, '127.0.0.1', () => resolve()); });
  loadKeys(); log(`key gateway on http://127.0.0.1:${(server.address() as any).port}  (keys: ${keysFile})`);
  return { port: (server.address() as any).port as number, stats: view, check, close: () => new Promise<void>((r) => { clearInterval(saver); dirty = true; save(); agent.destroy(); server.close(() => r()); server.closeAllConnections?.(); }) };
}

if (require.main === module) {
  startGateway({ port: Number(process.env.KEYGW_PORT) || KEYGW_PORT }).catch((e) => { if (e.code !== 'EADDRINUSE') console.error('key gateway: ' + e.message); process.exit(e.code === 'EADDRINUSE' ? 0 : 1); });   // already running: nothing to do
  process.on('uncaughtException', (e) => console.error('uncaught: ' + e.message));
}
