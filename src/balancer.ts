// Weighted TCP load balancer (this PC <-> remote PC). One listener per site port, bound to loopback only (127.0.0.1 and ::1).
// Smooth weighted round-robin, passive health (a backend that refuses a connection is skipped for a few seconds and the client is
// transparently retried on the other one), and zero-weight backends act as standby: used only when every weighted backend is down.
import * as net from 'net';

export interface Backend { name: string; host: string; port: number; weight: number }
export interface BackendStats { name: string; weight: number; conns: number; active: number; fails: number; bytesIn: number; bytesOut: number; down: boolean }
interface B extends Backend { forcedDown?: boolean; cur: number; downUntil: number; conns: number; active: number; fails: number; bytesIn: number; bytesOut: number }
interface L { servers: net.Server[]; backends: B[]; port: number }

const DOWN_MS = 4000, CONNECT_MS = 2000, REPLAY_MAX = 16384;

export class Balancer {
  private ls = new Map<number, L>();

  async start(port: number, backends: Backend[]): Promise<void> {
    if (this.ls.has(port)) throw new Error(`balancer already running on ${port}`);
    if (!backends.length) throw new Error('no backends');
    const l: L = { servers: [], port, backends: backends.map((b) => ({ ...b, cur: 0, downUntil: 0, conns: 0, active: 0, fails: 0, bytesIn: 0, bytesOut: 0 })) };
    const mk = (host: string) => new Promise<net.Server>((resolve, reject) => {
      const s = net.createServer({ allowHalfOpen: true }, (c) => this.handle(l, c)); s.on('error', (e: any) => reject(e));
      s.listen({ port, host }, () => { s.removeAllListeners('error'); s.on('error', () => 0); resolve(s); });
    });
    try { l.servers.push(await mk('127.0.0.1')); }
    catch (e: any) { throw new Error(e.code === 'EADDRINUSE' ? `127.0.0.1:${port} is already taken by another program` : 'cannot listen on 127.0.0.1:' + port + ': ' + e.message); }
    try { l.servers.push(await mk('::1')); }
    catch (e: any) { if (e.code !== 'EADDRNOTAVAIL' && e.code !== 'EAFNOSUPPORT') { l.servers.forEach((x) => x.close()); throw new Error(`[::1]:${port} is taken (${e.code}): localhost would bypass the split`); } }   // no IPv6 loopback at all is fine
    this.ls.set(port, l);
  }

  has = (port: number) => this.ls.has(port);

  /** Orchestrator-known health (e.g. the remote's port is closed according to the status poll). A forced-down backend is only used as a last resort. */
  setHealth(port: number, name: string, up: boolean) { const b = this.ls.get(port)?.backends.find((x) => x.name === name); if (b) { b.forcedDown = !up; if (up) b.downUntil = 0; } }

  /** Change the split on the fly (existing connections are untouched). */
  setWeights(port: number, w: Record<string, number>) {
    const l = this.ls.get(port); if (!l) throw new Error('no balancer on ' + port);
    for (const b of l.backends) if (b.name in w) { b.weight = Math.max(0, w[b.name]); b.cur = 0; b.downUntil = 0; }
  }

  stats(port: number): BackendStats[] {
    const l = this.ls.get(port); if (!l) return [];
    return l.backends.map((b) => ({ name: b.name, weight: b.weight, conns: b.conns, active: b.active, fails: b.fails, bytesIn: b.bytesIn, bytesOut: b.bytesOut, down: !!b.forcedDown || b.downUntil > Date.now() }));
  }
  resetStats(port: number) { for (const b of this.ls.get(port)?.backends ?? []) { b.conns = b.fails = b.bytesIn = b.bytesOut = 0; } }

  stop(port: number) { const l = this.ls.get(port); if (!l) return; this.ls.delete(port); for (const s of l.servers) s.close(); }
  stopAll() { for (const p of [...this.ls.keys()]) this.stop(p); }

