// End-to-end tests against the REAL remote. Run: npm test
// Everything created on the remote is prefixed "pcbtest" and removed in the finally block.
// Existing remote containers (e.g. searxng) are never touched.
import { spawn, spawnSync } from 'child_process';
import * as http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as core from '../src/core';
import * as prog from '../src/programs';
import * as apps from '../src/apps';
import * as setup from '../src/setup';

const results: { name: string; ok: boolean; note: string }[] = [];
async function t(name: string, fn: () => Promise<string | void>) {
  if (process.env.ONLY && !new RegExp(process.env.ONLY, 'i').test(name)) return;   // npm test with ONLY=regex runs a subset
  const t0 = Date.now();
  try { const note = (await fn()) || ''; results.push({ name, ok: true, note }); console.log(`PASS  ${name} (${Date.now() - t0} ms) ${note}`); }
  catch (e: any) { results.push({ name, ok: false, note: e.message }); console.log(`FAIL  ${name}: ${e.message}`); }
}
const eq = (a: unknown, b: unknown, m = '') => { if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (c: unknown, m = 'assertion failed') => { if (!c) throw new Error(m); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => Promise<boolean> | boolean, ms: number, what: string) {
  const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(500); } throw new Error('timed out waiting for ' + what);
}
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

const R = core.defaultConfig().remotes[0];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcbtest-'));
const FPORT = 18099;

