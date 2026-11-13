// Offline check of the key gateway: a fake provider answers 429 / 401 / 200 and we verify rotation, cooling, counts and that no key ever leaks.
// Run: node dist/test/keygw.js   (uses fake keys and a temp folder only)
import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { startGateway } from '../src/keygw';

const hit = (port: number, p: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise<{ status: number; text: string }>((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method: o.method || 'GET', headers: o.headers }, (res) => { let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => resolve({ status: res.statusCode || 0, text: s })); });
  r.on('error', reject); r.end(o.body);
});

(async () => {
  const seen: { url: string; key: string }[] = [];
  const fake = http.createServer((req, res) => {
    const key = String(req.headers['x-goog-api-key'] || '').trim() || String(req.headers.authorization || '').replace('Bearer ', ''); seen.push({ url: req.url || '', key });
    req.resume(); req.on('end', () => {
      if (key === 'gsk_limited_aaaaaaaa') { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120', 'x-ratelimit-remaining-tokens': '0' }); res.end('{"error":{"message":"Rate limit reached on tokens per day (TPD)"}}'); return; }
      if (key === 'gsk_rejected_bbbbbbbb') { res.writeHead(401); res.end('{"error":"bad key"}'); return; }
      if (key === 'gsk_busy_eeeeeeee') { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":{"message":"This model is currently experiencing high demand"}}'); return; }
      if (key === 'gsk_gone_ffffffff') { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":{"message":"This model models/x is no longer available to new users"}}'); return; }
      if (key === 'gsk_hang_gggggggg') return;   // never answers
      if (key === 'gsk_plain404_hhhhhhh') { res.writeHead(404); res.end('{"error":"no such path"}'); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'x-ratelimit-limit-tokens': '8000' }); res.end(JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: { total_tokens: 42 } }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  const host = `http://127.0.0.1:${(fake.address() as any).port}`;
  const mk = (keys: unknown) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'keygw-')); fs.writeFileSync(path.join(d, 'keys.json'), JSON.stringify(keys)); return d; };
  const all = { groq: [{ label: 'limited', key: 'gsk_limited_aaaaaaaa' }, { label: 'rejected', key: 'gsk_rejected_bbbbbbbb' }, { label: 'good', key: 'gsk_good_cccccccc' }], gemini: [{ label: 'g1', key: 'AQ.gemini_dddddddd' }] };
  const gw = await startGateway({ port: 0, dir: mk(all), hosts: { groq: host, gemini: host }, log: () => {} });
  const chat = (who: string) => hit(gw.port, `/groq/${who}/openai/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"m"}' });

  // 1. the first account is limited, the second rejected, the third answers: the caller just gets the answer
  let r = await chat('quantlens'); assert.strictEqual(r.status, 200); assert.strictEqual(JSON.parse(r.text).usage.total_tokens, 42);
  assert.deepStrictEqual(seen.map((s) => s.key), ['gsk_limited_aaaaaaaa', 'gsk_rejected_bbbbbbbb', 'gsk_good_cccccccc'], 'tried in turn until one answered');
  // 2. the next call skips the two that failed (no wasted calls)
  seen.length = 0; r = await chat('news'); assert.strictEqual(r.status, 200); assert.deepStrictEqual(seen.map((s) => s.key), ['gsk_good_cccccccc'], 'cooling accounts are skipped');
  // 3. numbers: per account, per program, tokens; and no key anywhere in what the dashboard gets
  const st = gw.stats() as any, by = Object.fromEntries(st.providers.groq.map((k: any) => [k.label, k]));
  assert.strictEqual(by.limited.state, 'cooling'); assert.strictEqual(by.rejected.state, 'rejected'); assert.strictEqual(by.good.state, 'ready');
  assert.deepStrictEqual([by.good.req, by.good.ok, by.good.tok, by.limited.limited, by.rejected.err], [2, 2, 84, 1, 1]);
  const q = st.clients.find((c: any) => c.client === 'quantlens'); assert.deepStrictEqual([q.req, q.ok, q.tok], [1, 1, 42]); assert.deepStrictEqual(q.accounts, [{ label: 'good', req: 1 }]);
  assert.ok(!/gsk_|AQ\./.test(JSON.stringify(st)), 'a key leaked into the stats');
  // 4. Gemini: the key goes in the x-goog-api-key header and a key sent by the caller in the query is dropped
  seen.length = 0; r = await hit(gw.port, '/gemini/news/v1beta/models/gemini-2.0-flash:generateContent?key=CALLERKEY&alt=sse', { method: 'POST', body: '{}' });
  assert.strictEqual(r.status, 200); assert.strictEqual(seen[0].key, 'AQ.gemini_dddddddd'); assert.ok(!seen[0].url.includes('CALLERKEY') && seen[0].url.includes('alt=sse'), 'caller key removed, other query kept');
  // 5. only local programs: a browser page (sends Origin) and a wrong Host are refused; unknown paths too
  assert.strictEqual((await hit(gw.port, '/_stats', { headers: { origin: 'http://evil.example' } })).status, 403);
  assert.strictEqual((await hit(gw.port, '/_stats', { headers: { host: 'evil.example' } })).status, 403);
  assert.strictEqual((await hit(gw.port, '/openai/v1/models')).status, 404);
  await gw.close();

  // 6. every account limited: the caller gets the provider's own 429 text and a retry-after, and it is counted
  const gw2 = await startGateway({ port: 0, dir: mk({ groq: [{ label: 'limited', key: 'gsk_limited_aaaaaaaa' }], gemini: [] }), hosts: { groq: host }, log: () => {} });
  r = await hit(gw2.port, '/groq/x/openai/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"m"}' });
  assert.strictEqual(r.status, 429); assert.ok(/tokens per day/.test(r.text), 'provider text kept');
  r = await hit(gw2.port, '/groq/x/openai/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"m"}' });
  assert.strictEqual(r.status, 429); assert.ok(/cooling down/.test(r.text), 'second call is answered without asking the provider again');
  assert.strictEqual((gw2.stats() as any).clients[0].limited, 2); await gw2.close();
  // 7. provider trouble: a busy (503) account, one that lost the model (404) and one that hangs are passed over; the good one answers, and the bad ones are then skipped for that model
  const gw3 = await startGateway({ port: 0, dir: mk({ groq: [{ label: 'busy', key: 'gsk_busy_eeeeeeee' }, { label: 'gone', key: 'gsk_gone_ffffffff' }, { label: 'hang', key: 'gsk_hang_gggggggg' }, { label: 'good', key: 'gsk_good_cccccccc' }], gemini: [] }), hosts: { groq: host }, log: () => {}, firstByteMs: 400, budgetMs: 5000 });
  seen.length = 0; const t = Date.now(); r = await hit(gw3.port, '/groq/jarvis/openai/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"m"}' });
  assert.strictEqual(r.status, 200); assert.deepStrictEqual(seen.map((s) => s.key), ['gsk_busy_eeeeeeee', 'gsk_gone_ffffffff', 'gsk_hang_gggggggg', 'gsk_good_cccccccc']); assert.ok(Date.now() - t < 3000, 'the hanging account was given up on quickly');
  seen.length = 0; r = await hit(gw3.port, '/groq/jarvis/openai/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"m"}' });
  assert.deepStrictEqual(seen.map((s) => s.key), ['gsk_good_cccccccc'], 'accounts that failed for this model are skipped');
  seen.length = 0; r = await hit(gw3.port, '/groq/jarvis/openai/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"other"}' });
  assert.strictEqual(seen[0].key, 'gsk_busy_eeeeeeee', 'a different model still tries every account');
  const mods = (JSON.parse((await hit(gw3.port, '/_models')).text).groq as any[]).find((x) => x.model === 'm'); assert.deepStrictEqual([mods.usable, mods.total], [1, 4], '/_models says how many accounts can serve a model right now'); await gw3.close();
  // 8. all accounts hang: the caller gets a quick 504, not a long wait; a plain 404 (bad path) is passed back at once without trying other accounts
  const gw4 = await startGateway({ port: 0, dir: mk({ groq: [{ label: 'hang', key: 'gsk_hang_gggggggg' }], gemini: [] }), hosts: { groq: host }, log: () => {}, firstByteMs: 300, budgetMs: 2000 });
  r = await hit(gw4.port, '/groq/x/openai/v1/models'); assert.strictEqual(r.status, 504); await gw4.close();
  // the total budget is a real ceiling: two silent accounts with a long first-byte limit still end near the budget, not at 2 x the limit
  const gw6 = await startGateway({ port: 0, dir: mk({ groq: [{ label: 'h1', key: 'gsk_hang_gggggggg' }, { label: 'h2', key: 'gsk_hang_gggggggg' }], gemini: [] }), hosts: { groq: host }, log: () => {}, firstByteMs: 3000, budgetMs: 1500 });
  const t6 = Date.now(); r = await hit(gw6.port, '/groq/x/openai/v1/models'); assert.strictEqual(r.status, 504); assert.ok(Date.now() - t6 < 2600, 'ended near the budget (' + (Date.now() - t6) + ' ms)'); await gw6.close();
  const gw5 = await startGateway({ port: 0, dir: mk({ groq: [{ label: 'p', key: 'gsk_plain404_hhhhhhh' }, { label: 'good', key: 'gsk_good_cccccccc' }], gemini: [] }), hosts: { groq: host }, log: () => {} });
  seen.length = 0; r = await hit(gw5.port, '/groq/x/nothing/here'); assert.strictEqual(r.status, 404); assert.strictEqual(seen.length, 1, 'a plain 404 does not burn the other accounts'); await gw5.close();
  // 9. a pinned program (pins.json) always uses its one account and gets the provider's answer untouched; everyone else still rotates
  const hitFull = (port: number, p: string) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => { const q = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json' } }, (x) => { let s = ''; x.on('data', (c) => (s += c)); x.on('end', () => resolve({ status: x.statusCode || 0, headers: x.headers, text: s })); }); q.on('error', reject); q.end('{"model":"m"}'); });
  const d7 = mk({ groq: [{ label: 'limited', key: 'gsk_limited_aaaaaaaa' }, { label: 'good', key: 'gsk_good_cccccccc' }], gemini: [] });
  fs.writeFileSync(path.join(d7, 'pins.json'), JSON.stringify({ relay1: { groq: 'limited' }, relay2: { groq: 'good' }, relay3: { groq: 'nope' } }));
  const gw7 = await startGateway({ port: 0, dir: d7, hosts: { groq: host }, log: () => {} }), P = '/openai/v1/chat/completions';
  seen.length = 0; let f = await hitFull(gw7.port, '/groq/relay1' + P);
  assert.strictEqual(f.status, 429); assert.strictEqual(f.headers['retry-after'], '120'); assert.strictEqual(f.headers['x-ratelimit-remaining-tokens'], '0'); assert.ok(/tokens per day/.test(f.text), 'body untouched');
  f = await hitFull(gw7.port, '/groq/relay1' + P); assert.strictEqual(f.status, 429); assert.deepStrictEqual(seen.map((s) => s.key), ['gsk_limited_aaaaaaaa', 'gsk_limited_aaaaaaaa'], 'pinned: no failover, and asked again every time');
  seen.length = 0; f = await hitFull(gw7.port, '/groq/relay2' + P); assert.strictEqual(f.status, 200); assert.strictEqual(f.headers['x-ratelimit-limit-tokens'], '8000', 'rate-limit headers pass through'); assert.deepStrictEqual(seen.map((s) => s.key), ['gsk_good_cccccccc']);
  seen.length = 0; f = await hitFull(gw7.port, '/groq/news' + P); assert.strictEqual(f.status, 200); assert.deepStrictEqual(seen.map((s) => s.key), ['gsk_good_cccccccc'], 'other programs still pick the least-used account');
  seen.length = 0; f = await hitFull(gw7.port, '/groq/news' + P); f = await hitFull(gw7.port, '/groq/news' + P); assert.ok(seen.some((s) => s.key === 'gsk_limited_aaaaaaaa') && f.status === 200, 'other programs still rotate and fail over past a limited account');
  f = await hitFull(gw7.port, '/groq/relay3' + P); assert.strictEqual(f.status, 503, 'pinned to an unknown account: an error, never a silent switch to rotation');
  assert.ok(!/gsk_|AQ\./.test(JSON.stringify(gw7.stats())), 'no key in stats'); await gw7.close();
  // 10. "reserve": the pinned account is used by its program only; everyone else rotates over the rest
  const d8 = mk({ groq: [{ label: 'limited', key: 'gsk_limited_aaaaaaaa' }, { label: 'good', key: 'gsk_good_cccccccc' }], gemini: [] });
  fs.writeFileSync(path.join(d8, 'pins.json'), JSON.stringify({ relay1: { groq: 'good', reserve: true } }));
  const gw8 = await startGateway({ port: 0, dir: d8, hosts: { groq: host }, log: () => {} });
  seen.length = 0; f = await hitFull(gw8.port, '/groq/news' + P); assert.strictEqual(f.status, 429); assert.deepStrictEqual(seen.map((s) => s.key), ['gsk_limited_aaaaaaaa'], 'the reserved account is never used by other programs');
  seen.length = 0; f = await hitFull(gw8.port, '/groq/relay1' + P); assert.strictEqual(f.status, 200); assert.deepStrictEqual(seen.map((s) => s.key), ['gsk_good_cccccccc'], 'the pinned program still uses it'); await gw8.close();
  fake.close(); console.log('key gateway checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