  /** Smooth weighted round-robin over `cands`; exact long-run proportions, no clumping. */
  private pick(cands: B[]): B {
    let total = 0, best: B | null = null;
    for (const b of cands) { b.cur += b.weight; total += b.weight; if (!best || b.cur > best.cur) best = b; }
    best!.cur -= total; return best!;
  }

  private handle(l: L, client: net.Socket) {
    client.pause(); client.on('error', () => client.destroy());
    const now = Date.now(); const tried = new Set<B>();
    const sentBuf: Buffer[] = []; let sentLen = 0, clientEnded = false, replayable = true;   // request bytes kept (small) so a dead backend can be retried before it answered
    client.on('data', (d: Buffer) => { sentLen += d.length; if (sentLen <= REPLAY_MAX) sentBuf.push(d); else replayable = false; });
    client.on('end', () => { clientEnded = true; });
    const next = (): B | null => {
      const left = l.backends.filter((b) => !tried.has(b));
      const ok = (b: B) => !b.forcedDown && b.downUntil <= now;
      const live = left.filter((b) => ok(b) && b.weight > 0); if (live.length) return this.pick(live);
      const standby = left.filter(ok); if (standby.length) return standby.sort((a, b) => b.weight - a.weight)[0];   // zero-weight = standby
      const any = left.filter((b) => b.weight > 0); return any.length ? any[0] : left[0] ?? null;   // everything marked down: try anyway, it may have recovered
    };
    const idempotent = () => { const head = Buffer.concat(sentBuf).subarray(0, 8).toString('latin1'); return sentLen === 0 || /^(GET|HEAD|OPTIONS) /.test(head); };
    const attempt = (replay: boolean) => {
      const b = next(); if (!b) { client.destroy(); return; } tried.add(b);
      const up = net.connect({ host: b.host, port: b.port, allowHalfOpen: true }); let ok = false, got = 0, retried = false;
      up.setTimeout(CONNECT_MS, () => { if (!ok) up.destroy(new Error('timeout')); });
      up.on('error', () => up.destroy());
      const failOver = () => { if (retried) return; retried = true; b.fails++; b.downUntil = Date.now() + DOWN_MS; attempt(true); };
      up.on('connect', () => {
        ok = true; up.setTimeout(0); b.conns++; b.active++;
        for (const c of sentBuf) { up.write(c); b.bytesIn += c.length; } if (clientEnded) up.end();   // bytes that arrived before this backend was ready (or before a retry)
        // forward live client -> backend by hand (not pipe): the request bytes must stay replayable and a retry must not inherit this pipe
        const onData = (d: Buffer) => { b.bytesIn += d.length; if (!up.write(d)) { client.pause(); up.once('drain', () => client.resume()); } };
        const onEnd = () => up.end();
        client.on('data', onData); client.on('end', onEnd);
        // backend -> client by hand: a backend that closes WITHOUT having answered must not end the client's socket (we may still retry on the other backend)
        up.on('data', (d: Buffer) => { got += d.length; b.bytesOut += d.length; if (!client.write(d)) { up.pause(); client.once('drain', () => up.resume()); } });
        up.on('end', () => { if (got > 0) client.end(); else up.destroy(); });   // FIN with no answer: fail this backend now (a half-open socket would never reach 'close')   // half-close passes through; no idle timeouts, so SSE / websockets live on
        client.once('close', () => up.destroy()); client.resume();
        up.on('close', () => {
          b.active--; client.off('data', onData); client.off('end', onEnd);
          // an ssh -L tunnel accepts instantly even when the far side is dead, then closes without a single byte: that backend failed
          if (!got && sentLen > 0 && !client.destroyed) {
            b.fails++; b.downUntil = Date.now() + DOWN_MS;
            if (replayable && idempotent() && l.backends.some((x) => !tried.has(x))) { attempt(true); return; }
          }
          if (got > 0) client.end(); else client.destroy();   // let the answer flush
        });
      });
      up.on('close', () => { if (!ok) failOver(); });   // never connected: try the other backend (nothing was sent yet)
    };
    attempt(false);
  }
}
