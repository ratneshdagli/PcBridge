// Scripted stand-in for the LOCAL docker CLI + engine, used by test/e2e.ts via PCB_FAKE_DOCKER. Tests only.
// State lives in a JSON file (PCB_FAKE_STATE). A "container" is a tiny detached node HTTP server, so start/stop/failover are real processes.
import * as fs from 'fs';
import * as http from 'http';
import { spawn, spawnSync } from 'child_process';

if (process.argv[2] === '--serve') {            // the fake container: answers every request with its name
  const [port, name] = [Number(process.argv[3]), process.argv[4]];
  http.createServer((_q, res) => res.end(`FAKE-LOCAL-SERVED:${name}\n`)).listen(port, '0.0.0.0');
} else {
  const FILE = process.env.PCB_FAKE_STATE!;
  const load = () => JSON.parse(fs.readFileSync(FILE, 'utf8')); const save = (s: any) => fs.writeFileSync(FILE, JSON.stringify(s));
  let a = process.argv.slice(2); if (a[0] === '--context') a = a.slice(2);
  const s = load(); const out = (t: string) => process.stdout.write(t + '\n');
  const fail = (m: string): never => { process.stderr.write(m + '\n'); process.exit(1); };
  const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
  const inspectOf = (n: string) => ({ ...s.containers[n].inspect, State: { Status: alive(s.containers[n].pid) ? 'running' : 'exited' } });
  const needEngine = () => {
    if (s.down) { if (s.upAt && Date.now() >= s.upAt) { s.down = false; save(s); } else fail('failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; the daemon is not running'); }
  };

  switch (a[0]) {
    case 'context': out('fake'); break;
    case 'info': needEngine(); out('99.0.0'); break;
    case '__start_desktop': s.upAt = Date.now() + 4000; save(s); out('starting'); break;
    case 'ps': needEngine(); Object.keys(s.containers).forEach(out); break;
    case 'inspect': {
      needEngine(); const names = a.slice(1);
      for (const n of names) if (!s.containers[n]) fail(`Error: No such object: ${n}`);
      out(JSON.stringify(names.map(inspectOf))); break;
    }
    case 'start': {
      needEngine(); const n = a[1]; const c = s.containers[n]; if (!c) fail(`Error response from daemon: No such container: ${n}`);
      if (!alive(c.pid)) { const p = spawn(process.execPath, [process.argv[1], '--serve', String(c.port), n], { detached: true, stdio: 'ignore', windowsHide: true }); p.unref(); c.pid = p.pid; save(s); }
      out(n); break;
    }
    case 'stop': {
      needEngine(); const n = a[1]; const c = s.containers[n]; if (!c) fail(`Error response from daemon: No such container: ${n}`);
      if (alive(c.pid)) { try { process.kill(c.pid); } catch { /* already gone */ } } c.pid = 0; save(s); out(n); break;
    }
    case 'cp': {   // `cp name:/path -` -> tar of the container's data dir on stdout
      needEngine(); const [n, p] = a[1].split(':'); const c = s.containers[n]; if (!c) fail(`No such container: ${n}`);
      const base = p.replace(/^\//, '').split('/')[0];
      const r = spawnSync('tar', ['-cf', '-', '-C', c.dataDir, base], { stdio: ['ignore', 'inherit', 'inherit'] }); process.exit(r.status ?? 1); break;
    }
    default: fail('fakedocker: unsupported command ' + a.join(' '));
  }
}