async function main() {
  // ---------- config ----------
  await t('config: default is valid', async () => eq(core.validateConfig(core.defaultConfig()).length, 0));
  await t('config: rejects option-injection host, bad ports, dup forwards, bad ctx', async () => {
    const c = core.defaultConfig();
    c.remotes[0].host = '-oProxyCommand=calc'; c.remotes[0].port = 0; c.remotes[0].contextName = 'a b';
    c.forwards = [{ name: 'a', localPort: 80, remotePort: 80, remoteHost: '127.0.0.1' }, { name: 'b', localPort: 80, remotePort: 70000, remoteHost: 'x y' }];
    const e = core.validateConfig(c).join('|'); ok(/host/.test(e) && /port must/.test(e) && /context/.test(e) && /two forwards/.test(e) && /remote port invalid/.test(e) && /remote host invalid/.test(e), e);
    const u = core.defaultConfig(); u.remotes[0].user = 'a&calc'; ok(core.validateConfig(u).length > 0, 'user with & accepted');
  });
  await t('config: missing file -> defaults written; corrupt file -> backed up + reset + warning', async () => {
    const f = path.join(tmp, 'cfg', 'config.json'); const a = core.loadConfig(f); ok(fs.existsSync(f) && !a.warning, 'default not written');
    fs.writeFileSync(f, '{ not json'); const b = core.loadConfig(f); ok(b.warning && fs.existsSync(f + '.bad'), 'no backup/warning');
    eq(core.validateConfig(b.config).length, 0); fs.writeFileSync(f, JSON.stringify({ remotes: [{ host: 'x;y' }] }));
    ok(core.loadConfig(f).warning, 'invalid values not caught');
  });
  await t('config: save is atomic + round-trips', async () => {
    const f = path.join(tmp, 'rt.json'); const c = core.defaultConfig(); c.projects = [{ name: 'p', path: 'C:\\x y' }]; core.saveConfig(f, c);
    eq(core.loadConfig(f).config.projects[0].path, 'C:\\x y'); ok(!fs.existsSync(f + '.tmp'), 'tmp left behind');
  });

  // ---------- runner never hangs ----------
  await t('run: kills a hung command at the timeout (no UI hang)', async () => {
    const x = await core.run('ping', ['-n', '40', '127.0.0.1'], { timeout: 1500 }); ok(x.timedOut && x.ms < 4000, `ms=${x.ms} timedOut=${x.timedOut}`);
    return `${x.ms} ms`;
  });
  await t('run: missing program reports a clear error', async () => { const x = await core.run('definitely-not-a-program', []); ok(/not found/.test(x.stderr), x.stderr); });

  // ---------- live status ----------
  let st!: core.Status;
  if (process.env.ONLY) st = await core.getStatus(R, false);   // subset runs skip the test that normally fills this in
  await t('status: online remote -> tailscale+ssh+metrics+docker', async () => {
    st = await core.getStatus(R);
    ok(st.tailscale.state === 'online', 'tailscale ' + st.tailscale.detail); ok(st.ssh.ok, 'ssh ' + st.ssh.error);
    ok(typeof st.ssh.latencyMs === 'number', 'latency'); const m = st.metrics!; ok(m.ramTotalMB > 1000 && m.cpu >= 0 && m.disks.length >= 1, 'metrics');
    ok(m.disks.some((d) => d.id === 'E:'), 'E: drive missing'); ok(st.docker, 'docker block');
    return `lat=${st.ssh.latencyMs}ms cpu=${m.cpu}% wsl=${st.docker!.wslRunning} containers=${st.docker!.containers.length}`;
  });
  await t('status: 5 consecutive polls all succeed and stay fast', async () => {
    const ms: number[] = []; for (let i = 0; i < 5; i++) { const t0 = Date.now(); const s = await core.getStatus(R); ok(s.ssh.ok, 'poll ' + i + ' failed: ' + s.ssh.error); ms.push(Date.now() - t0); }
    ok(Math.max(...ms) < 12000, 'slow: ' + ms); return ms.join(',') + ' ms';
  });

  // ---------- every offline failure mode ----------
  const bad = (over: Partial<core.Remote>) => ({ ...R, ...over });
  await t('offline: unreachable IP -> times out fast, headline + checklist', async () => {
    const t0 = Date.now(); const s = await core.getStatus(bad({ host: '100.64.255.254' })); ok(!s.ssh.ok, 'reported ok'); ok(Date.now() - t0 < 9000, 'took ' + (Date.now() - t0));
    ok(s.ssh.checklist!.length >= 4 && /offline|timed out|unknown|not in this tailnet/i.test(s.ssh.headline! + s.tailscale.detail), s.ssh.headline!); return s.ssh.headline;
  });
  await t('offline: tailscale peer marked offline (phone) -> says offline in Tailscale', async () => {
    const s = await core.getStatus(bad({ host: '100.64.138.86' })); eq(s.tailscale.state, 'offline'); ok(/offline in Tailscale/.test(s.ssh.headline!), s.ssh.headline!);
  });
  await t('offline: connection refused -> sshd hint', async () => {
    const s = await core.getStatus(bad({ host: '127.0.0.1', port: 1 })); ok(/sshd/.test(s.ssh.headline!), s.ssh.headline!);
  });
  await t('offline: wrong user -> key rejected / authorized_keys hint', async () => {
    const s = await core.getStatus(bad({ user: 'pcbtest-nouser' })); ok(!s.ssh.ok && /key was rejected/.test(s.ssh.headline!), `${s.ssh.headline} | ${s.ssh.error}`);
  });
  await t('offline: missing key file -> key problem hint', async () => {
    const s = await core.getStatus(bad({ keyPath: path.join(tmp, 'nokey') })); ok(!s.ssh.ok && /private key|key was rejected/.test(s.ssh.headline!), `${s.ssh.headline} | ${s.ssh.error}`);
  });
  await t('offline: unresolvable hostname -> resolve hint', async () => {
    const s = await core.getStatus(bad({ host: 'no-such-host.invalid' })); ok(!s.ssh.ok && /resolved|offline|unreachable|timed out/.test(s.ssh.headline!), s.ssh.headline!); return s.ssh.headline;
  });

  // ---------- docker context toggle ----------
  await t('context: use remote -> local docker CLI really talks to remote -> switch back', async () => {
    const cfg = core.defaultConfig(); const before = await core.dockerContext();
    try {
      await core.useRemoteDocker(cfg); eq(await core.dockerContext(), 'remote'); eq(cfg.localContext, before === 'remote' ? '' : before);
      const x = await core.run('docker', ['ps', '-a', '--format', '{{.Names}}'], { timeout: 30000 }); eq(x.code, 0, x.stderr); ok(/searxng/.test(x.stdout), 'did not see remote container');
      const s = await core.getStatus(R); ok(s.contextIsRemote, 'status does not show remote context active');
    } finally { await core.useLocalDocker(cfg); }
    eq(await core.dockerContext(), before); return `restored "${before}"`;
  });
  await t('context: toggling twice is idempotent', async () => {
    const cfg = core.defaultConfig(); const before = await core.dockerContext();
    try { await core.useRemoteDocker(cfg); await core.useRemoteDocker(cfg); eq(await core.dockerContext(), 'remote'); } finally { await core.useLocalDocker(cfg); }
    eq(await core.dockerContext(), before);
  });

  // ---------- deploy a project ----------
  const pdir = path.join(tmp, 'My Project (test)'); const P: core.Project = { name: 'pcbtest', path: pdir };
  fs.mkdirSync(path.join(pdir, 'www'), { recursive: true }); fs.mkdirSync(path.join(pdir, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(pdir, 'node_modules', 'x', 'big.js'), 'SHOULD NOT SYNC');
  const bin = crypto.randomBytes(1024 * 1024); fs.writeFileSync(path.join(pdir, 'www', 'blob.bin'), bin);
  fs.writeFileSync(path.join(pdir, 'www', 'index.html'), 'hello-v1 ✓ ünïcode\n'); fs.writeFileSync(path.join(pdir, 'www', 'with space.txt'), 'spaced');
  fs.writeFileSync(path.join(pdir, 'docker-compose.yml'), `services:
  web:
    image: busybox:1.36
    container_name: pcbtest-web
    command: httpd -f -p 8000 -h /www
    volumes: ["./www:/www:ro"]
    ports: ["${FPORT}:8000"]
    stop_grace_period: 1s
`);
  const fwd = new core.Forwarder(); const dir = '~/pcbridge/pcbtest';
  try {
    await t('sync: errors are clear (missing folder, no compose file)', async () => {
      const a = await core.syncProject(R, { name: 'x', path: path.join(tmp, 'nope') }, []).then(() => 'ok', (e) => e.message); ok(/not found/i.test(a), a);
      fs.mkdirSync(path.join(tmp, 'empty')); const b = await core.syncProject(R, { name: 'x', path: path.join(tmp, 'empty') }, []).then(() => 'ok', (e) => e.message); ok(/No docker-compose/.test(b), b);
    });
    await t('sync: OFFLINE remote with a big project fails fast with the SSH reason (no hang on a full pipe)', async () => {
      const big = path.join(tmp, 'bigproj'); fs.mkdirSync(big); fs.writeFileSync(path.join(big, 'docker-compose.yml'), 'services: {}\n'); fs.writeFileSync(path.join(big, 'blob.bin'), crypto.randomBytes(2 * 1024 * 1024));
      const t0 = Date.now(); const m = await core.syncProject({ ...R, host: '100.64.255.254' }, { name: 'big', path: big }, []).then(() => 'ok', (e) => e.message);
      ok(m !== 'ok' && Date.now() - t0 < 25000, `${m} after ${Date.now() - t0} ms`); ok(/remote extract failed|timed out|ssh/i.test(m), m); return `${Date.now() - t0} ms: ${m.slice(0, 70)}`;
    });
    await t('sync: tar-over-ssh copies binary exactly, spaces/unicode ok, excludes honoured', async () => {
      await core.syncProject(R, P, core.defaultConfig().syncExcludes);
      const r = await core.wslSh(R, `cd ${dir} && sha256sum www/blob.bin | cut -d' ' -f1 && cat www/index.html && cat "www/with space.txt" && echo && (test -e node_modules && echo HAS_NODE_MODULES || echo NO_NODE_MODULES)`);
      const lines = r.stdout.trim().split('\n'); eq(lines[0], sha(bin), 'binary checksum'); ok(r.stdout.includes('hello-v1 ✓ ünïcode'), 'unicode content'); ok(r.stdout.includes('spaced'), 'space filename');
      ok(r.stdout.includes('NO_NODE_MODULES'), 'node_modules was synced'); return '1 MiB binary identical';
    });
    await t('compose up: starts container on remote (pulls image if needed)', async () => {
      const r = await core.composeAction(R, P, 'up'); eq(r.code, 0, (r.stdout + r.stderr).slice(-400));
      const ps = await core.composeAction(R, P, 'ps'); ok(/pcbtest-web/.test(ps.stdout) && /Up/.test(ps.stdout), ps.stdout);
    });
    await t('status: new container visible with running state, ports and stats', async () => {
      await until(async () => !!(await core.getStatus(R)).docker!.containers.find((c) => c.name === 'pcbtest-web' && c.state === 'running'), 40000, 'container in status');
      const s = await core.getStatus(R); const c = s.docker!.containers.find((x) => x.name === 'pcbtest-web')!; ok(c.ports.includes(String(FPORT)), c.ports); ok(/%/.test(c.cpu), 'no stats: ' + c.cpu); return `${c.status} ${c.cpu} ${c.mem}`;
    });
    await t('forward: local port reaches the container through ssh (bind mount served synced file)', async () => {
      await fwd.start(R, { name: 't', localPort: FPORT, remotePort: FPORT, remoteHost: '127.0.0.1' });
      await until(() => fwd.get(FPORT)?.state === 'active', 10000, 'forward active');
      const body = await (await fetch(`http://127.0.0.1:${FPORT}/index.html`)).text(); ok(body.includes('hello-v1'), body);
    });
    await t('forward: busy local port -> clear error', async () => {
      const srv = net.createServer().listen(18098, '127.0.0.1'); await sleep(200);
      try { const m = await new core.Forwarder().start(R, { name: 'b', localPort: 18098, remotePort: 1, remoteHost: '127.0.0.1' }).then(() => 'started', (e) => e.message); ok(/already in use/.test(m), m); } finally { srv.close(); }
    });
    await t('forward: AUTO-RECONNECT after the link is killed', async () => {
      fwd.simulateDrop(FPORT); await until(() => fwd.get(FPORT)!.state === 'reconnecting', 5000, 'reconnecting state');
      await until(() => fwd.get(FPORT)!.state === 'active', 15000, 'active again'); const body = await (await fetch(`http://127.0.0.1:${FPORT}/index.html`)).text(); ok(body.includes('hello-v1'), 'no data after reconnect');
      return `restarts=${fwd.get(FPORT)!.restarts}`;
    });
    await t('re-sync picks up edits; container serves new content without restart', async () => {
      fs.writeFileSync(path.join(pdir, 'www', 'index.html'), 'hello-v2\n'); await core.syncProject(R, P, core.defaultConfig().syncExcludes);
      const body = await (await fetch(`http://127.0.0.1:${FPORT}/index.html`)).text(); ok(body.includes('hello-v2'), body);
    });
    await t('container actions: stop / start / restart / logs; bad names rejected', async () => {
      let r = await core.containerAction(R, 'stop', 'pcbtest-web'); eq(r.code, 0, r.stderr);
      await until(async () => (await core.getStatus(R)).docker!.containers.find((c) => c.name === 'pcbtest-web')?.state === 'exited', 30000, 'exited state');
      r = await core.containerAction(R, 'start', 'pcbtest-web'); eq(r.code, 0, r.stderr); r = await core.containerAction(R, 'restart', 'pcbtest-web'); eq(r.code, 0, r.stderr);
      await until(async () => (await core.getStatus(R)).docker!.containers.find((c) => c.name === 'pcbtest-web')?.state === 'running', 30000, 'running again');
      r = await core.containerAction(R, 'logs', 'pcbtest-web'); eq(r.code, 0, r.stderr);
      for (const n of ['a;b', 'x && calc', '$(id)', '-rf', '']) { const m = await core.containerAction(R, 'stop', n).then(() => 'accepted', (e) => e.message); eq(m, 'Invalid container name', n); }
      const nx = await core.containerAction(R, 'stop', 'pcbtest-does-not-exist'); ok(nx.code !== 0 && /No such container/i.test(nx.stderr + nx.stdout), 'nonexistent container did not error visibly');
    });
    await t('compose: logs + restart work', async () => {
      const l = await core.composeAction(R, P, 'logs'); eq(l.code, 0, l.stderr); const r = await core.composeAction(R, P, 'restart'); eq(r.code, 0, r.stdout);
    });
    await t('compose action on never-synced project -> clear message, non-zero', async () => {
      const r = await core.composeAction(R, { name: 'pcbtest-never', path: pdir }, 'up'); ok(r.code !== 0 && /not synced/.test(r.stdout + r.stderr), r.stdout);
    });
    await t('keep-awake: WSL stays running well past the idle timeout while the app holds a session', async () => {
      fwd.startKeepAwake(R); await until(() => fwd.get(0)?.state === 'active', 10000, 'keep-awake active');
      await sleep(100000); const s = await core.getStatus(R); ok(s.docker!.wslRunning && s.docker!.daemonUp, 'WSL idled off despite keep-awake');
      ok(s.docker!.containers.find((c) => c.name === 'pcbtest-web')?.state === 'running', 'container died'); return 'still running after 100 s idle';
    });
    await t('keep-awake: reconnects after being killed', async () => {
      fwd.simulateDrop(0); await until(() => fwd.get(0)!.state === 'reconnecting', 5000, 'reconnecting'); await until(() => fwd.get(0)!.state === 'active', 15000, 'active again');
    });
  } finally {
    fwd.stopAll();
    await t('cleanup: compose down, remove test dir + image (existing containers untouched)', async () => {
      await core.composeAction(R, P, 'down');
      const r = await core.wslSh(R, `rm -rf ${dir}; docker rm -f pcbtest-web 2>/dev/null; docker rmi busybox:1.36 2>&1 | tail -1; docker ps -a --format '{{.Names}}'`);
      ok(!/pcbtest/.test(r.stdout.split('\n').filter((l) => !/Untagged|Deleted|No such|Error/.test(l)).join('\n')), r.stdout); ok(/searxng/.test(r.stdout), 'searxng missing!'); return 'clean';
    });
  }

  // ---------- offload a live site + failover ----------
  const OPORT = 18097, ODIR = path.join(tmp, 'pcbtest-off');
  fs.mkdirSync(path.join(ODIR, 'www'), { recursive: true }); fs.writeFileSync(path.join(ODIR, 'www', 'index.html'), 'SITE-v1\n');
  fs.writeFileSync(path.join(ODIR, 'docker-compose.yml'), `services:
  web:
    image: busybox:1.36
    command: httpd -f -p 8000 -h /www
    volumes: ["./www:/www:ro"]
    ports: ["${OPORT}:8000"]
    stop_grace_period: 1s
`);
  const ocfg = core.defaultConfig(); ocfg.projects = [{ name: 'pcbtest-off', path: ODIR, ports: [OPORT], failover: true }, { name: 'pcbtest-noports', path: ODIR }];
  const op = ocfg.projects[0]; const ofwd = new core.Forwarder(); const offl = new core.Offloader(() => ocfg, () => { /* not persisted in tests */ }, ofwd);
  const hadImg = (await core.run('docker', ['image', 'inspect', 'busybox:1.36', '--format', 'ok'])).code === 0;
  const site = async () => (await fetch(`http://127.0.0.1:${OPORT}/index.html`, { signal: AbortSignal.timeout(6000) })).text();
  const lctx = await core.localCtx(ocfg);
  const localUp = async () => (await core.run('docker', ['--context', lctx, 'ps', '--filter', 'label=com.docker.compose.project=pcbtest-off', '--format', '{{.Names}}'])).stdout.trim();
  const remoteUp = async () => (await core.wslSh(R, `docker ps --filter label=com.docker.compose.project=pcbtest-off --format '{{.Names}}'`)).stdout.trim();
  const fake = (okS: boolean, portUp = true): core.Status => ({ ...st, ts: Date.now(), ssh: okS ? { ok: true, latencyMs: 20 } : { ok: false, latencyMs: null, error: 'x', headline: 'simulated outage', checklist: [] }, portsUp: { [String(OPORT)]: portUp } });
  try {
    await t('offload: local site starts and serves', async () => { const r = await core.localCompose(ocfg, op, 'up'); eq(r.code, 0, r.stderr.slice(-300)); await until(async () => (await site().catch(() => '')).includes('SITE-v1'), 20000, 'local site'); });
    await t('offload: refuses when no port is configured', async () => { const m = await offl.offload('pcbtest-noports').then(() => 'ok', (e) => e.message); ok(/port/i.test(m), m); });
    await t('offload: unreachable remote -> clear failure, local site UNTOUCHED', async () => {
      const bad = core.defaultConfig(); bad.remotes[0].host = '100.64.255.254'; bad.projects = ocfg.projects;
      const m = await new core.Offloader(() => bad, () => { /* */ }, new core.Forwarder()).offload('pcbtest-off').then(() => 'ok', (e) => e.message);
      ok(m !== 'ok', 'should have failed'); ok((await site()).includes('SITE-v1'), 'local site broke'); ok(op.mode !== 'remote', 'mode flipped'); return m.slice(0, 80);
    });
    await t('offload: moves the site (images+files+start+stop local+forward); same URL still works', async () => {
      await offl.offload('pcbtest-off'); eq(op.mode, 'remote'); ok((await site()).includes('SITE-v1'), 'no content via forward');
      eq(await localUp(), '', 'local copy still running'); ok(/pcbtest-off/.test(await remoteUp()), 'not running on remote');
    });
    await t('status reports remote port health (portsUp) for offloaded sites', async () => { const s = await core.getStatus(R, false, [OPORT, 1]); eq(s.portsUp![String(OPORT)], true); eq(s.portsUp!['1'], false); });
    await t('failover: flaky polls (2 bad, 1 good, 2 bad) do NOT trigger it', async () => {
      for (const s of [fake(false), fake(false), fake(true), fake(false), fake(false)]) await offl.onStatus(s); eq(op.mode, 'remote'); ok((await site()).includes('SITE-v1'), 'site down');
    });
    await t('failover: 3 consecutive bad polls -> site comes back on THIS PC, forward removed', async () => {
      await offl.onStatus(fake(false)); eq(op.mode, 'local'); eq(op.failedOver, true); ok(/pcbtest-off/.test(await localUp()), 'not running locally');
      await until(async () => (await site().catch(() => '')).includes('SITE-v1'), 15000, 'site served locally'); eq(ofwd.get(OPORT)?.state, 'stopped');
    });
    await t('failover: SSH fine but the site port dead on remote (3 polls) -> also fails over', async () => {
      await offl.offload('pcbtest-off'); eq(op.mode, 'remote'); for (let i = 0; i < 3; i++) await offl.onStatus(fake(true, false)); eq(op.mode, 'local'); eq(op.failedOver, true);
      await until(async () => (await site().catch(() => '')).includes('SITE-v1'), 15000, 'site served locally');
    });
    await t('failback: after failover + remote healthy for ~15 polls -> moves to remote again (autoFailback)', async () => {
      op.autoFailback = true; for (let i = 0; i < 15; i++) await offl.onStatus(fake(true)); eq(op.mode, 'remote'); eq(op.failedOver, false); ok((await site()).includes('SITE-v1'), 'no content');
    });
    await t('bring home (manual): back on this PC, remote copy stopped', async () => {
      await offl.bringHome('pcbtest-off'); eq(op.mode, 'local'); eq(op.failedOver, false); ok(/pcbtest-off/.test(await localUp()), 'not local');
      await until(async () => (await remoteUp()) === '', 60000, 'remote copy stopped'); await until(async () => (await site().catch(() => '')).includes('SITE-v1'), 15000, 'site');
    });
    await t('syncImages: local-only image (not on any registry) is copied to the remote', async () => {
      await core.run('docker', ['--context', lctx, 'tag', 'busybox:1.36', 'pcbtest-localonly:1']); const dd = path.join(tmp, 'pcbtest-img'); fs.mkdirSync(dd);
      fs.writeFileSync(path.join(dd, 'docker-compose.yml'), 'services:\n  x:\n    image: pcbtest-localonly:1\n    command: sleep 1\n');
      try { const moved = await core.syncImages(ocfg, R, { name: 'pcbtest-img', path: dd }); ok(moved.some((m) => /copied from this PC/.test(m)), JSON.stringify(moved));
        eq((await core.ssh(R, 'wsl.exe -e docker image inspect pcbtest-localonly:1 --format ok')).code, 0, 'image missing on remote'); return moved[0]; }
      finally { await core.run('docker', ['--context', lctx, 'rmi', 'pcbtest-localonly:1']); await core.ssh(R, 'wsl.exe -e docker rmi pcbtest-localonly:1'); }
    });
  } finally {
    ofwd.stopAll();
    await t('cleanup (offload): local + remote test stacks, dirs and images removed', async () => {
      await core.run('docker', ['--context', lctx, 'compose', '--project-directory', ODIR, '-f', path.join(ODIR, 'docker-compose.yml'), 'down'], { timeout: 60000 });
      if (!hadImg) await core.run('docker', ['--context', lctx, 'rmi', 'busybox:1.36']);
      await core.wslSh(R, `cd ~/pcbridge/pcbtest-off 2>/dev/null && docker compose down; cd ~; rm -rf ~/pcbridge/pcbtest-off; docker rmi busybox:1.36 2>&1 | tail -1`, { timeout: 120000 });
      eq(await remoteUp(), ''); eq(await localUp(), ''); return hadImg ? 'kept your local busybox image' : 'removed pulled busybox image';
    });
  }

  // ---------- ANY container: faithful twin on the remote (+ data), offload, failover. The LOCAL engine is scripted (Docker Desktop stays off). ----------
  const APORT = 18093, fdir = fs.mkdtempSync(path.join(tmp, 'fake-')), FSTATE = path.join(fdir, 'state.json'), data = path.join(fdir, 'data');
  fs.mkdirSync(path.join(data, 'www'), { recursive: true }); fs.writeFileSync(path.join(data, 'www', 'index.html'), 'COPIED-FROM-LOCAL\n');
  const baseInspect = (name: string, ports: string[], mounts: any[] = [{ Type: 'volume', Source: 'x', Destination: '/www', RW: true }]) => ({ Name: '/' + name,
    Config: { Image: 'busybox:1.36', Env: ['MODE=prod'], Cmd: ['httpd', '-f', '-p', '8000', '-h', '/www'], Entrypoint: null, Labels: {}, User: '', WorkingDir: '' },
    HostConfig: { PortBindings: Object.fromEntries(ports.map((p, k) => [`${8000 + k}/tcp`, [{ HostIp: '', HostPort: p }, { HostIp: '::', HostPort: p }]])), RestartPolicy: { Name: 'unless-stopped' }, NetworkMode: 'default', Memory: 0 }, Mounts: mounts });
  const hadBusybox = (await core.ssh(R, 'wsl.exe -e docker image inspect busybox:1.36 --format ok')).code === 0;
  const stateWrite = (s: object) => fs.writeFileSync(FSTATE, JSON.stringify(s));
  const stateRead = () => JSON.parse(fs.readFileSync(FSTATE, 'utf8'));

  await t('containers: createArgsFromInspect keeps image/env/ports/restart/mounts/cmd and collapses IPv4+IPv6 port bindings', async () => {
    const { args, mounts } = core.createArgsFromInspect(baseInspect('app', ['8080']));
    const j = args.join(' '); ok(j.includes('--name app') && j.includes('--restart unless-stopped') && j.includes('-e MODE=prod') && j.includes('-v pcb-app-0:/www'), j);
    eq(args.filter((x) => x === '8080:8000/tcp').length, 1, 'port duplicated'); ok(args.includes('8080:8000/tcp'), j); ok(j.endsWith('busybox:1.36 httpd -f -p 8000 -h /www'), j); eq(mounts[0].dest, '/www');
    const e = baseInspect('app', ['8080']) as any; e.Config.Entrypoint = ['/entry.sh', '--x']; e.HostConfig.RestartPolicy = { Name: 'on-failure', MaximumRetryCount: 3 }; e.HostConfig.Memory = 268435456;
    const a2 = core.createArgsFromInspect(e, { name: 'twin', portMap: { '8080': 9090 } }).args.join(' '); ok(a2.includes('--entrypoint /entry.sh') && a2.includes('on-failure:3') && a2.includes('9090:8000/tcp') && a2.includes('--memory 268435456') && a2.includes('--name twin') && a2.includes('busybox:1.36 --x httpd'), a2);
  });
  await t('containers: things that cannot move are refused with a clear reason (privileged, GPU, custom network, docker.sock, odd paths)', async () => {
    const mk = (f: (x: any) => void) => { const x = baseInspect('app', ['80']) as any; f(x); return () => core.createArgsFromInspect(x); };
    const msg = (fn: () => unknown) => { try { fn(); return 'NO ERROR'; } catch (e: any) { return e.message; } };
    ok(/privileged/.test(msg(mk((x) => (x.HostConfig.Privileged = true)))), 'privileged'); ok(/GPU/.test(msg(mk((x) => (x.HostConfig.DeviceRequests = [{}])))), 'gpu');
    ok(/custom Docker network/.test(msg(mk((x) => (x.HostConfig.NetworkMode = 'mynet')))), 'network'); ok(/Docker socket/.test(msg(mk((x) => (x.Mounts = [{ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/s', RW: true }])))), 'sock');
    ok(/unsupported mount path/.test(msg(mk((x) => (x.Mounts = [{ Type: 'volume', Source: 'v', Destination: '/a;rm -rf /', RW: true }])))), 'path');
  });
  await t('containers: compose-managed containers are recognised from their labels, ports collected', async () => {
    const i = baseInspect('web-1', ['8000', '9000']) as any; i.Config.Labels = { 'com.docker.compose.project': 'shop', 'com.docker.compose.project.working_dir': 'D:\\shop' };
    const c = core.containerFromInspect(i); eq(c.composeProject, 'shop'); eq(c.composeDir, 'D:\\shop'); eq(c.ports.join(), '8000,9000'); eq(c.name, 'web-1');
  });

  const rdocker = (args: string[]) => ({ cmd: 'ssh', args: [...core.sshArgs(R), 'wsl.exe -e docker ' + args.slice(2).join(' ')] });   // stand-in "local" engine = the remote's own docker
  try {
    await t('clone (real engines): config + volume DATA are recreated faithfully in a twin container; size cap aborts cleanly', async () => {
      await core.wslSh(R, `docker rm -f pcbtest-src pcbtest-twin >/dev/null 2>&1; docker volume rm pcbtest-srcvol >/dev/null 2>&1; docker run -d --name pcbtest-src --stop-timeout 1 --restart unless-stopped -e FOO=bar -p 18095:8000 -v pcbtest-srcvol:/www busybox:1.36 sh -c 'echo SRC-DATA > /www/index.html; httpd -f -p 8000 -h /www'`, { timeout: 180000 });
      const msg = await core.cloneContainerToRemote(core.defaultConfig(), R, 'pcbtest-src', { remoteName: 'pcbtest-twin', portMap: { '18095': 18094 }, source: rdocker });
      ok(/created "pcbtest-twin"/.test(msg), msg);
      const r = await core.wslSh(R, `docker start pcbtest-twin >/dev/null; sleep 1; docker exec pcbtest-twin cat /www/index.html; docker inspect pcbtest-twin --format '{{.HostConfig.RestartPolicy.Name}}|{{.Config.Env}}|{{json .HostConfig.PortBindings}}'`, { timeout: 60000 });
      ok(r.stdout.includes('SRC-DATA'), 'data not copied: ' + r.stdout); ok(/unless-stopped\|\[.*FOO=bar.*\]\|.*18094/.test(r.stdout), 'config not copied: ' + r.stdout);
      const t0 = Date.now(); const cap = await core.copyBetween(rdocker(['--context', 'x', 'cp', 'pcbtest-src:/www', '-']), { cmd: 'ssh', args: [...core.sshArgs(R), 'wsl.exe -e docker cp - pcbtest-twin:/'] }, 100, 'cap test').then(() => 'no error', (e) => e.message);
      ok(/larger than/.test(cap) && Date.now() - t0 < 30000, `${cap} (${Date.now() - t0} ms)`); return msg;
    });
    await t('clone: a remote twin that already exists is used as is (never overwritten); failed clones leave nothing behind', async () => {
      const again = await core.cloneContainerToRemote(core.defaultConfig(), R, 'pcbtest-src', { remoteName: 'pcbtest-twin', source: rdocker }); ok(/already has/.test(again), again);
      const bad = await core.cloneContainerToRemote(core.defaultConfig(), R, 'pcbtest-src', { remoteName: 'pcbtest-twin2', portMap: { '18095': 18092 }, maxMB: 0, source: rdocker }).then(() => 'ok', (e) => e.message);
      ok(/larger than/.test(bad), bad); const left = await core.wslSh(R, `docker ps -a --format '{{.Names}}' | grep -c pcbtest-twin2; docker volume ls -q | grep -c pcb-pcbtest-twin2`); ok(!/[1-9]/.test(left.stdout.split('\n')[0]) , 'twin2 container left behind: ' + left.stdout);
    });
  } finally { await core.wslSh(R, `docker rm -f pcbtest-src pcbtest-twin pcbtest-twin2 >/dev/null 2>&1; docker volume rm pcbtest-srcvol pcb-pcbtest-twin-0 pcb-pcbtest-twin2-0 >/dev/null 2>&1; echo cleaned`, { timeout: 120000 }); }

  process.env.PCB_FAKE_DOCKER = path.join(__dirname, 'fakedocker.js'); process.env.PCB_FAKE_STATE = FSTATE;
  stateWrite({ down: false, containers: {
    'pcbtest-app': { inspect: baseInspect('pcbtest-app', [String(APORT)]), port: APORT, pid: 0, dataDir: data },
    'pcbtest-noport': { inspect: baseInspect('pcbtest-noport', [], []), port: 18091, pid: 0, dataDir: data } } });
  const acfg = core.defaultConfig(); acfg.projects = []; const afwd = new core.Forwarder(); const aoff = new core.Offloader(() => acfg, () => { /* not persisted */ }, afwd);
  const aget = async () => (await fetch(`http://127.0.0.1:${APORT}/index.html`, { signal: AbortSignal.timeout(6000) })).text();
  const badPoll = (): core.Status => ({ ...st, ts: Date.now(), ssh: { ok: false, latencyMs: null, error: 'x', headline: 'simulated outage', checklist: [] }, portsUp: undefined });
  const goodPoll = (): core.Status => ({ ...st, ts: Date.now(), ssh: { ok: true, latencyMs: 20 }, portsUp: { [String(APORT)]: true } });
  const ap = () => acfg.projects.find((x) => x.name === 'pcbtest-app')!;
  try {
    await t('any container: listing the local engine finds it with its published ports', async () => {
      await core.dk(['start', 'pcbtest-app']); await until(async () => (await aget().catch(() => '')).includes('FAKE-LOCAL-SERVED'), 8000, 'fake local container');
      const l = await core.listLocalContainers(acfg); const c = l.find((x) => x.name === 'pcbtest-app')!; eq(c.ports.join(), String(APORT)); eq(c.state, 'running');
    });
    await t('any container: one without published ports is refused clearly, nothing changed', async () => {
      const m = await aoff.adoptAndOffload('pcbtest-noport').then(() => 'ok', (e) => e.message); ok(/publishes no ports/.test(m), m); ok(!acfg.projects.length, 'project was created');
    });
    await t('any container: ADOPT = twin created on the remote WITH its data, local stopped, localhost now answered by the REMOTE', async () => {
      const m = await aoff.adoptAndOffload('pcbtest-app'); ok(/served by the remote/.test(m), m);
      eq(ap().mode, 'remote'); ok((await aget()).includes('COPIED-FROM-LOCAL'), 'not served by the remote twin'); eq(stateRead().containers['pcbtest-app'].pid, 0, 'local copy still running'); ok(ap().autoOffload, 'policy not stored'); return m;
    });
    await t('apps: a Docker container is a member too (home, send again, same state afterwards)', async () => {
      const M: apps.AppMember = { kind: 'container', name: 'pcbtest-app' }; acfg.apps = [{ name: 'pcbtest-capp', members: [M] }];
      const cd: apps.AppDeps = { where: () => (ap() && ap().mode === 'remote' ? R.name : apps.HERE), ports: () => ap()?.ports ?? [], holder: async () => null, moveProgram: async () => '', homeProgram: async () => '',
        offloadContainer: async (m, to) => { const r = await aoff.adoptAndOffload(m.name, 100, to); m.project = ap().name; return r; }, homeContainer: async (m) => { await aoff.bringHome(ap().name); void m; }, testPort: async (port) => { const r = await setup.testPort(port); return { ok: r.ok, detail: r.detail, ms: r.ms }; }, save: () => {} };
      eq(apps.statusApp(acfg, cd, acfg.apps[0]).where, R.name); eq((await apps.sendApp(acfg, cd, 'pcbtest-capp', { target: R.name }))[0], 'pcbtest-app: already on ' + R.name);
      await apps.homeApp(acfg, cd, 'pcbtest-capp'); eq(ap().mode, 'local'); await until(async () => (await aget().catch(() => '')).includes('FAKE-LOCAL-SERVED'), 15000, 'container serving here again');
      const out = await apps.sendApp(acfg, cd, 'pcbtest-capp', { target: R.name }); ok(/now on/.test(out[0]), out.join()); eq(ap().mode, 'remote'); ok((await aget()).includes('COPIED-FROM-LOCAL'), 'not served by the remote twin'); eq(M.project, 'pcbtest-app'); acfg.apps = [];
    });
    await t('failover: remote dies AND local Docker is not running -> Docker "Desktop" is started, container comes back on this PC', async () => {
      const s = stateRead(); s.down = true; s.upAt = 0; stateWrite(s);
      for (let i = 0; i < 3; i++) await aoff.onStatus(badPoll()); eq(ap().mode, 'local'); eq(ap().failedOver, true);
      await until(async () => (await aget().catch(() => '')).includes('FAKE-LOCAL-SERVED:pcbtest-app'), 15000, 'local container serving again'); eq(afwd.get(APORT)?.state, 'stopped');
    });
    await t('prefer-remote: after the failover the site goes back to the remote automatically once the remote is healthy for ~15 polls', async () => {
      for (let i = 0; i < 15; i++) await aoff.onStatus(goodPoll()); eq(ap().mode, 'remote'); ok((await aget()).includes('COPIED-FROM-LOCAL'), 'not remote');
    });
    await t('manual "bring back" is respected: no automatic re-offload until the user offloads again', async () => {
      await aoff.bringHome('pcbtest-app'); eq(ap().mode, 'local'); eq(ap().paused, true);
      for (let i = 0; i < 25; i++) await aoff.onStatus(goodPoll()); eq(ap().mode, 'local', 'it moved back by itself'); await aoff.offload('pcbtest-app'); eq(ap().paused, false); eq(ap().mode, 'remote');
    });
    await t('quit safety: closing the app brings offloaded containers back to this PC (and does not pause auto-offload)', async () => {
      await aoff.bringHome('pcbtest-app', 'quit'); eq(ap().mode, 'local'); ok(!ap().paused, 'paused after quit'); await until(async () => (await aget().catch(() => '')).includes('FAKE-LOCAL-SERVED'), 10000, 'local not serving');
      ok((await core.wslSh(R, 'docker ps --format {{.Names}}')).stdout.includes('pcbtest-app'), 'remote twin should keep running');
    });
    // ---------- weighted split between this PC and the remote ----------
    const rawGet = (host: string) => new Promise<string>((res) => { const q = http.get({ host, port: APORT, path: '/index.html', agent: false, timeout: 8000 }, (x) => { let o = ''; x.on('data', (d) => (o += d)); x.on('end', () => res(o.includes('FAKE-LOCAL') ? 'local' : o.includes('COPIED-FROM-LOCAL') ? 'remote' : 'other:' + o.slice(0, 30))); }); q.on('error', () => res('ERR')); q.on('timeout', () => { q.destroy(); res('ERR'); }); });
    const burst = async (n: number, host = '127.0.0.1', par = 8) => { const c: Record<string, number> = {}; let left = n; await Promise.all(Array.from({ length: par }, async () => { while (left-- > 0) { const k = await rawGet(host); c[k] = (c[k] || 0) + 1; } })); return c; };
    const near = (got: number, want: number, tol: number, what: string) => ok(Math.abs(got - want) <= tol, `${what}: got ${got}, wanted ${want} +-${tol}`);
    await t('split: invalid shares are rejected before anything is touched', async () => {
      for (const bad of [101, -1, 1.5, NaN]) { const m = await aoff.setShare('pcbtest-app', bad as number).then(() => 'ok', (e) => e.message); ok(/0 to 100/.test(m), String(bad) + ': ' + m); }
      eq(ap().mode, 'local'); ok(!aoff.bal.has(APORT), 'balancer started');
    });
    await t('split: a container the remote does not have -> clear error, nothing changed, no proxy left behind', async () => {
      acfg.projects.push({ name: 'pcbtest-ghost', path: '', container: 'pcbtest-ghost', ports: [18093], mode: 'local' });
      const m = await aoff.setShare('pcbtest-ghost', 50).then(() => 'ok', (e) => e.message); ok(/no container named/.test(m), m);
      eq(acfg.projects.find((x) => x.name === 'pcbtest-ghost')!.mode, 'local'); ok(!aoff.bal.has(18093), 'proxy left'); acfg.projects = acfg.projects.filter((x) => x.name !== 'pcbtest-ghost');
    });
    await t('split 50/50: both PCs really serve, localhost keeps working, split is exact', async () => {
      await core.dk(['start', 'pcbtest-app']);
      const m = await aoff.setShare('pcbtest-app', 50); ok(/split active/.test(m), m); eq(ap().mode, 'split'); eq(ap().share, 50); ok(aoff.bal.has(APORT), 'proxy not running');
      const c = await burst(200); near(c.local || 0, 100, 2, 'local'); near(c.remote || 0, 100, 2, 'remote'); eq(Object.keys(c).filter((k) => k !== 'local' && k !== 'remote').length, 0, JSON.stringify(c)); return JSON.stringify(c);
    });
    await t('split 80/20 (live change, no restart): exact proportions', async () => {
      await aoff.setShare('pcbtest-app', 80); aoff.bal.resetStats(APORT); const c = await burst(250); near(c.remote || 0, 200, 3, 'remote'); near(c.local || 0, 50, 3, 'local');
      const st0 = aoff.bal.stats(APORT); eq(st0.find((b) => b.name === 'remote')!.conns + st0.find((b) => b.name === 'local')!.conns, 250, 'balancer counters disagree with client count'); return JSON.stringify(c);
    });
    await t('split: localhost over IPv6 (::1) goes through the same split', async () => { aoff.bal.resetStats(APORT); const c = await burst(50, '::1'); ok((c.remote || 0) > 30 && (c.local || 0) > 0 && !c.ERR, JSON.stringify(c)); });
    await t('split: remote reported unhealthy -> ALL traffic goes to this PC with zero client errors; recovers by itself', async () => {
      await aoff.onStatus(badPoll()); const c = await burst(60); eq(c.local || 0, 60, JSON.stringify(c)); eq(c.ERR || 0, 0);
      await aoff.onStatus({ ...goodPoll(), portsUp: { [String(APORT)]: true } }); aoff.bal.resetStats(APORT); const d = await burst(100); ok((d.remote || 0) > 60, 'remote not used again: ' + JSON.stringify(d));
    });
    await t('split: the ssh tunnel to the remote is killed -> still zero client errors (retried on this PC), then reconnects', async () => {
      afwd.simulateDrop(ap().altPort!); const c = await burst(40, '127.0.0.1', 4); eq(c.ERR || 0, 0, JSON.stringify(c)); ok((c.local || 0) > 0, 'no local');
      await until(() => afwd.get(ap().altPort!)?.state === 'active', 20000, 'tunnel active again'); aoff.bal.resetStats(APORT); await sleep(4500); const d = await burst(60); ok((d.remote || 0) > 30, JSON.stringify(d));
    });
    await t('split -> 0%: everything on this PC, remote copy stopped, proxy gone, auto-offload paused', async () => {
      await aoff.setShare('pcbtest-app', 0); eq(ap().mode, 'local'); ok(!aoff.bal.has(APORT), 'proxy still running'); const c = await burst(20); eq(c.local || 0, 20, JSON.stringify(c)); eq(ap().paused, true);
      await until(async () => !(await core.wslSh(R, 'docker ps --format {{.Names}}')).stdout.includes('pcbtest-app'), 20000, 'remote copy stopped');
    });
    await t('0% -> 100% -> 30%: moves fully to the remote, then splits again from the remote side', async () => {
      await aoff.setShare('pcbtest-app', 100); eq(ap().mode, 'remote'); eq((await burst(10)).remote || 0, 10);
      await aoff.setShare('pcbtest-app', 30); eq(ap().mode, 'split'); aoff.bal.resetStats(APORT); const c = await burst(100); near(c.remote || 0, 30, 3, 'remote'); near(c.local || 0, 70, 3, 'local');
    });
    await t('split: quit while split -> proxy and tunnel removed, this PC serves directly, remote twin stays up', async () => {
      await aoff.bringHome('pcbtest-app', 'quit'); eq(ap().mode, 'local'); ok(!aoff.bal.has(APORT), 'proxy running'); ok(!ap().altPort || afwd.get(ap().altPort!)?.state === 'stopped', 'alt tunnel still up');
      const c = await burst(20); eq(c.local || 0, 20, JSON.stringify(c)); ok((await core.wslSh(R, 'docker ps --format {{.Names}}')).stdout.includes('pcbtest-app'), 'remote twin stopped');
    });
    await t('split: app restart while split -> proxy + tunnel are rebuilt from the saved share', async () => {
      await aoff.setShare('pcbtest-app', 40); const saved = JSON.parse(JSON.stringify(acfg)); aoff.bal.stopAll(); afwd.stopAll();
      const f2 = new core.Forwarder(); const o2 = new core.Offloader(() => saved, () => 0, f2); const sp = saved.projects.find((x: core.Project) => x.name === 'pcbtest-app')!; eq(sp.mode, 'split');
      try { await o2.onStatus(goodPoll()); ok(o2.bal.has(APORT), 'proxy not rebuilt'); const c = await burst(100); near(c.remote || 0, 40, 3, 'remote'); } finally { o2.bal.stopAll(); f2.stopAll(); }
      acfg.projects.find((x) => x.name === 'pcbtest-app')!.mode = 'local';
    });
  } finally {
    afwd.stopAll(); aoff.bal.stopAll(); await core.dk(['stop', 'pcbtest-app']).catch(() => 0); delete process.env.PCB_FAKE_DOCKER; delete process.env.PCB_FAKE_STATE;
    await t('cleanup (containers): remote twin, volumes and test image removed', async () => {
      await core.wslSh(R, `docker rm -f pcbtest-app >/dev/null 2>&1; docker volume rm pcb-pcbtest-app-0 >/dev/null 2>&1; ${hadBusybox ? '' : 'docker rmi busybox:1.36 >/dev/null 2>&1;'} docker ps -a --format '{{.Names}}'`, { timeout: 120000 });
      const left = (await core.wslSh(R, `docker ps -a --format '{{.Names}}' | grep -c pcbtest`)).stdout.trim(); eq(left, '0', 'pcbtest containers left on remote');
    });
  }

  // ---------- this PC's own stats ----------
  await t('local metrics: CPU / RAM / disks / GPU for THIS PC are real numbers', async () => {
    await core.localMetrics(); await sleep(1200); const m = await core.localMetrics();
    ok(m.cpu >= 0 && m.cpu <= 100, 'cpu ' + m.cpu); ok(m.ramTotalMB > 4000 && m.ramUsedMB > 0 && m.ramUsedMB <= m.ramTotalMB, 'ram'); ok(m.disks.some((d) => d.id === 'C:' && d.totalGB > 20 && d.freeGB > 0), 'C: missing');
    ok(m.host.length > 0, 'hostname'); ok(!m.nvidia || /RTX|GeForce|NVIDIA/i.test(m.nvidia), 'gpu string ' + m.nvidia);
    return `${m.host} cpu=${m.cpu}% ram=${(m.ramUsedMB / 1024).toFixed(1)}/${(m.ramTotalMB / 1024).toFixed(1)}GB disks=${m.disks.map((d) => d.id + d.freeGB).join(',')} gpu=${m.nvidia ?? 'none'}`;
  });
  await t('local metrics: never blocks (returns < 3 s even with sleeping/cloud drives)', async () => { const t0 = Date.now(); await core.localMetrics(); ok(Date.now() - t0 < 3000, 'took ' + (Date.now() - t0)); });

  // ---------- the weighted load balancer itself (no remote, no docker): exactness, failure handling, protocol edge cases ----------
  {
    const { Balancer } = await import('../src/balancer');
    const lan = core.localBackendHost(); const P = 18331, Q = 18332, W = 18333;
    const mkSrv = (host: string, port: number, tag: string, ka = false) => new Promise<http.Server>((res) => { const s = http.createServer((q, r) => { let n = 0; q.on('data', (d) => (n += d.length)); q.on('end', () => { r.setHeader('connection', ka ? 'keep-alive' : 'close'); r.end(`${tag}:${q.method}:${n}`); }); }); s.keepAliveTimeout = 30000; s.listen(port, host, () => res(s)); });
    const one = (host: string, port: number, method = 'GET', body = '') => new Promise<string>((res) => { const q = http.request({ host, port, method, path: '/', agent: false, timeout: 6000 }, (x) => { let o = ''; x.on('data', (d) => (o += d)); x.on('end', () => res(o)); }); q.on('error', () => res('ERR')); q.on('timeout', () => { q.destroy(); res('ERR'); }); q.end(body); });
    const tally = async (n: number, host: string, port: number, par = 10) => { const c: Record<string, number> = {}; let left = n; await Promise.all(Array.from({ length: par }, async () => { while (left-- > 0) { const k = (await one(host, port)).split(':')[0]; c[k] = (c[k] || 0) + 1; } })); return c; };
    const A = await mkSrv('0.0.0.0', P, 'A'), B = await mkSrv('127.0.0.1', Q, 'B'); const bal = new Balancer();
    try {
      await t('balancer: proxy owns 127.0.0.1:port while the real server keeps the wildcard port (Windows semantics the split relies on)', async () => {
        await bal.start(P, [{ name: 'local', host: lan, port: P, weight: 50 }, { name: 'remote', host: '127.0.0.1', port: Q, weight: 50 }]);
        eq((await one(lan, P)).split(':')[0], 'A', 'LAN address must reach the real server directly'); const c = await tally(20, '127.0.0.1', P); eq(c.A, 10); eq(c.B, 10); const d = await tally(20, '::1', P); eq(d.A + d.B, 20, JSON.stringify(d)); eq(d.A, 10);
      });
      for (const [lw, rw] of [[100, 0], [0, 100], [50, 50], [80, 20], [20, 80], [90, 10], [70, 30], [1, 99]] as [number, number][]) await t(`balancer: ${lw}/${rw} is exact over 200 connections`, async () => {
        bal.setWeights(P, { local: lw, remote: rw }); const c = await tally(200, '127.0.0.1', P); eq(c.A || 0, lw * 2, JSON.stringify(c)); eq(c.B || 0, rw * 2, JSON.stringify(c));
      });
      await t('balancer: a dead backend -> zero client errors, all traffic on the other; it comes back automatically', async () => {
        bal.setWeights(P, { local: 50, remote: 50 }); B.close(); const c = await tally(60, '127.0.0.1', P); eq(c.A, 60, JSON.stringify(c)); ok(bal.stats(P).find((b) => b.name === 'remote')!.down, 'not marked down');
        const B2 = await mkSrv('127.0.0.1', Q, 'B'); bal.setWeights(P, { local: 50, remote: 50 }); const d = await tally(40, '127.0.0.1', P); eq(d.B || 0, 20, JSON.stringify(d)); B2.close();
      });
      await t('balancer: zero-weight backend is standby only (used when every weighted backend is down)', async () => {
        const B3 = await mkSrv('127.0.0.1', Q, 'B'); bal.setWeights(P, { local: 0, remote: 100 }); eq((await tally(10, '127.0.0.1', P)).B, 10); B3.close(); await sleep(100);
        const c = await tally(10, '127.0.0.1', P); eq(c.A, 10, 'standby local should take over: ' + JSON.stringify(c));
      });
      await t('balancer: large payloads arrive intact in both directions, half-close is honoured', async () => {
        const echo = net.createServer({ allowHalfOpen: true }, (c) => { c.pipe(c); }); await new Promise<void>((r) => echo.listen(W + 1, '127.0.0.1', () => r()));
        const b2 = new Balancer(); await b2.start(W, [{ name: 'a', host: '127.0.0.1', port: W + 1, weight: 1 }]);
        try {
          const data = crypto.randomBytes(3 * 1024 * 1024); const got = await new Promise<Buffer>((res, rej) => { const c = net.connect({ host: '127.0.0.1', port: W, allowHalfOpen: true }); const parts: Buffer[] = []; c.on('data', (d: Buffer) => parts.push(d)); c.on('end', () => res(Buffer.concat(parts))); c.on('error', rej); c.end(data); });
          eq(got.length, data.length, 'length'); ok(got.equals(data), 'bytes differ');
        } finally { b2.stopAll(); echo.close(); }
      });
      await t('balancer: a backend that accepts then closes without answering (dead ssh tunnel) -> a GET is retried on the other backend, a POST is not replayed', async () => {
        const dead = net.createServer((c) => { c.once('data', () => c.destroy()); }); await new Promise<void>((r) => dead.listen(W + 2, '127.0.0.1', () => r()));
        const live = await mkSrv('127.0.0.1', W + 3, 'L'); const b3 = new Balancer(); await b3.start(W + 4, [{ name: 'dead', host: '127.0.0.1', port: W + 2, weight: 100 }, { name: 'live', host: '127.0.0.1', port: W + 3, weight: 0 }]);
        try {
          eq((await one('127.0.0.1', W + 4, 'GET')).split(':')[0], 'L', 'GET not retried');
          b3.setWeights(W + 4, { dead: 100, live: 0 }); const post = await one('127.0.0.1', W + 4, 'POST', 'x=1'); eq(post, 'ERR', 'a POST that reached a backend must never be replayed: ' + post);
        } finally { b3.stopAll(); dead.close(); live.close(); }
      });
      await t('balancer: HTTP keep-alive pins a client to ONE backend (so the share is per CONNECTION, not per request)', async () => {
        const K1 = await mkSrv('127.0.0.1', W + 5, 'K1', true), K2 = await mkSrv('127.0.0.1', W + 6, 'K2', true); const b4 = new Balancer();
        await b4.start(W + 7, [{ name: 'k1', host: '127.0.0.1', port: W + 5, weight: 50 }, { name: 'k2', host: '127.0.0.1', port: W + 6, weight: 50 }]);
        try {
          const ag = new http.Agent({ keepAlive: true, maxSockets: 1 }); const seen = new Set<string>();
          for (let i = 0; i < 30; i++) seen.add((await new Promise<string>((res) => http.get({ host: '127.0.0.1', port: W + 7, path: '/', agent: ag }, (x) => { let o = ''; x.on('data', (d) => (o += d)); x.on('end', () => res(o)); }).on('error', () => res('ERR')))).split(':')[0]);
          ag.destroy(); eq(seen.size, 1, [...seen].join());
          const many = new Set<string>(); for (let i = 0; i < 20; i++) many.add((await one('127.0.0.1', W + 7)).split(':')[0]); eq(many.size, 2, 'new connections must alternate');
        } finally { b4.stopAll(); K1.close(); K2.close(); }
      });
      await t('balancer: 300 concurrent connections, counters match what the clients saw', async () => {
        const B4 = await mkSrv('127.0.0.1', Q, 'B'); bal.setWeights(P, { local: 60, remote: 40 }); bal.resetStats(P); const c = await tally(300, '127.0.0.1', P, 60); eq((c.A || 0) + (c.B || 0), 300, JSON.stringify(c)); eq(c.A, 180); eq(c.B, 120);
        const st = bal.stats(P); eq(st[0].conns + st[1].conns, 300, 'server-side counters'); B4.close();
      });
      await t('balancer: port already taken -> clear error, nothing listening afterwards', async () => {
        const hog = net.createServer(); await new Promise<void>((r) => hog.listen(W + 8, '127.0.0.1', () => r())); const b5 = new Balancer();
        const m = await b5.start(W + 8, [{ name: 'x', host: '127.0.0.1', port: Q, weight: 1 }]).then(() => 'ok', (e) => e.message); ok(/already taken/.test(m), m); ok(!b5.has(W + 8), 'registered anyway'); hog.close();
      });
    } finally { bal.stopAll(); A.close(); B.close(); }
  }

  // ---------- the searxng:8080 scenario: tools on THIS PC talk to localhost, the REMOTE does the work ----------
  const SX = (await core.portFree(8080)) ? 8080 : 18080, sxf = new core.Forwarder();
  try {
    await t(`searxng: remote container is running (precondition) [local port ${SX}${SX === 8080 ? '' : ' - 8080 is busy locally, so testing on 18080'}]`, async () => {
      const s = await core.getStatus(R); const c = s.docker?.containers.find((x) => x.name === 'searxng'); ok(c && c.state === 'running', 'searxng not running on remote: ' + JSON.stringify(c));
    });
    await t('searxng: with NO forward nothing answers locally (so any answer later must come from the remote)', async () => {
      const r = await core.testForward(SX); eq(r.ok, false, 'something already answers on ' + SX); ok(/not running|nothing is listening/.test(r.error!), r.error!);
      const local = (await core.run('docker', ['--context', lctx, 'ps', '--format', '{{.Names}} {{.Ports}}'])).stdout; ok(!new RegExp(`:${SX}->`).test(local), 'a LOCAL container publishes ' + SX + ': ' + local);
    });
    await t('searxng: forward up -> real searxng answers on localhost (healthz + home page + a search)', async () => {
      await sxf.start(R, { name: 'searxng', localPort: SX, remotePort: 8080, remoteHost: '127.0.0.1' }); await until(() => sxf.get(SX)?.state === 'active', 10000, 'forward active');
      const base = `http://127.0.0.1:${SX}`; const h = await fetch(base + '/healthz', { signal: AbortSignal.timeout(8000) }); eq(h.status, 200); ok((await h.text()).trim() === 'OK', 'healthz body');
      const home = await (await fetch(base + '/', { signal: AbortSignal.timeout(8000) })).text(); ok(/searx/i.test(home), 'home page is not searxng');
      const sr = await fetch(base + '/search?q=hello', { signal: AbortSignal.timeout(30000) }); ok(sr.status === 200, 'search status ' + sr.status); ok(/hello/i.test(await sr.text()), 'search page missing query');
      const tf = await core.testForward(SX); ok(tf.ok && tf.status === 200, JSON.stringify(tf)); return `HTTP test ${tf.ms} ms`;
    });
    await t('searxng: the local port is owned by ssh.exe only (no local server doing the work)', async () => {
      const x = await core.run('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${SX} -State Listen | % { (Get-Process -Id $_.OwningProcess).ProcessName }) -join ','`], { timeout: 20000 });
      ok(/^ssh(,ssh)*$/.test(x.stdout.trim()), 'listener(s): ' + x.stdout.trim());
    });
    await t('searxng: 300 requests (10 parallel) cost this PC almost nothing (CPU time of the ssh tunnel measured directly)', async () => {
      const cpuSecs = async () => Number((await core.run('powershell', ['-NoProfile', '-Command', `(Get-Process ssh -ErrorAction SilentlyContinue | Measure-Object TotalProcessorTime -Sum).Sum.TotalSeconds`], { timeout: 20000, poll: true })).stdout.trim() || 0);
      const c0 = await cpuSecs(); const t0 = Date.now(); let bad = 0, n = 0;
      const worker = async () => { while (n < 300) { n++; try { const r = await fetch(`http://127.0.0.1:${SX}/healthz`, { signal: AbortSignal.timeout(8000) }); if (r.status !== 200) bad++; await r.text(); } catch { bad++; } } };
      await Promise.all(Array.from({ length: 10 }, worker)); const secs = (Date.now() - t0) / 1000; const used = (await cpuSecs()) - c0;
      eq(bad, 0, 'failed requests'); ok(used < 4, `ssh tunnel used ${used.toFixed(2)} CPU-seconds for 300 requests`);
      return `300 req in ${secs.toFixed(1)} s (${(300 / secs).toFixed(0)}/s); ssh tunnel CPU = ${used.toFixed(2)} s total (${(100 * used / secs).toFixed(1)}% of one core)`;
    });
    await t('searxng: killing the tunnel -> auto-reconnect -> answers again', async () => {
      sxf.simulateDrop(SX); await until(() => sxf.get(SX)!.state === 'reconnecting', 5000, 'reconnecting'); await until(() => sxf.get(SX)!.state === 'active', 20000, 'active');
      await until(async () => (await core.testForward(SX)).ok, 15000, 'answers again');
    });
    await t('searxng: stop forward -> local port closes immediately (no leftovers)', async () => {
      sxf.stop(SX); await until(async () => !(await core.testForward(SX)).ok, 8000, 'port closed'); ok(await core.portFree(SX), 'port still held');
    });
    await t('searxng: remote searxng container was never touched (same container, still running)', async () => {
      const s = await core.getStatus(R); const c = s.docker!.containers.find((x) => x.name === 'searxng')!; ok(c.state === 'running', 'not running'); return c.status;
    });
  } finally { sxf.stopAll(); }

  // ---------- connect-a-PC wizard, routes (Tailscale + same-LAN fallback), self tests ----------
  {
    const setup = await import('../src/setup');
    await t('wizard: parsePeers understands tailscale status (self, online and offline peers, IPv4 pick)', async () => {
      const ps = setup.parsePeers({ Self: { HostName: 'dell', DNSName: 'dell.tail.ts.net.', TailscaleIPs: ['fd7a::1', '100.1.1.1'], OS: 'windows' }, Peer: { a: { HostName: 'desk', DNSName: 'desk.tail.ts.net.', TailscaleIPs: ['100.2.2.2'], OS: 'windows', Online: true }, b: { HostName: 'phone', TailscaleIPs: [], OS: 'android', Online: false } } });
      eq(ps.length, 3); eq(ps[0].self, true); eq(ps[0].ip4, '100.1.1.1'); eq(ps[1].online, true); eq(ps[1].dns, 'desk.tail.ts.net'); eq(ps[2].online, false); eq(ps[2].ip4, undefined);
    });
    await t('wizard: discovers the real tailnet and finds the remote PC with SSH open', async () => {
      const peers = await setup.discoverPeers(); const me = peers.find((p) => p.ip4 === R.host); ok(!!me, 'remote not in tailnet list: ' + peers.map((p) => p.name).join()); ok(me!.online && me!.sshOpen === true, JSON.stringify(me)); ok(peers.some((p) => p.self), 'self missing'); return peers.map((p) => `${p.name}${p.sshOpen ? ' (ssh)' : ''}`).join(', ');
    });
    let realCheck: Awaited<ReturnType<typeof setup.checkRemote>>;
    await t('wizard: full check of the real remote -> every step ok, system info read, nothing changed', async () => {
      realCheck = await setup.checkRemote({ host: R.host, user: R.user, keyPath: R.keyPath }); const bad = realCheck.steps.filter((s) => s.ok === false); eq(bad.length, 0, JSON.stringify(bad)); ok(realCheck.ready, 'not ready');
      for (const id of ['key', 'reach', 'login', 'system', 'wsl', 'docker', 'shim']) ok(realCheck.steps.some((s) => s.id === id && s.ok), 'step ' + id); ok(realCheck.info!.host.toLowerCase().includes(R.name.toLowerCase()), realCheck.info!.host); return realCheck.steps.map((s) => s.id + ':' + s.ok).join(' ');
    });
    await t('wizard: wrong user name -> stops at sign-in with the exact public key + where to put it (never edits authorized_keys)', async () => {
      const c = await setup.checkRemote({ host: R.host, user: 'nosuchuser99', keyPath: R.keyPath }); const l = c.steps.find((s) => s.id === 'login')!; eq(l.ok, false); ok(/authorized_keys/.test(l.fix || '') && /ssh-ed25519/.test(l.fix || ''), l.fix || ''); ok(!c.steps.some((s) => s.id === 'system'), 'went on after failed login'); eq(c.ready, false);
    });
    await t('wizard: missing key file -> says so, lists keys that exist, does not touch the network further', async () => {
      const c = await setup.checkRemote({ host: R.host, user: R.user, keyPath: path.join(tmp, 'nokey') }); eq(c.steps.find((s) => s.id === 'key')!.ok, false); ok(/ssh-keygen|Keys found/.test(c.steps[0].fix || ''), c.steps[0].fix || ''); eq(c.ready, false);
    });
    await t('wizard: unreachable PC -> clear "not answering" step with the checklist hint', async () => {
      const c = await setup.checkRemote({ host: '100.64.255.254', user: R.user, keyPath: R.keyPath }); const s = c.steps.find((x) => x.id === 'reach')!; eq(s.ok, false); ok(/sshd|Tailscale/.test(s.fix || ''), s.fix || ''); eq(c.steps.length, 2);
    });
    await t('wizard: installing docker.cmd needs explicit confirmation; when it already exists nothing is overwritten', async () => {
      const m = await setup.installShim({ host: R.host, user: R.user, keyPath: R.keyPath }, false as any).then(() => 'ok', (e) => e.message); ok(/explicit confirmation/.test(m), m);
      const done = await setup.installShim({ host: R.host, user: R.user, keyPath: R.keyPath }, true); ok(/already there/.test(done), done);
    });
    await t('wizard: applyRemote adds a PC, merges fallback addresses on update, can make it active, rejects bad input', async () => {
      const cfg = core.defaultConfig(); const i = setup.applyRemote(cfg, { name: 'lab', host: '100.9.9.9', user: 'bob', routes: ['192.168.1.50'] }, false); eq(i, 1); eq(cfg.activeRemote, 0); eq(core.validateConfig(cfg).length, 0);
      const j = setup.applyRemote(cfg, { host: '100.9.9.9', user: 'bob', routes: ['10.0.0.7'] }, true); eq(j, 1); eq(cfg.activeRemote, 1); eq(cfg.remotes[1].routes!.join(), '192.168.1.50,10.0.0.7'); eq(cfg.remotes.length, 2);
      cfg.remotes[1].routes!.push('-oProxyCommand=evil'); ok(core.validateConfig(cfg).some((e) => /extra address/.test(e)), 'option-injection address accepted');
    });
    // --- routes: primary stays while it works, fallback while it does not, back after 5 good polls (127.0.0.x aliases stand in for "Tailscale IP" and "LAN IP")
    await t('routes: stays on the main address; falls back to the LAN address when it dies; returns after 5 stable polls (no flapping)', async () => {
      const PORT = 18401; const mk = (h: string) => new Promise<net.Server>((res) => { const s = net.createServer((c) => c.end()); s.listen(PORT, h, () => res(s)); });
      const rr: core.Remote = { name: 'route-test', host: '127.0.0.2', user: 'x', keyPath: R.keyPath, port: PORT, contextName: 'remote', routes: ['127.0.0.3'] }; let a = await mk('127.0.0.2'); const b = await mk('127.0.0.3');
      try {
        eq((await core.probeRoutes(rr)).host, '127.0.0.2'); a.close(); await sleep(100); const f = await core.probeRoutes(rr); eq(f.host, '127.0.0.3'); ok(!f.primary, 'primary flag'); ok(core.sshArgs(rr).includes('HostKeyAlias=127.0.0.2'), 'known_hosts alias missing: ' + core.sshArgs(rr).join(' '));
        a = await mk('127.0.0.2'); for (let i = 0; i < 4; i++) eq((await core.probeRoutes(rr)).host, '127.0.0.3', 'flapped back too early at poll ' + i); eq((await core.probeRoutes(rr)).host, '127.0.0.2', 'did not return to the main address'); ok(!core.sshArgs(rr).some((x) => x.startsWith('HostKeyAlias')), 'alias on main address');
        a.close(); b.close(); await sleep(100); eq((await core.probeRoutes(rr)).host, '127.0.0.2', 'both down: keep the main address');
      } finally { a.close(); b.close(); }
    });
    await t('routes: main address dead, backup alive -> the backup is chosen (probe level, real ports)', async () => {
      const rr: core.Remote = { ...R, name: 'fallback-test', host: '100.64.255.254', routes: [R.host] }; const i = await core.probeRoutes(rr); eq(i.host, R.host); ok(!i.primary, 'should be on the backup address');
    });
    await t('same Wi-Fi / LAN (real ssh): the LAN address of the remote is used as the backup route with the SAME host key, known_hosts untouched', async () => {
      const lan = realCheck!.info!.lan.filter((h) => /^(192.168|10.|172.(1[6-9]|2d|3[01]))/.test(h)); if (!lan.length) return 'remote reports no private LAN address (nothing to test)';
      const reach = (await Promise.all(lan.map(async (h) => ({ h, up: (await core.tcpProbe(h, 22, 2500)).ok })))).filter((x) => x.up);
      if (!reach.length) return `LAN address(es) ${lan.join(', ')} not reachable from this PC right now (different network): route logic is covered by the other route tests`;
      const khFile = path.join(os.homedir(), '.ssh', 'known_hosts'); const before = fs.existsSync(khFile) ? fs.readFileSync(khFile, 'utf8') : '';
      const rr: core.Remote = { ...R, name: 'lan-test', routes: [reach[0].h] }; core.forceRoute(rr, reach[0].h);   // as if Tailscale had just died
      try { const x = await core.ssh(rr, 'echo LAN_OK'); ok(x.code === 0 && x.stdout.includes('LAN_OK'), x.stderr); ok(core.sshArgs(rr).includes('HostKeyAlias=' + R.host), 'alias missing'); } finally { core.forceRoute(rr, R.host); }
      eq(fs.existsSync(khFile) ? fs.readFileSync(khFile, 'utf8') : '', before, 'known_hosts changed'); return 'ssh over LAN ' + reach[0].h + ' ok';
    });
    await t('self tests: connection test reports every check for the real remote, all green', async () => {
      const cfg = core.defaultConfig(); const f = new core.Forwarder(); const o = new core.Offloader(() => cfg, () => 0, f);
      const res = await setup.testConnection({ config: cfg, fwd: f, off: o, status: null, selfPid: process.pid, uiPort: 0 }); ok(res.length >= 7, 'too few checks: ' + res.length);
      const bad = res.filter((x) => !x.ok && !x.warn); eq(bad.length, 0, JSON.stringify(bad)); return res.map((x) => (x.ok ? (x.warn ? '~' : '✓') : '✗') + x.name.split(' ')[0]).join(' ');
    });
    await t('self tests: port test tells a listening HTTP server from a closed port', async () => {
      const s = http.createServer((_q, r) => r.end('hi')); await new Promise<void>((r) => s.listen(18402, '127.0.0.1', () => r()));
      try { const a = await setup.testPort(18402); ok(a.ok && /HTTP 200/.test(a.detail), a.detail); } finally { s.close(); }
      const b = await setup.testPort(18402); eq(b.ok, false); ok(/nothing listens/.test(b.detail), b.detail);
    });
  }

  // ---------- the real service (no Electron): HTTP API, security checks, memory ----------
  const root = path.join(__dirname, '..', '..');
  const safeCfg = (() => { const c = core.defaultConfig(); c.projects.forEach((p) => (p.autoOffload = false)); c.keepAwake = false; return c; })();   // a test service must never offload the user's real containers
  const svc = async (name: string, cfg: object | null, check: (api: (ch: string, ...a: unknown[]) => Promise<any>, port: number, cookie: string, firstStatus: any) => Promise<void>) => t(name, async () => {
    const ud = path.join(tmp, 'ud-' + name.length); fs.mkdirSync(ud, { recursive: true }); if (cfg) fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify(cfg));
    const p = spawn(process.execPath, [path.join(root, 'dist', 'src', 'server.js')], { env: { ...process.env, PCB_USERDATA: ud, PCB_NO_UI: '1', PCB_FORCE_NEW: '1', PCB_PRINT: '1' }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    try {
      const { port, token } = await new Promise<any>((res, rej) => { let o = ''; p.stdout!.on('data', (d) => { o += d; try { res(JSON.parse(o.split('\n')[0])); } catch { /* partial */ } }); setTimeout(() => rej(new Error('service did not start')), 15000); });
      const base = 'http://127.0.0.1:' + port; const cookie = 'pcb=' + token;
      const api = async (ch: string, ...a: unknown[]) => (await fetch(base + '/api/' + ch, { method: 'POST', body: JSON.stringify(a), headers: { cookie } })).json();
      let first: any = null;   // first status event over SSE
      const ev = await fetch(base + '/events', { headers: { cookie } }); const rd = ev.body!.getReader(); let buf = '';
      const dl = Date.now() + 40000; while (Date.now() < dl && !first) { const { value } = await rd.read(); buf += Buffer.from(value!).toString(); const m = buf.match(/event: status\ndata: (.*)\n\n/); if (m) first = JSON.parse(m[1]); }
      await rd.cancel(); await check(api, port, cookie, first);
    } finally { p.kill(); }
  });
  await svc('service: API security (token, Host, Origin, blocked channels) and UI files', safeCfg, async (api, port, cookie) => {
    const base = 'http://127.0.0.1:' + port;
    eq((await fetch(base + '/api/config:get', { method: 'POST' })).status, 401, 'no token must be refused');
    eq((await fetch(base + '/', { headers: { cookie: 'pcb=wrong' } })).status, 401, 'wrong token');
    eq((await fetch(base + '/api/config:get', { method: 'POST', headers: { cookie, Origin: 'http://evil.example' } })).status, 403, 'foreign origin');
    const r = await new Promise<number>((res) => { const q = http.request({ host: '127.0.0.1', port, path: '/', headers: { Host: 'evil.example', cookie } }, (x) => res(x.statusCode!)); q.on('error', () => 0); q.end(); }); eq(r, 403, 'bad Host (DNS rebinding)');
    eq((await api('__proto__')).ok, false, 'prototype channel'); eq((await api('nope')).ok, false, 'unknown channel');
    for (const f of ['/', '/app.js', '/api.js', '/style.css']) eq((await fetch(base + f, { headers: { cookie } })).status, 200, f);
    eq((await fetch(base + '/..%2fpackage.json', { headers: { cookie } })).status, 404, 'path traversal');
    const cfg = await api('config:get'); ok(cfg.ok && cfg.data.config.projects.some((p: any) => p.container === 'searxng'), 'default searxng container project missing');
  });
  const graceDir = path.join(tmp, 'grace'); fs.mkdirSync(graceDir, { recursive: true });
  const graceCfg = { ...safeCfg, programs: [{ name: 'pcbtest-grace', dir: graceDir, cmd: 'node -e 0', port: 18899, mode: 'remote', remote: R.name }] };
  await svc('service: Quit keeps moved programs on the other PC for a grace period, opening it again cancels, Quit twice leaves', graceCfg, async (api, port, cookie) => {
    const alive = () => fetch('http://127.0.0.1:' + port + '/ping').then((r) => r.status === 200, () => false);
    await api('app:quit'); await sleep(1500); ok(await alive(), 'the service must keep running during the grace period');
    const rd = await fetch(`http://127.0.0.1:${port}/?t=${cookie.slice(4)}`, { redirect: 'manual' }); eq(rd.status, 302);   // what the launcher does when PC Bridge is opened again
    await sleep(500); const lg = await api('logs:all'); ok(lg.data.some((e: any) => /opened again/.test(e.msg)), 'reopening did not cancel the return');
    await api('app:quit'); await sleep(500); await api('app:quit').catch(() => 0);   // second Quit while waiting = now
    await until(async () => !(await alive()), 90000, 'second Quit must leave');
  });
  await svc('service: online dashboard data over SSE + RAM of the service itself', safeCfg, async (api, _p, _c, first) => {
    ok(first?.ssh?.ok === true && first.local && first.docker, 'first status: ' + JSON.stringify(first)?.slice(0, 200));
    await sleep(4000); const st = await api('app:stats'); ok(st.ok && st.data.rssMB < 120, 'service RSS ' + JSON.stringify(st)); return;
  });
  await svc('service: setup / test / ports / share API works end to end against the real remote', safeCfg, async (api, port) => {
    const d = await api('setup:discover'); ok(d.ok && d.data.some((p: any) => p.ip4 === R.host && p.sshOpen), JSON.stringify(d).slice(0, 200));
    const c = await api('setup:check', { host: R.host, user: R.user, keyPath: R.keyPath }); ok(c.ok && c.data.ready, JSON.stringify(c).slice(0, 300));
    const tc = await api('test:connection'); ok(tc.ok && tc.data.every((x: any) => x.ok || x.warn), JSON.stringify(tc.data?.filter((x: any) => !x.ok)));
    const pl = await api('ports:list'); ok(pl.ok && pl.data.local.some((p: any) => p.port === port && p.kind === 'bridge'), 'own port not recognised');
    for (const bad of [150, -5]) { const r = await api('proj:share', 'searxng', bad); eq(r.ok, false); ok(/0 to 100/.test(r.error), r.error); }
    eq((await api('proj:share', 'nosuch', 50)).ok, false, 'unknown project'); eq(JSON.stringify((await api('bal:stats')).data), '{}');
    const ap = await api('setup:apply', { name: 'lab', host: '100.9.9.9', user: 'bob' }, false); ok(ap.ok && ap.data.index === 1 && !ap.data.active, JSON.stringify(ap)); const cfg = await api('config:get'); eq(cfg.data.config.remotes.length, 2); eq(cfg.data.config.activeRemote, 0);
    eq((await api('remote:use', 9)).ok, false); const bad = await api('setup:apply', { host: '-oProxyCommand=x', user: 'bob' }, true); eq(bad.ok, false);
    const ta = await api('test:all'); ok(ta.ok && ta.data.length >= 9 && ta.data.every((x: any) => typeof x.name === 'string' && typeof x.ok === 'boolean'), JSON.stringify(ta).slice(0, 200));
    const tp = await api('test:project', 'searxng'); ok(tp.ok && tp.data.length >= 2, JSON.stringify(tp).slice(0, 200));
  });
  await svc('service: local API for other programs (toggle, token, read/control scope, usage stats, docs)', safeCfg, async (api, _port) => {
    const AP = 18787, base = `http://127.0.0.1:${AP}/api/v1`; const get = (p: string, h: Record<string, string> = {}) => fetch(base + p, { headers: h });
    const down = await get('/health').then(() => 'up', () => 'down'); eq(down, 'down', 'API must be OFF by default');
    const on = await api('api:set', { enabled: true, port: AP }); ok(on.ok && /^pcb_[0-9a-f]{48}$/.test(on.data.token), JSON.stringify(on).slice(0, 200)); const tok = on.data.token; const A = { Authorization: 'Bearer ' + tok, 'X-Client-Name': 'e2e-client' };
    eq((await get('/health')).status, 200, 'health is public'); eq((await get('/status')).status, 401, 'no token'); eq((await get('/status', { Authorization: 'Bearer pcb_nope' })).status, 401, 'wrong token');
    for (const p of ['/status', '/ports', '/projects', '/forwards', '/remotes', '/logs?n=5', '/usage', '/test/connection', '/test/port/' + AP]) { const r = await get(p, A); ok(r.status === 200, p + ' -> ' + r.status); await r.json(); }
    eq((await get('/test/project/nosuch', A)).status, 500); eq((await get('/test/port/abc', A)).status, 400, 'bad port number'); eq((await get('/nothing', A)).status, 404);
    const rb = await fetch(base + '/projects/searxng/share', { method: 'POST', headers: A, body: '{"share":50}' }); eq(rb.status, 403, 'control must be refused while off'); ok(/Allow control/.test((await rb.json()).error));
    const bh = await new Promise<number>((res) => { const q = http.request({ host: '127.0.0.1', port: AP, path: '/api/v1/status', headers: { Host: 'evil.example', Authorization: 'Bearer ' + tok } }, (x) => res(x.statusCode!)); q.on('error', () => res(0)); q.end(); }); eq(bh, 403, 'bad Host (DNS rebinding)');
    const pre = await fetch(base + '/status', { method: 'OPTIONS', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'GET' } }); ok(!pre.headers.get('access-control-allow-origin'), 'CORS must not be granted');
    const c1 = await api('api:set', { control: true }); ok(c1.ok && c1.data.control); const rc = await fetch(base + '/projects/nosuch/share', { method: 'POST', headers: A, body: '{"share":50}' }); ok(rc.status !== 403, 'control should be allowed now: ' + rc.status); ok(/Unknown project/.test((await rc.json()).error));
    eq((await fetch(base + '/projects/searxng/share', { method: 'POST', headers: A, body: '{bad json' })).status, 400, 'bad json');
    const us = await (await get('/usage', A)).json(); const st = us.endpoints.find((e: any) => e.path === '/api/v1/status'); ok(st.calls >= 1 && st.errors === 0, JSON.stringify(st)); ok(us.recent.some((c: any) => c.path === '/status' && c.status === 401), 'refused calls are listed in recent but not counted as errors'); ok(us.clients.some((c: any) => c.name === 'e2e-client' && c.calls > 5), JSON.stringify(us.clients)); ok(us.recent.length > 5, 'no recent calls');
    const oa = await (await get('/openapi.json')).json(); ok(Object.keys(oa.paths).length >= 15 && oa.paths['/api/v1/projects/{name}/share'].post, 'openapi incomplete'); const docs = await (await get('/docs')).text(); ok(docs.includes('/api/v1/ports') && docs.includes('Authorization'), 'docs incomplete');
    const inf = await (await get('/info')).json(); ok(inf.endpoints.length >= 40 && inf.auth && inf.workflows.length >= 5 && inf.endpoints.every((e: any) => e.summary), 'info incomplete'); const gd = await get('/guide'); ok(/text\/markdown/.test(gd.headers.get('content-type') || ''), 'guide type'); const gt = await gd.text(); ok(inf.endpoints.every((e: any) => gt.includes(e.path)), 'guide misses an endpoint'); ok(gt.includes('<TOKEN>') && !gt.includes(tok), 'guide must not leak the token');
    for (const p of ['/overview', '/pcs', '/app', '/programs']) { const r = await get(p, A); ok(r.status === 200, p + ' -> ' + r.status); const j = await r.json(); if (p === '/pcs') ok(Array.isArray(j) && j[0].name && 'reachable' in j[0] && Array.isArray(j[0].sites), JSON.stringify(j).slice(0, 200)); if (p === '/overview') ok(j.pcs && j.status && 'containers' in j && 'programs' in j, Object.keys(j).join()); }
    eq((await get('/overview')).status, 401, 'overview needs the token'); eq((await fetch(base + '/programs', { method: 'POST', headers: A, body: '{"name":"x"}' })).status, 400, 'register needs all fields'); eq((await fetch(base + '/remote/containers/a/explode', { method: 'POST', headers: A })).status, 400, 'bad container action'); eq((await fetch(base + '/remotes/active', { method: 'POST', headers: A, body: '{"name":"nosuch"}' })).status, 400, 'unknown PC');
    const pa = await fetch(base + '/programs', { method: 'POST', headers: A, body: JSON.stringify({ name: 'apitest', dir: os.tmpdir(), cmd: 'node x.js', port: 18799 }) }); eq(pa.status, 200, 'register program'); const pb = await fetch(base + '/programs', { method: 'POST', headers: A, body: JSON.stringify({ name: 'apitest', dir: os.tmpdir(), cmd: 'node y.js', port: 18799, runtime: 'node' }) }); eq(pb.status, 200, 'registering the same name again updates it'); ok((await (await get('/programs', A)).json()).filter((x: any) => x.name === 'apitest').length === 1, 'duplicate entry created'); const pc2 = await fetch(base + '/programs', { method: 'POST', headers: A, body: JSON.stringify({ name: 'apitest2', dir: os.tmpdir(), cmd: 'node z.js', port: 18799 }) }); eq(pc2.status, 400, 'same port as another program is a clear 400, not a 500'); ok((await (await get('/programs', A)).json()).some((x: any) => x.name === 'apitest'), 'registered program missing'); const ap = await fetch(base + '/apps', { method: 'POST', headers: A, body: JSON.stringify({ name: 'apitest-app', members: [{ kind: 'program', name: 'apitest' }] }) }); eq(ap.status, 200, 'create app: ' + JSON.stringify(await ap.clone().json())); const al = await (await get('/apps', A)).json(); ok(al.some((x: any) => x.name === 'apitest-app' && x.where === 'this PC' && x.members[0].pc === 'this PC'), JSON.stringify(al).slice(0, 200));
    eq((await fetch(base + '/programs/apitest/remove', { method: 'POST', headers: A })).status, 500, 'a program that is in an app cannot be removed'); const pln = await (await get('/apps/apitest-app/plan', A)).json(); ok(Array.isArray(pln) && pln[0].action, JSON.stringify(pln)); const exp = await (await get('/apps/apitest-app/export', A)).json(); eq(exp.pcbApp, 1); eq((await get('/apps/nosuch/plan', A)).status, 500);
    eq((await fetch(base + '/apps', { method: 'POST', headers: A, body: JSON.stringify({ name: 'bad name', members: [] }) })).status, 500, 'invalid app must be refused'); eq((await fetch(base + '/apps/apitest-app/remove', { method: 'POST', headers: A })).status, 200);
    eq((await fetch(base + '/programs/apitest/remove', { method: 'POST', headers: A })).status, 200, 'remove program');
    const self = await api('api:test'); ok(self.ok && self.data.every((x: any) => x.ok), JSON.stringify(self.data?.filter((x: any) => !x.ok)));
    const nt = await api('api:token'); ok(nt.ok && nt.data.token !== tok); eq((await get('/status', A)).status, 401, 'old token must stop working'); eq((await get('/status', { Authorization: 'Bearer ' + nt.data.token })).status, 200);
    const bp = await api('api:set', { port: 80 }); eq(bp.ok, false); ok(/1024/.test(bp.error), bp.error); eq((await get('/health')).status, 200, 'failed port change must leave the API running');
    const hog = net.createServer(); await new Promise<void>((r) => hog.listen(18788, '127.0.0.1', () => r())); const bu = await api('api:set', { port: 18788 }); hog.close(); eq(bu.ok, false); ok(/already used/.test(bu.error), bu.error); eq((await get('/health')).status, 200, 'busy port: previous port must keep working');
    await api('api:set', { enabled: false }); eq(await get('/health').then(() => 'up', () => 'down'), 'down', 'switching off must close the port');
  });

  // ---------- programs: plain Node / Python programs moved to the remote's E: drive ----------
  const killLocal = (port: number) => spawnSync('powershell', ['-NoProfile', '-Command', `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | % { Stop-Process -Id $_.OwningProcess -Force }`], { windowsHide: true });
  const pdeps = (fwd: core.Forwarder): prog.ProgramDeps => ({ fwd, save: () => {}, localPidOnPort: async () => null });
  const get = async (port: number, p = '/') => (await fetch(`http://127.0.0.1:${port}${p}`)).text();
  await t('programs: python version + requirements file + project --no-deps, bad pin names the package, pullExcludes keeps a folder out of the copy-back, requireFast refuses cleanly', async () => {
    const dir = path.join(tmp, 'pcbtest-pyopt'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'req.lock'), 'six==1.16.0\n'); fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "pcbpyopt"\nversion = "0.0.1"\n[tool.setuptools]\npy-modules = []\n[build-system]\nrequires = ["setuptools"]\nbuild-backend = "setuptools.build_meta"\n'); fs.writeFileSync(path.join(dir, 'hello.txt'), 'hi');
    killLocal(18783); const c = core.defaultConfig(); c.programs = [{ name: 'pcbtest-pyopt', dir, cmd: 'python -m http.server 18783 --bind 127.0.0.1', port: 18783, mode: 'local', python: '3.12', requirements: 'req.lock', pullExcludes: ['skipme'] }]; const fwd = new core.Forwarder(); const d = pdeps(fwd);
    ok(core.validateConfig({ ...c, programs: [{ ...c.programs[0], python: 'x' }] }).some((x) => /python must look like/.test(x)), 'bad python accepted');
    ok(core.validateConfig({ ...c, programs: [{ ...c.programs[0], pullExcludes: ['../x'] }] }).some((x) => /pullExcludes/.test(x)), 'bad pullExcludes accepted');
    ok(core.validateConfig({ ...c, programs: [{ ...c.programs[0], requirements: 'a\\b' }] }).some((x) => /requirements/.test(x)), 'bad requirements accepted');
    try {
      // requireFast on an address that can never be a home-network one: refused before anything is copied
      const slow = { ...R, fastCopy: false }; c.programs[0].requireFast = true;   // fast copy switched off = the same situation as being on another network
      const refused = await prog.moveProgram(c, slow, 'pcbtest-pyopt', d).then(() => 'moved', (e) => String(e.message)); ok(/must go over the home network.*Nothing was copied/.test(refused), refused);
      ok(/False/.test((await core.psRemote(R, String.raw`Test-Path E:\PCBridge\apps\pcbtest-pyopt\hello.txt`)).stdout), 'nothing may be copied when refused'); eq(c.programs[0].mode, 'local'); c.programs[0].requireFast = false;
      // a pin that does not exist: the error names the package
      fs.writeFileSync(path.join(dir, 'req.lock'), 'six==99.0.0\n');
      const bad = await prog.moveProgram(c, R, 'pcbtest-pyopt', d).then(() => 'moved', (e) => String(e.message)); ok(/six/.test(bad), 'error should name the package: ' + bad); eq(c.programs[0].mode, 'local');
      fs.writeFileSync(path.join(dir, 'req.lock'), 'six==1.16.0\n');
      const msg = await prog.moveProgram(c, R, 'pcbtest-pyopt', d); eq(c.programs[0].mode, 'remote'); ok(/copied over/.test(msg), msg);
      const v = await core.psRemote(R, String.raw`$p='E:\PCBridge\apps\pcbtest-pyopt\.venv'; (Get-Content "$p\pyvenv.cfg") -match '^version'; (& "$p\Scripts\python.exe" -c "import six;print('six-ok')"); (& "$p\Scripts\python.exe" -m pip --version 2>&1 | Out-Null); (Test-Path "$p\Lib\site-packages\pcbpyopt*")`); ok(/3\.12/.test(v.stdout) && /six-ok/.test(v.stdout), v.stdout);
      await core.psRemote(R, String.raw`New-Item -ItemType Directory -Force E:\PCBridge\apps\pcbtest-pyopt\skipme,E:\PCBridge\apps\pcbtest-pyopt\pullme | Out-Null; 'a' | Set-Content E:\PCBridge\apps\pcbtest-pyopt\skipme\a.txt; 'b' | Set-Content E:\PCBridge\apps\pcbtest-pyopt\pullme\b.txt; 'c' | Set-Content E:\PCBridge\apps\pcbtest-pyopt\skipme.txt`);
      await prog.bringProgramHome(c, R, 'pcbtest-pyopt', d); eq(c.programs[0].mode, 'local');
      ok(fs.existsSync(path.join(dir, 'pullme', 'b.txt')), 'a normal folder must come back'); ok(!fs.existsSync(path.join(dir, 'skipme', 'a.txt')), 'pullExcludes folder must NOT come back'); ok(fs.existsSync(path.join(dir, 'skipme.txt')), 'a file that only starts with the excluded name must still come back');
    } finally { fwd.stopAll(); killLocal(18783); await prog.remoteStop(c, R, c.programs[0]).catch(() => 0); await core.psRemote(R, String.raw`Remove-Item -Recurse -Force E:\PCBridge\apps\pcbtest-pyopt,E:\PCBridge\logs\pcbtest-pyopt.log -ErrorAction SilentlyContinue`).catch(() => 0); }
  });
  await t('fast copy: on by default (home-network address, verified by a real login), off with fastCopy:false, normal address when no LAN path', async () => {
    const last = (a: string[]) => a[a.length - 1];
    const off = await core.bulkSshArgs({ ...R, fastCopy: false }); eq(last(off), `${R.user}@${core.effectiveHost(R)}`);
    const on = await core.bulkSshArgs(R); const lan = last(on) !== last(off);
    if (lan) { ok(/@(192\.168|10\.|172\.)/.test(last(on)), last(on)); ok(on.includes(`HostKeyAlias=${R.host}`), 'must reuse the existing host-key entry'); const x = await core.run('ssh', [...on, 'echo hi'], { timeout: 20000 }); ok(x.stdout.includes('hi'), 'login on the LAN address'); }
    const far = { ...R, host: '203.0.113.9', routes: [] }; eq(last(await core.bulkSshArgs(far)), `${R.user}@203.0.113.9`);   // unreachable PC: no LAN path found, nothing breaks
    console.log(lan ? '   (home network in use: ' + last(on) + ')' : '   (no home-network path from here: normal address)');
  });
  await t('programs: config rejects C: root, bad names, multi-line commands, bad ports', async () => {
    const c = core.defaultConfig(); c.remoteRoot = 'C:\\PCBridge'; c.programs = [{ name: 'a b', dir: 'rel', cmd: 'x\ny', port: 0 }];
    const e = core.validateConfig(c).join('|'); ok(/may not be on C/.test(e) && /name may use/.test(e) && /full path/.test(e) && /line breaks/.test(e) && /port must/.test(e), e);
    const g = core.defaultConfig(); g.remoteRoot = 'E:\\PCBridge'; g.programs = [{ name: 'good', dir: tmp, cmd: 'node x.js', port: 8000 }]; eq(core.validateConfig(g).length, 0);
  });
  await t('programs: Node program moves to E:\PCBridge, survives a crash, failover works, files come back', async () => {
    const dir = path.join(tmp, 'pcbtest-node'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'server.js'), `const fs=require('fs');require('http').createServer((q,r)=>{if(q.url==='/w')fs.writeFileSync('made-on-remote.txt','hi');r.end(require('os').hostname()+' '+process.cwd())}).listen(18781,'127.0.0.1')`);
    fs.mkdirSync(path.join(dir, 'engdep'), { recursive: true }); fs.writeFileSync(path.join(dir, 'engdep', 'package.json'), '{"name":"engdep","version":"1.0.0","engines":{"node":">=99.0.0"}}');   // makes npm print an EBADENGINE warning on stderr: the install must still succeed
    fs.mkdirSync(path.join(dir, 'devbad'), { recursive: true }); fs.writeFileSync(path.join(dir, 'devbad', 'package.json'), '{"name":"devbad","version":"1.0.0","scripts":{"postinstall":"node -e \\"process.exit(1)\\""}}');   // a devDependency whose install script fails (like openclaw on Node 22): omitDev must skip it
    spawnSync('npm', ['pack', '--silent'], { cwd: path.join(dir, 'devbad'), shell: true, windowsHide: true }); fs.copyFileSync(path.join(dir, 'devbad', 'devbad-1.0.0.tgz'), path.join(dir, 'devbad-1.0.0.tgz')); fs.rmSync(path.join(dir, 'devbad'), { recursive: true });   // a tarball behaves like a registry package (a file: folder would be built even when dev-only)
    // a native package like better-sqlite3: has a binding.gyp and NO install script, so npm tries node-gyp (needs Visual Studio, absent on the remote); ignoreScripts must skip it
    fs.mkdirSync(path.join(dir, 'gypbad'), { recursive: true }); fs.writeFileSync(path.join(dir, 'gypbad', 'package.json'), '{"name":"gypbad","version":"1.0.0"}'); fs.writeFileSync(path.join(dir, 'gypbad', 'binding.gyp'), '{ "targets": [ { "target_name": "gypbad", "sources": [ "nonexistent.cc" ] } ] }');
    spawnSync('npm', ['pack', '--silent'], { cwd: path.join(dir, 'gypbad'), shell: true, windowsHide: true }); fs.copyFileSync(path.join(dir, 'gypbad', 'gypbad-1.0.0.tgz'), path.join(dir, 'gypbad-1.0.0.tgz')); fs.rmSync(path.join(dir, 'gypbad'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"pcbtest-node","version":"1.0.0","scripts":{"postinstall":"node -e \\"require(\'fs\').writeFileSync(\'postinstall-ran.txt\',\'ok\')\\""},"dependencies":{"engdep":"file:./engdep","gypbad":"file:./gypbad-1.0.0.tgz"},"devDependencies":{"devbad":"file:./devbad-1.0.0.tgz"}}');
    const c = core.defaultConfig(); c.programs = [{ name: 'pcbtest-node', dir, cmd: 'node server.js', port: 18781, mode: 'local', omitDev: true, ignoreScripts: true }]; const fwd = new core.Forwarder(); const d = pdeps(fwd);
    try {
      await prog.moveProgram(c, R, 'pcbtest-node', d); eq(c.programs[0].mode, 'remote');
      ok(/True/.test((await core.psRemote(R, String.raw`Test-Path E:\PCBridge\apps\pcbtest-node\postinstall-ran.txt`)).stdout), 'the program\'s own postinstall must still run with ignoreScripts');
      const a = await get(18781); ok(a.includes(R.name) && a.includes('E:\\PCBridge\\apps\\pcbtest-node'), a);
      await get(18781, '/w');
      await core.psRemote(R, `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -match 'server.js' -and $_.CommandLine -notmatch 'supervisor' } | % { Stop-Process -Id $_.ProcessId -Force }`);
      await until(async () => (await prog.remoteState(c, R, c.programs![0])).portUp, 40000, 'supervisor restarting the crashed program');
      const tr = await prog.testProgram(c, R, 'pcbtest-node'); ok(tr.every((x) => x.ok), JSON.stringify(tr.filter((x) => !x.ok)));
      // push: only the changed files go over, nothing restarts
      await sleep(1200); fs.mkdirSync(path.join(dir, 'docs'), { recursive: true }); fs.writeFileSync(path.join(dir, 'docs', 'pushed.txt'), 'pushed-ok'); fs.writeFileSync(path.join(dir, 'also.txt'), 'also-ok');
      const pm = await prog.pushFiles(c, R, 'pcbtest-node', d, ['docs/pushed.txt']); ok(/1 file/.test(pm) && /not restarted/.test(pm), pm);
      ok(/pushed-ok/.test((await core.psRemote(R, String.raw`Get-Content E:\PCBridge\apps\pcbtest-node\docs\pushed.txt`)).stdout), 'pushed file missing on the remote');
      ok(/False/.test((await core.psRemote(R, String.raw`Test-Path E:\PCBridge\apps\pcbtest-node\also.txt`)).stdout), 'a file that was not listed must not be pushed');
      const later = new Date(Date.now() + 5000); fs.utimesSync(path.join(dir, 'also.txt'), later, later);   // changed after the last push
      const pm2 = await prog.pushFiles(c, R, 'pcbtest-node', d); ok(/also\.txt/.test(pm2), pm2);   // no list: everything changed since the last copy/push
      const past = new Date(Date.now() - 60000); fs.utimesSync(path.join(dir, 'also.txt'), past, past);
      ok(/nothing changed/.test(await prog.pushFiles(c, R, 'pcbtest-node', d)), 'second push without changes must say so');
      for (const bad of ['../x.txt', 'node_modules/a.js', 'nope.txt']) ok(await prog.pushFiles(c, R, 'pcbtest-node', d, [bad]).then(() => false, () => true), 'must refuse ' + bad);
      await get(18781);   // still answering: no restart
      // remote dies for 3 polls -> runs on this PC again; the file it wrote on the remote is copied back first only when the remote is reachable, so here we use the manual path
      await prog.bringProgramHome(c, R, 'pcbtest-node', d); eq(c.programs[0].mode, 'local');
      ok(fs.existsSync(path.join(dir, 'made-on-remote.txt')), 'file written on the remote was not copied back');
      await until(async () => /\w/.test(await get(18781).catch(() => '')) && !(await get(18781)).includes(R.name), 15000, 'program running on this PC');
      const st = await core.psRemote(R, String.raw`Test-Path E:\PCBridge\run\pcbtest-node.pid`); ok(/False/.test(st.stdout), 'remote supervisor must be stopped');
      c.programs[0].mode = 'remote'; fwd.stopAll(); killLocal(18781); await sleep(1000);
      // failover: remote "unreachable" for 3 polls
      c.programs[0].mode = 'remote'; const down = () => false; await prog.watchPrograms(c, down, d); await prog.watchPrograms(c, down, d); await prog.watchPrograms(c, down, d);
      eq(c.programs[0].mode, 'local', 'failover did not bring it home'); await until(async () => ((await core.tcpProbe('127.0.0.1', 18781, 800)).ok), 40000, 'failover started it here');
    } finally { fwd.stopAll(); killLocal(18781); await prog.remoteStop(c, R, c.programs[0]).catch(() => 0); await core.psRemote(R, String.raw`Remove-Item -Recurse -Force E:\PCBridge\apps\pcbtest-node,E:\PCBridge\logs\pcbtest-node.log -ErrorAction SilentlyContinue`).catch(() => 0); }
  });
  await t('programs: update check + update everything on the remote (Node, libraries, restart)', async () => {
    const dir = path.join(tmp, 'pcbtest-upd'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'server.js'), `require('http').createServer((q,r)=>r.end('upd-ok')).listen(18783,'127.0.0.1')`); fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"pcbtest-upd","version":"1.0.0"}');
    const c = core.defaultConfig(); c.programs = [{ name: 'pcbtest-upd', dir, cmd: 'node server.js', port: 18783, mode: 'local' }]; const fwd = new core.Forwarder(); const d = pdeps(fwd);
    try {
      await prog.moveProgram(c, R, 'pcbtest-upd', d);
      const chk = await prog.updateRemote(c, R, d, false); ok(chk.some((x) => /^Node/.test(x.name) && x.state !== 'failed'), JSON.stringify(chk)); ok(chk.some((x) => x.name === 'pcbtest-upd libraries' && x.state !== 'failed'), JSON.stringify(chk)); eq(await get(18783), 'upd-ok', 'check must not disturb the program');
      const app = await prog.updateRemote(c, R, d, true); ok(app.every((x) => x.state !== 'failed'), JSON.stringify(app.filter((x) => x.state === 'failed'))); ok(app.some((x) => x.name === 'pcbtest-upd restarted' && x.state === 'info'), JSON.stringify(app));
      eq(await get(18783), 'upd-ok', 'program must answer again after the update'); ok((c.programsUpdatedAt || 0) > 0, 'update time not recorded');
    } finally { fwd.stopAll(); killLocal(18783); await prog.remoteStop(c, R, c.programs[0]).catch(() => 0); await core.psRemote(R, String.raw`Remove-Item -Recurse -Force E:\PCBridge\apps\pcbtest-upd,E:\PCBridge\logs\pcbtest-upd.log -ErrorAction SilentlyContinue`).catch(() => 0); }
  });
  await t('multi-PC: config rejects an unknown PC name; each program is judged by ITS OWN PC (one fails over, the other stays)', async () => {
    const mk = (n: string, port: number) => { const dir = path.join(tmp, n); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'server.js'), `require('http').createServer((q,r)=>r.end('${n}')).listen(${port},'127.0.0.1')`); return dir; };
    const c = core.defaultConfig(); c.remotes.push({ ...c.remotes[0], name: 'second-pc' });
    c.programs = [{ name: 'pcbtest-m1', dir: mk('pcbtest-m1', 18791), cmd: 'node server.js', port: 18791, mode: 'local' }, { name: 'pcbtest-m2', dir: mk('pcbtest-m2', 18792), cmd: 'node server.js', port: 18792, mode: 'local', remote: 'second-pc' }];
    eq(core.validateConfig(c).length, 0); const bad = core.defaultConfig(); bad.programs = [{ name: 'x', dir: tmp, cmd: 'node a.js', port: 8000, remote: 'ghost' }]; ok(/no PC with that name/.test(core.validateConfig(bad).join('|')), 'unknown PC name accepted');
    eq(core.remoteFor(c, 'second-pc').name, 'second-pc'); eq(core.remoteFor(c, undefined).name, c.remotes[0].name); eq(core.remoteFor(c, 'ghost').name, c.remotes[0].name, 'unknown name must fall back to the active PC');
    const fwd = new core.Forwarder(); const d = pdeps(fwd);
    try {
      await prog.moveProgram(c, core.remoteFor(c, c.programs[0].remote), 'pcbtest-m1', d); await prog.moveProgram(c, core.remoteFor(c, c.programs[1].remote), 'pcbtest-m2', d);
      eq(await get(18791), 'pcbtest-m1'); eq(await get(18792), 'pcbtest-m2');
      const reach = (r: core.Remote) => r.name !== 'second-pc';   // only second-pc is "down"
      for (let i = 0; i < 3; i++) await prog.watchPrograms(c, reach, d);
      eq(c.programs[1].mode, 'local', 'program on the unreachable PC did not fail over'); eq(c.programs[0].mode, 'remote', 'program on the healthy PC must stay');
      eq(await get(18791), 'pcbtest-m1', 'healthy PC program must keep answering');
    } finally { fwd.stopAll(); killLocal(18791); killLocal(18792); for (const p of c.programs!) await prog.remoteStop(c, R, p).catch(() => 0); await core.psRemote(R, String.raw`Remove-Item -Recurse -Force E:\PCBridge\apps\pcbtest-m1,E:\PCBridge\apps\pcbtest-m2,E:\PCBridge\logs\pcbtest-m1.log,E:\PCBridge\logs\pcbtest-m2.log -ErrorAction SilentlyContinue`).catch(() => 0); }
  });
  // weekly auto-update: a real service must update by itself when the switch is on and the last run is older than a week, and must NOT when it is off
  const wcfg = (on: boolean, port: number, dir: string) => ({ ...core.defaultConfig(), projects: [], keepAwake: false, autoUpdate: on, programsUpdatedAt: 0, programs: [{ name: 'pcbtest-wk', dir, cmd: 'node server.js', port, mode: 'remote' }] });
  const wkProg = async (port: number) => {
    const dir = path.join(tmp, 'pcbtest-wk' + port); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'server.js'), `require('http').createServer((q,r)=>r.end('wk-ok')).listen(${port},'127.0.0.1')`); fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"pcbtest-wk","version":"1.0.0"}');
    const c = core.defaultConfig(); c.programs = [{ name: 'pcbtest-wk', dir, cmd: 'node server.js', port, mode: 'local' }]; const fwd = new core.Forwarder();
    await prog.moveProgram(c, R, 'pcbtest-wk', pdeps(fwd)); fwd.stopAll(); return { dir, c };
  };
  const wkClean = async (port: number, c: core.Config) => { killLocal(port); await prog.remoteStop(c, R, c.programs![0]).catch(() => 0); await core.psRemote(R, String.raw`Remove-Item -Recurse -Force E:\PCBridge\apps\pcbtest-wk,E:\PCBridge\logs\pcbtest-wk.log -ErrorAction SilentlyContinue`).catch(() => 0); };
  await t('programs: weekly auto-update OFF -> the service does not update by itself', async () => {
    const { dir, c } = await wkProg(18785);
    try { await svc('weekly-off', wcfg(false, 18785, dir), async (api) => { await sleep(14000); const lg = await api('logs:all'); ok(!lg.data.some((l: any) => /Weekly update/.test(l.msg)), 'updated although the switch is off'); const cf = await api('config:get'); eq(cf.data.config.programsUpdatedAt, 0); }); }
    finally { await wkClean(18785, c); }
  });
  await t('programs: weekly auto-update ON -> the service updates the remote by itself and records the time', async () => {
    const { dir, c } = await wkProg(18786);
    try { await svc('weekly-on!', wcfg(true, 18786, dir), async (api, port) => {
      let lg: any[] = []; await until(async () => { lg = (await api('logs:all')).data; return lg.some((l: any) => /Weekly update/.test(l.msg)); }, 60000, 'the weekly update to start');
      await until(async () => ((await api('config:get')).data.config.programsUpdatedAt || 0) > 0, 240000, 'the weekly update to finish and record its time');
      await until(async () => (await get(18786).catch(() => '')) === 'wk-ok', 60000, 'program answering through the service forward after the update');
      const cf = await api('config:get'); ok(Date.now() - cf.data.config.programsUpdatedAt < 300000, 'update time is wrong'); void port;
    }); } finally { await wkClean(18786, c); }
  });
  await t('multi-PC: changing the active PC leaves a moved program alone (pinned to its own PC, forward stays up)', async () => {
    const { dir, c } = await wkProg(18787);
    try { await svc('active-switch', { ...wcfg(false, 18787, dir), remotes: [{ ...core.defaultConfig().remotes[0] }, { ...core.defaultConfig().remotes[0], name: 'second-pc' }], programs: [{ name: 'pcbtest-wk', dir, cmd: 'node server.js', port: 18787, mode: 'remote', remote: R.name }] }, async (api) => {
      await until(async () => (await get(18787).catch(() => '')) === 'wk-ok', 60000, 'program answering through the service forward');
      const sw = await api('remote:use', 1); ok(sw.ok, 'switching the active PC was refused: ' + sw.error);
      const cf = await api('config:get'); eq(cf.data.config.activeRemote, 1); eq(cf.data.config.programs[0].remote, R.name, 'program lost its PC');
      await sleep(4000); eq(await get(18787).catch(() => 'DEAD'), 'wk-ok', 'the program forward was stopped by the switch');
    }); } finally { await wkClean(18787, c); }
  });
  await t('programs: Quit keeps a moved program on the other PC for the grace period, a second Quit brings it back to this PC (localhost never left dead)', async () => {
    const { dir, c } = await wkProg(18788);
    try { await svc('quit-prog', wcfg(false, 18788, dir), async (api) => {
      await until(async () => (await get(18788).catch(() => '')) === 'wk-ok', 60000, 'program answering through the service forward');
      await api('app:quit').catch(() => 0); await sleep(3000);
      eq(await get(18788).catch(() => ''), 'wk-ok', 'first Quit must leave the program on the other PC (grace period)'); ok((await prog.remoteState(c, R, { ...c.programs![0], mode: 'remote' })).supervisor, 'the remote copy must still run during the grace period');
      await api('app:quit').catch(() => 0);   // second Quit = now
      await until(async () => { const own = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort 18788 -State Listen -ErrorAction SilentlyContinue | % { (Get-Process -Id $_.OwningProcess).ProcessName }) -join ','`], { windowsHide: true }).stdout.toString().trim(); return /node/i.test(own) && !/ssh/i.test(own); }, 90000, 'the program running on THIS PC after quit');
      const st = await prog.remoteState(c, R, { ...c.programs![0], mode: 'remote' }); ok(!st.supervisor, 'the remote copy must be stopped');
    }); } finally { await wkClean(18788, c); }
  });
  // ---------- apps: a group of programs moved as one ----------
  await t('apps: a part shared by two apps runs in ONE place; bring-back keeps it while the other app still needs it; no parallel moves', async () => {
    const c = core.defaultConfig(); c.programs = [{ name: 'sx', dir: tmp, cmd: 'x', port: 18840 }, { name: 'w1', dir: tmp, cmd: 'x', port: 18841 }, { name: 'w2', dir: tmp, cmd: 'x', port: 18842 }];
    c.apps = [{ name: 'A', members: [{ kind: 'program', name: 'sx' }, { kind: 'program', name: 'w1' }] }, { name: 'B', members: [{ kind: 'program', name: 'sx' }, { kind: 'program', name: 'w2' }] }];
    eq(core.validateConfig(c).length, 0, core.validateConfig(c).join('|')); c.apps.push({ name: 'D', members: [{ kind: 'program', name: 'w1' }, { kind: 'program', name: 'w1' }] }); ok(/listed twice/.test(core.validateConfig(c).join('|'))); c.apps.pop();
    const at: Record<string, string> = { sx: apps.HERE, w1: apps.HERE, w2: apps.HERE }; let slow = 0;
    const d: apps.AppDeps = { where: (m) => at[m.name], ports: (m) => [1], holder: async () => null, moveProgram: async (n, _p, to) => { slow++; await sleep(150); at[n] = to; return ''; }, homeProgram: async (n) => { at[n] = apps.HERE; return ''; }, offloadContainer: async () => '', homeContainer: async () => {}, testPort: async () => ({ ok: true, detail: '', ms: 0 }), save: () => {} };
    const R1 = c.remotes[0].name; const pl = await apps.planApp(c, d, 'A', R1); eq(pl.find((r) => r.name === 'sx')!.shared!.join(), 'B'); eq(apps.statusApp(c, d, c.apps![0]).members[0].sharedWith.join(), 'B');
    await apps.sendApp(c, d, 'A', { target: R1 }); eq(at.sx, R1); eq(apps.statusApp(c, d, c.apps![1]).where.startsWith('split'), true, 'B now sees the shared part elsewhere (split)'); eq(apps.wantedLinks(c, d).length >= 1, true, 'B keeps reaching it through a link');
    const out = await apps.homeApp(c, d, 'A'); ok(out.some((l) => /sx: back on this PC/.test(l)), out.join('|'));   // B has nothing away, so nothing needs sx there
    await apps.sendApp(c, d, 'A', { target: R1 }); at.w2 = R1; const out2 = await apps.homeApp(c, d, 'A'); ok(out2.some((l) => /sx: left on .* B still uses it/.test(l)) && at.sx === R1 && at.w1 === apps.HERE, out2.join('|'));
    const p1 = apps.sendApp(c, d, 'A', { target: R1 }); let err = ''; try { await apps.sendApp(c, d, 'B', { target: R1 }); } catch (x: any) { err = x.message; } await p1; ok(/shares a part/.test(err), err);
  });
  await t('programs: "needs" (a service that stays on this PC, e.g. LM Studio) is validated, exported/imported, and becomes a link only while the program runs elsewhere', async () => {
    const c = core.defaultConfig(); c.programs = [{ name: 'nd', dir: tmp, cmd: 'x', port: 18850, needs: [1234] }]; eq(core.validateConfig(c).length, 0, core.validateConfig(c).join('|'));
    c.programs[0].needs = [18850, 0, 1.5] as number[]; ok(/needs/.test(core.validateConfig(c).join('|'))); c.programs[0].needs = [1234];
    let at = apps.HERE; const d = { where: () => at, ports: () => [18850] }; eq(apps.wantedLinks(c, d).length, 0, 'no link while it runs here'); at = c.remotes[0].name; const w = apps.wantedLinks(c, d); eq(JSON.stringify(w), JSON.stringify([{ pc: at, port: 1234 }]));
    c.apps = [{ name: 'nda', members: [{ kind: 'program', name: 'nd' }] }]; const ex = apps.exportApp(c, 'nda'); eq((ex.members[0] as any).needs[0], 1234); const c2 = core.defaultConfig(); apps.importApp(c2, JSON.parse(JSON.stringify(ex)), tmp); eq(c2.programs![0].needs![0], 1234);
  });
  await t('apps: validation (unknown program, member in two apps, bad target) + export/import round trip', async () => {
    const c = core.defaultConfig(); c.programs = [{ name: 'p1', dir: tmp, cmd: 'node a.js', port: 18830, env: { SECRET: 'x' } }, { name: 'p2', dir: tmp, cmd: 'node b.js', port: 18831 }];
    c.apps = [{ name: 'a1', members: [{ kind: 'program', name: 'p1' }, { kind: 'container', name: 'db' }], target: c.remotes[0].name }]; eq(core.validateConfig(c).length, 0, core.validateConfig(c).join('|'));
    c.apps.push({ name: 'a2', members: [{ kind: 'program', name: 'p1' }, { kind: 'program', name: 'nosuch' }], target: 'ghost' });
    const e = core.validateConfig(c).join('|'); ok(!/two apps/.test(e) && /no program "nosuch"/.test(e) && /unknown PC "ghost"/.test(e), e); c.apps.pop();
    const ex = apps.exportApp(c, 'a1'); eq(ex.pcbApp, 1); eq((ex.members[0] as any).env.SECRET, '', 'secrets must not be exported'); ok(!JSON.stringify(ex).includes(tmp), 'full path leaked into the export'); eq((apps.exportApp(c, 'a1', true).members[0] as any).env.SECRET, 'x');
    const c2 = core.defaultConfig(); const im = apps.importApp(c2, JSON.parse(JSON.stringify(ex)), tmp); eq(im.name, 'a1'); eq(c2.programs![0].dir, path.join(tmp, path.basename(tmp))); ok(im.warnings.some((w) => /SECRET/.test(w)) && im.warnings.some((w) => /container/.test(w)), im.warnings.join('|'));
    let m = ''; try { apps.importApp(c2, ex, tmp); } catch (x: any) { m = x.message; } ok(/already exists/.test(m), m); try { apps.importApp(c2, { nope: 1 }, tmp, 'z'); } catch (x: any) { m = x.message; } ok(/not a PC Bridge app/.test(m), m); try { apps.importApp(c2, ex, 'rel', 'z'); } catch (x: any) { m = x.message; } ok(/full path/.test(m), m);
    const before = JSON.stringify(c2); try { apps.importApp(c2, { ...ex, members: [{ kind: 'program', name: 'bad name', folder: 'f', cmd: 'x', port: 0 }] }, tmp, 'z2'); } catch { /* validation */ } eq(JSON.stringify(c2), before, 'a rejected import must leave the config untouched');
  });
  await t('apps: frontend + backend sent together, a split app (backend stays here) still talks on localhost, rollback, blockers, bring back', async () => {
    const BE = 18821, FE = 18822; const dBE = path.join(tmp, 'pcbtest-be'), dFE = path.join(tmp, 'pcbtest-fe'), dBad = path.join(tmp, 'pcbtest-nodir'); fs.mkdirSync(dBE); fs.mkdirSync(dFE);
    const beSrc = `require('http').createServer((q,r)=>r.end('backend-ok@'+require('os').hostname())).listen(${BE},'127.0.0.1')`; fs.writeFileSync(path.join(dBE, 'server.js'), beSrc);
    fs.writeFileSync(path.join(dFE, 'server.js'), `require('http').createServer(async(q,r)=>{try{r.end('fe:'+await (await fetch('http://127.0.0.1:${BE}/')).text())}catch(e){r.statusCode=502;r.end('fe-cannot-reach-backend')}}).listen(${FE},'127.0.0.1')`);
    const c = core.defaultConfig(); c.projects = []; c.programs = [{ name: 'pcbtest-be', dir: dBE, cmd: 'node server.js', port: BE, mode: 'local' }, { name: 'pcbtest-fe', dir: dFE, cmd: 'node server.js', port: FE, mode: 'local' }, { name: 'pcbtest-bad', dir: dBad, cmd: 'node server.js', port: 18823, mode: 'local' }];
    const MBE: apps.AppMember = { kind: 'program', name: 'pcbtest-be' }, MFE: apps.AppMember = { kind: 'program', name: 'pcbtest-fe' }, MBAD: apps.AppMember = { kind: 'program', name: 'pcbtest-bad' };
    c.apps = [{ name: 'pcbtest-app', members: [MBE, MFE] }];
    const fwd = new core.Forwarder(); const d = pdeps(fwd); const P = (n: string) => c.programs!.find((x) => x.name === n)!;
    const ad: apps.AppDeps = { where: (m) => (P(m.name).mode === 'remote' ? R.name : apps.HERE), ports: (m) => [P(m.name).port], holder: async (m) => { const out = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${P(m.name).port} -State Listen -ErrorAction SilentlyContinue | select -First 1).OwningProcess`], { windowsHide: true }).stdout.toString().trim(); return out ? Number(out) : null; },
      moveProgram: (n, pid, to) => { if (pid) killLocal(P(n).port); return prog.moveProgram(c, core.remoteFor(c, to), n, d); }, homeProgram: async (n) => { await prog.bringProgramHome(c, R, n, d); return 'home'; },
      offloadContainer: async () => 'n/a', homeContainer: async () => {}, testPort: async (port) => { const r = await setup.testPort(port); return { ok: r.ok, detail: r.detail, ms: r.ms }; }, save: () => {} };
    const cleanup = async () => { fwd.stopAll(); apps.stopAllLinks(fwd); for (const p of [BE, FE, 18823]) killLocal(p); for (const n of ['pcbtest-be', 'pcbtest-fe']) await prog.remoteStop(c, R, P(n)).catch(() => 0); await core.psRemote(R, String.raw`Remove-Item -Recurse -Force E:\PCBridge\apps\pcbtest-be,E:\PCBridge\apps\pcbtest-fe,E:\PCBridge\logs\pcbtest-be.log,E:\PCBridge\logs\pcbtest-fe.log -ErrorAction SilentlyContinue`).catch(() => 0); };
    try {
      // 1) plan, then send both together: they live side by side on the remote, so localhost works there
      const pl = await apps.planApp(c, ad, 'pcbtest-app', R.name); eq(pl.map((r) => r.action).join(), 'move,move'); ok(pl.every((r) => !r.blocker));
      const out = await apps.sendApp(c, ad, 'pcbtest-app', { target: R.name }); ok(out.length === 2 && out.every((l) => /now on/.test(l)), out.join('|'));
      eq(apps.statusApp(c, ad, c.apps![0]).where, R.name);
      await until(async () => (await get(FE).catch(() => '')).startsWith('fe:backend-ok@' + R.name), 40000, 'frontend (on the remote) reaching the backend (on the remote)');
      eq(apps.statusApp(c, ad, c.apps![0]).links, 0, 'no links are needed when everything is on one PC'); ok((await apps.testApp(c, ad, 'pcbtest-app')).every((x) => x.ok), 'app test');
      eq((await apps.sendApp(c, ad, 'pcbtest-app', { target: R.name })).join('|').match(/already/g)?.length, 2, 'sending again must be a no-op');
      // 2) split: bring all back, keep the backend HERE, send the frontend to the remote. The frontend must still reach the backend on localhost (reverse link)
      await apps.homeApp(c, ad, 'pcbtest-app'); eq(apps.statusApp(c, ad, c.apps![0]).where, 'this PC'); apps.syncLinks(c, ad, fwd); eq(fwd.list().filter((x) => x.label).length, 0, 'links must stop when everything is home');
      fwd.stopAll(); killLocal(FE); killLocal(BE); await sleep(800);
      const be = spawn(process.execPath, ['-e', beSrc], { windowsHide: true, stdio: 'ignore' }); try {
        await until(async () => (await core.tcpProbe('127.0.0.1', BE, 500)).ok, 10000, 'local backend');
        MBE.target = apps.HERE; const pl2 = await apps.planApp(c, ad, 'pcbtest-app', R.name); eq(pl2.map((r) => r.action).join(), 'already,move');
        await apps.sendApp(c, ad, 'pcbtest-app', { target: R.name }); const s2 = apps.statusApp(c, ad, c.apps![0]); ok(/^split across/.test(s2.where), s2.where); ok(s2.links >= 1, 'a link is needed');
        apps.syncLinks(c, ad, fwd); await until(async () => { const x = await get(FE).catch(() => ''); return /^fe:backend-ok@/.test(x) && !x.includes(R.name); }, 40000, 'frontend on the remote reaching the backend that stays on this PC through the link');
        await until(async () => fwd.list().some((x) => x.label && x.state === 'active'), 10000, 'the link reporting active: ' + JSON.stringify(fwd.list()));
      } finally { be.kill(); killLocal(BE); }
      // 3) all-or-nothing: the second member cannot move -> the first goes back, nothing is left half moved
      await apps.homeApp(c, ad, 'pcbtest-app'); apps.syncLinks(c, ad, fwd); fwd.stopAll(); killLocal(FE); await sleep(1500); killLocal(FE); await sleep(500);   // the program started by "bring back" can come up late on a busy PC
      c.apps = [{ name: 'pcbtest-rb', members: [MFE, MBAD] }]; let err = ''; try { await apps.sendApp(c, ad, 'pcbtest-rb', { target: R.name }); } catch (x: any) { err = x.message; }
      ok(/pcbtest-bad failed/.test(err) && /Put back/.test(err), err); eq(P('pcbtest-fe').mode, 'local', 'the first member must be put back'); eq(P('pcbtest-bad').mode, 'local');
      // 4) a process on this PC holds a member's port: nothing is moved unless the user allows stopping it
      killLocal(FE); await sleep(500); const hog = net.createServer(); await new Promise<void>((r) => hog.listen(FE, '127.0.0.1', () => r())); c.apps = [{ name: 'pcbtest-hog', members: [MFE] }];
      const pl3 = await apps.planApp(c, ad, 'pcbtest-hog', R.name); ok(!!pl3[0].blocker, JSON.stringify(pl3)); let e3 = ''; try { await apps.sendApp(c, ad, 'pcbtest-hog', { target: R.name }); } catch (x: any) { e3 = x.message; } hog.close(); ok(/Nothing was moved/.test(e3), e3); eq(P('pcbtest-fe').mode, 'local');
    } finally { await cleanup(); }
  });
  await t('programs: Python packages with native code (numpy, requests) install under E: and run; update keeps them working', async () => {
    const dir = path.join(tmp, 'pcbtest-np'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'requirements.txt'), 'numpy>=2,<3\nrequests\n');
    fs.writeFileSync(path.join(dir, 'server.py'), `import http.server, numpy as np, requests\nclass H(http.server.BaseHTTPRequestHandler):\n    def do_GET(s):\n        s.send_response(200); s.end_headers(); s.wfile.write(('numpy %s sum=%d requests %s' % (np.__version__, int(np.arange(10).sum()), requests.__version__)).encode())\nhttp.server.HTTPServer(('127.0.0.1', 18784), H).serve_forever()\n`);
    const c = core.defaultConfig(); c.programs = [{ name: 'pcbtest-np', dir, cmd: 'python server.py', port: 18784, mode: 'local' }]; const fwd = new core.Forwarder(); const d = pdeps(fwd);
    try {
      await prog.moveProgram(c, R, 'pcbtest-np', d);
      const a = await get(18784); ok(/numpy 2\.\S+ sum=45 requests \d/.test(a), a);
      const sp = await core.psRemote(R, String.raw`(Get-ChildItem E:\PCBridge\apps\pcbtest-np\.venv\Lib\site-packages -Directory -Filter numpy* | measure).Count`); ok(!/^0/.test(sp.stdout.trim()), 'numpy is not inside the venv on E: ' + sp.stdout);
      const up = await prog.updateRemote(c, R, d, true); ok(up.every((x) => x.state !== 'failed'), JSON.stringify(up.filter((x) => x.state === 'failed')));
      await until(async () => /sum=45/.test(await get(18784).catch(() => '')), 60000, 'numpy program answering after the update');
    } finally { fwd.stopAll(); killLocal(18784); await prog.remoteStop(c, R, c.programs[0]).catch(() => 0); await core.psRemote(R, String.raw`Remove-Item -Recurse -Force E:\PCBridge\apps\pcbtest-np,E:\PCBridge\logs\pcbtest-np.log -ErrorAction SilentlyContinue`).catch(() => 0); }
  });
  await t('programs: Python program (uv + venv, all under E:\PCBridge) moves and answers', async () => {
    const dir = path.join(tmp, 'pcbtest-py'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'requirements.txt'), '# no packages\n'); fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello from python test');
    killLocal(18782); await sleep(800);   // a leftover from the previous test must not hold the port
    const c = core.defaultConfig(); c.programs = [{ name: 'pcbtest-py', dir, cmd: 'python -m http.server 18782 --bind 127.0.0.1', port: 18782, mode: 'local' }]; const fwd = new core.Forwarder(); const d = pdeps(fwd);
    try {
      eq(prog.runtimeOf(c.programs[0]), 'python');
      await prog.moveProgram(c, R, 'pcbtest-py', d);
      ok((await get(18782, '/hello.txt')).includes('hello from python test'), 'file not served by the remote python');
      const v = await core.psRemote(R, String.raw`(Test-Path E:\PCBridge\apps\pcbtest-py\.venv\Scripts\python.exe), (Test-Path E:\PCBridge\tools\uv\uv.exe), ((Get-ChildItem E:\PCBridge\python -ErrorAction SilentlyContinue | measure).Count -gt 0)`); ok(!/False/.test(v.stdout), 'python/uv/venv not under E:\\PCBridge: ' + v.stdout);
      await prog.bringProgramHome(c, R, 'pcbtest-py', d);
    } finally { fwd.stopAll(); killLocal(18782); await prog.remoteStop(c, R, c.programs[0]).catch(() => 0); await core.psRemote(R, String.raw`Remove-Item -Recurse -Force E:\PCBridge\apps\pcbtest-py,E:\PCBridge\logs\pcbtest-py.log -ErrorAction SilentlyContinue`).catch(() => 0); }
  });
  const off = core.defaultConfig(); off.remotes[0].host = '100.64.255.254';
  await svc('service: OFFLINE remote -> red status with troubleshooting checklist, API still works', off, async (api, _p, _c, first) => {
    ok(first && first.ssh.ok === false && first.ssh.checklist.length > 0 && /sshd/.test(first.ssh.checklist.join(' ')), JSON.stringify(first?.ssh)?.slice(0, 200)); ok((await api('logs:all')).ok, 'api dead while offline');
  });
}

main().catch((e) => { console.log('HARNESS ERROR', e); results.push({ name: 'harness', ok: false, note: String(e) }); }).finally(() => {
  const bad = results.filter((r) => !r.ok); console.log(`\n${results.length - bad.length}/${results.length} passed`); bad.forEach((b) => console.log(' FAILED:', b.name, '-', b.note));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(bad.length ? 1 : 0);
});
