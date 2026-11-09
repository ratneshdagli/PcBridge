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
      if (key === 'gsk_limited_aaaaaaaa') { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' }); res.end('{"error":{"message":"Rate limit reached on tokens per day (TPD)"}}'); return; }
      if (key === 'gsk_rejected_bbbbbbbb') { res.writeHead(401); res.end('{"error":"bad key"}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: { total_tokens: 42 } }));
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
  fake.close(); console.log('key gateway checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
