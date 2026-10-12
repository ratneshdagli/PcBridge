// Apps: a named group of services (programs and Docker containers) that is moved, brought back, tested, exported and imported as ONE thing.
// An app is only a list of references: the programs live in config.programs, the containers are PC Bridge sites. Moving an app moves each member
// with the existing, tested mover (programs.ts / Offloader), in order, all-or-nothing (a failure puts the members already moved back).
// Members of one app that end up on DIFFERENT PCs still reach each other on localhost: PC Bridge opens a reverse link (ssh -R) from this PC.
import * as path from 'path';
import * as core from './core';

export const HERE = '@here';   // member target meaning "keep it on this PC"
export interface AppMember { kind: 'program' | 'container'; name: string; target?: string; project?: string; ports?: number[] }
export interface App { name: string; members: AppMember[]; target?: string; note?: string }
const APP_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

export function validateApps(c: core.Config): string[] {
  const e: string[] = []; const names = new Set<string>(), used = new Map<string, Set<string>>(); const pcs = new Set(c.remotes.map((r) => r.name));
  const okTarget = (t?: string) => t === undefined || t === HERE || pcs.has(t);
  for (const a of c.apps || []) {
    if (!APP_RE.test(a.name || '')) e.push(`App "${a.name}": name may use letters, digits, - and _ (max 40)`);
    if (names.has(a.name)) e.push(`App "${a.name}" is listed twice`); names.add(a.name);
    if (!Array.isArray(a.members) || !a.members.length || a.members.length > 30) e.push(`App "${a.name}": it needs 1 to 30 members`);
    if (!okTarget(a.target)) e.push(`App "${a.name}": unknown PC "${a.target}"`);
    if (a.note !== undefined && (typeof a.note !== 'string' || a.note.length > 300)) e.push(`App "${a.name}": the note is too long (max 300)`);
    for (const m of a.members || []) {
      const key = m.kind + ':' + m.name;
      if (m.kind !== 'program' && m.kind !== 'container') e.push(`App "${a.name}": member kind must be program or container`);
      else if (m.kind === 'program' && !(c.programs || []).some((p) => p.name === m.name)) e.push(`App "${a.name}": there is no program "${m.name}" (add it on the Programs screen first)`);
      else if (m.kind === 'container' && !core.CONTAINER_RE.test(m.name || '')) e.push(`App "${a.name}": "${m.name}" is not a container name`);
      if (!okTarget(m.target)) e.push(`App "${a.name}": ${m.name}: unknown PC "${m.target}"`);
      if (m.ports !== undefined && (!Array.isArray(m.ports) || m.ports.some((x) => !Number.isInteger(x) || x < 1 || x > 65535))) e.push(`App "${a.name}": ${m.name}: bad ports`);
      if (m.project !== undefined && !core.CONTAINER_RE.test(m.project)) e.push(`App "${a.name}": ${m.name}: bad project name`);
      if (used.get(a.name)?.has(key)) e.push(`App "${a.name}": ${m.kind} "${m.name}" is listed twice`); (used.get(a.name) ?? used.set(a.name, new Set()).get(a.name)!).add(key);   // the same part may be in SEVERAL apps (shared); it still runs in one place
    }
  }
  return e;
}

export interface AppDeps {
  where(m: AppMember): string;                       // HERE or the PC name where the member runs now
  ports(m: AppMember): number[];
  holder(m: AppMember): Promise<number | null>;      // programs: process on THIS PC holding the port
  moveProgram(name: string, stopPid: number | undefined, target: string): Promise<string>;
  homeProgram(name: string): Promise<string>;
  offloadContainer(m: AppMember, target: string): Promise<string>;   // also records m.project
  homeContainer(m: AppMember): Promise<void>;
  testPort(port: number): Promise<{ ok: boolean; detail: string; ms: number }>;
  save(): void;
}
export interface PlanRow { kind: string; name: string; from: string; to: string; action: 'move' | 'home' | 'already'; blocker?: string; shared?: string[]; note?: string }
/** The other apps that contain the same part. A shared part runs in ONE place for all of them. */
export const sharedWith = (c: core.Config, a: App, m: AppMember) => (c.apps || []).filter((x) => x.name !== a.name && x.members.some((y) => y.kind === m.kind && y.name === m.name)).map((x) => x.name);
/** Apps (other than `a`) that still have some OTHER part away from this PC and also use `m`: bringing `m` home would break them. */
const stillNeededBy = (c: core.Config, d: Pick<AppDeps, 'where'>, a: App, m: AppMember) => (c.apps || []).filter((x) => x.name !== a.name && x.members.some((y) => y.kind === m.kind && y.name === m.name) && x.members.some((y) => !(y.kind === m.kind && y.name === m.name) && d.where(y) !== HERE)).map((x) => x.name);
const busyParts = new Set<string>();
const partKeys = (a: App) => a.members.map((m) => m.kind + ':' + m.name);
export const label = (pc: string) => (pc === HERE ? 'this PC' : pc);
const find = (c: core.Config, name: string) => { const a = (c.apps || []).find((x) => x.name === name); if (!a) throw new Error(`Unknown app "${name}"`); return a; };
export const defaultTarget = (c: core.Config, a: App, t?: string) => t ?? a.target ?? core.remoteFor(c).name;

/** What "send" would do, member by member, without changing anything. */
export async function planApp(c: core.Config, d: AppDeps, name: string, target?: string): Promise<PlanRow[]> {
  const a = find(c, name); const rows: PlanRow[] = [];
  for (const m of a.members) {
    const to = m.target ?? defaultTarget(c, a, target); const from = d.where(m);
    if (to !== HERE && !c.remotes.some((r) => r.name === to)) throw new Error(`There is no PC named "${to}"`);
    const row: PlanRow = { kind: m.kind, name: m.name, from: label(from), to: label(to), action: from === to ? 'already' : to === HERE ? 'home' : 'move' };
    const sh = sharedWith(c, a, m); if (sh.length) row.shared = sh;
    if (row.action === 'move' && from === HERE && m.kind === 'program') { const h = await d.holder(m); if (h) row.blocker = `port ${d.ports(m)[0]} is used by process ${h} on this PC (it must be stopped first)`; }
    if (row.action === 'move' && from === HERE && m.kind === 'program') {   // dry run: which road the big copy will take
      const p = (c.programs || []).find((x) => x.name === m.name), rem = c.remotes.find((r) => r.name === to);
      if (p && rem) { const a = await core.bulkSshArgs(rem).catch(() => core.sshArgs(rem)), lan = a.join(' ') !== core.sshArgs(rem).join(' ');
        row.note = `copy goes over ${lan ? 'the home network (' + a[a.length - 1].split('@')[1] + ', limit 3 h)' : 'Tailscale (slow, limit 15 min)'}` + (p.requireFast && !lan ? ' -> WILL BE REFUSED (requireFast)' : '') + (p.python || p.requirements ? `; Python ${p.python || '3.12'}${p.requirements ? ' from ' + p.requirements : ''}` : '') + (p.pullExcludes?.length ? `; never copied back: ${p.pullExcludes.join(', ')}` : ''); if (p.requireFast && !lan) row.blocker = 'requireFast is set but the home network is not reachable'; }
    }
    rows.push(row);
  }
  return rows;
}

const busy = new Set<string>();
async function homeMember(d: AppDeps, m: AppMember) { if (m.kind === 'program') await d.homeProgram(m.name); else await d.homeContainer(m); }
async function sendMember(d: AppDeps, m: AppMember, to: string, stopPid?: number) { if (m.kind === 'program') await d.moveProgram(m.name, stopPid, to); else await d.offloadContainer(m, to); }

/** Moves every member to its PC, in the order of the list. All-or-nothing: if one fails, the members already moved in this run go back where they were. */
export async function sendApp(c: core.Config, d: AppDeps, name: string, o: { target?: string; stopLocal?: boolean } = {}): Promise<string[]> {
  const a = find(c, name); if (busy.has(name) || partKeys(a).some((k) => busyParts.has(k))) throw new Error('Another operation on this app (or on an app that shares a part with it) is still running');
  busy.add(name); partKeys(a).forEach((k) => busyParts.add(k)); const out: string[] = []; const done: { m: AppMember; from: string }[] = [];
  try {
    const plan = await planApp(c, d, name, o.target);
    const blocked = plan.filter((r) => r.blocker && !o.stopLocal); if (blocked.length) throw new Error('Nothing was moved. ' + blocked.map((r) => `${r.name}: ${r.blocker}`).join('; '));
    for (const row of plan) {
      const m = a.members.find((x) => x.name === row.name && x.kind === row.kind)!; const from = d.where(m); const to = m.target ?? defaultTarget(c, a, o.target);
      if (row.action === 'already') { out.push(`${m.name}: already on ${label(to)}`); continue; }
      let homed = false;
      try {
        if (from !== HERE) { await homeMember(d, m); homed = true; }       // a different PC runs it: bring it back first, then send it on
        if (to === HERE) { done.push({ m, from }); out.push(`${m.name}: back on this PC`); continue; }
        const pid = row.blocker ? await d.holder(m) ?? undefined : undefined;
        await sendMember(d, m, to, pid); done.push({ m, from }); out.push(`${m.name}: now on ${label(to)}`);
      } catch (e: any) {
        const back: string[] = [];
        if (homed) { try { await sendMember(d, m, from); back.push(m.name); } catch (e2: any) { core.log('err', `[app ${name}] could not put ${m.name} back on ${from}: ${e2.message}`); } }
        for (const x of done.reverse()) { try { if (x.from === HERE) await homeMember(d, x.m); else await sendMember(d, x.m, x.from); back.push(x.m.name); } catch (e2: any) { core.log('err', `[app ${name}] could not put ${x.m.name} back: ${e2.message}`); } }
        throw new Error(`${m.name} failed: ${String(e.message || e).split('\n')[0]}. ${back.length ? 'Put back where they were: ' + back.join(', ') + '.' : 'Nothing else had moved.'}`);
      }
    }
    d.save(); return out;
  } finally { busy.delete(name); partKeys(a).forEach((k) => busyParts.delete(k)); }
}

/** Brings every member back to this PC (reverse order). Keeps going if one fails and reports them all at the end. */
export async function homeApp(c: core.Config, d: AppDeps, name: string): Promise<string[]> {
  const a = find(c, name); if (busy.has(name) || partKeys(a).some((k) => busyParts.has(k))) throw new Error('Another operation on this app (or on an app that shares a part with it) is still running');
  busy.add(name); partKeys(a).forEach((k) => busyParts.add(k)); const out: string[] = [], bad: string[] = [];
  try {
    for (const m of [...a.members].reverse()) { if (d.where(m) === HERE) { out.push(`${m.name}: already on this PC`); continue; }
      const need = stillNeededBy(c, d, a, m); if (need.length) { out.push(`${m.name}: left on ${label(d.where(m))} because ${need.join(', ')} still use${need.length > 1 ? '' : 's'} it`); continue; }
      try { await homeMember(d, m); out.push(`${m.name}: back on this PC`); } catch (e: any) { bad.push(`${m.name}: ${String(e.message || e).split('\n')[0]}`); } }
    if (bad.length) throw new Error(bad.join('; ')); d.save(); return out;
  } finally { busy.delete(name); partKeys(a).forEach((k) => busyParts.delete(k)); }
}

export function statusApp(c: core.Config, d: Pick<AppDeps, 'where' | 'ports'>, a: App) {
  const members = a.members.map((m) => ({ ...m, pc: label(d.where(m)), ports: d.ports(m), sharedWith: sharedWith(c, a, m) })); const set = new Set(members.map((m) => m.pc));
  return { ...a, members, where: set.size === 1 ? [...set][0] : 'split across ' + [...set].join(' + '), links: wantedLinks({ ...c, apps: [a] }, d).length };
}

export async function testApp(c: core.Config, d: AppDeps, name: string): Promise<{ name: string; ok: boolean; detail: string; ms: number }[]> {
  const a = find(c, name); const rows: { name: string; ok: boolean; detail: string; ms: number }[] = [];
  for (const m of a.members) { const ps = d.ports(m); if (!ps.length) { rows.push({ name: `${m.name} (${m.kind})`, ok: false, detail: 'no port known yet: move it once, or check that the container publishes a port', ms: 0 }); continue; } for (const p of ps) { const r = await d.testPort(p); rows.push({ name: `${m.name} on ${label(d.where(m))}: localhost:${p}`, ok: r.ok, detail: r.detail, ms: r.ms }); } }
  return rows;
}

// ---- links between members on different PCs ----
export interface Link { pc: string; port: number }
export function wantedLinks(c: core.Config, d: Pick<AppDeps, 'where' | 'ports'>): Link[] {
  const out = new Map<string, Link>();
  for (const a of c.apps || []) {
    const locs = a.members.map((m) => d.where(m)); const pcs = [...new Set(locs.filter((l) => l !== HERE))]; if (new Set(locs).size < 2) continue;
    a.members.forEach((m, i) => { for (const pc of pcs) if (pc !== locs[i]) for (const port of d.ports(m)) out.set(pc + ':' + port, { pc, port }); });
  }
  // a moved program that still needs something on THIS PC (e.g. LM Studio). Skip a port whose owner program now runs on that same PC: it is local there, and a link would squat on the port.
  const ownerAt = (pc: string, port: number, except: string) => (c.programs || []).some((q) => q.name !== except && q.port === port && d.where({ kind: 'program', name: q.name }) === pc);
  for (const p of c.programs || []) { if (!p.needs?.length) continue; const pc = d.where({ kind: 'program', name: p.name }); if (pc !== HERE) for (const port of p.needs) if (!ownerAt(pc, port, p.name)) out.set(pc + ':' + port, { pc, port }); }
  return [...out.values()];
}
const linkId = (c: core.Config, l: Link) => -(1000 + Math.max(0, c.remotes.findIndex((r) => r.name === l.pc)) * 70000 + l.port);
const running = new Set<number>();
/** Starts the links the apps need and stops the ones they no longer need. Cheap to call often. */
export function syncLinks(c: core.Config, d: Pick<AppDeps, 'where' | 'ports'>, fwd: core.Forwarder) {
  const want = new Map(wantedLinks(c, d).map((l) => [linkId(c, l), l]));
  for (const id of [...running]) if (!want.has(id)) { fwd.stop(id); running.delete(id); core.log('info', 'App link stopped'); }
  for (const [id, l] of want) { if (!fwd.has(id)) { fwd.startReverse(core.remoteFor(c, l.pc), l.port, id); running.add(id); } }
}
export const hasLinks = () => running.size > 0;
export const stopAllLinks = (fwd: core.Forwarder) => { for (const id of running) fwd.stop(id); running.clear(); };

// ---- share: one JSON file describes the whole app ----
export function exportApp(c: core.Config, name: string, withEnv = false) {
  const a = find(c, name);
  return { pcbApp: 1, name: a.name, note: a.note ?? '', members: a.members.map((m) => {
    if (m.kind === 'container') return { kind: 'container', name: m.name, target: m.target };
    const p = (c.programs || []).find((x) => x.name === m.name)!;
    return { kind: 'program', name: p.name, folder: path.basename(p.dir), cmd: p.cmd, port: p.port, runtime: p.runtime, failover: p.failover, needs: p.needs, omitDev: p.omitDev, ignoreScripts: p.ignoreScripts, env: Object.fromEntries(Object.entries(p.env || {}).map(([k, v]) => [k, withEnv ? v : ''])), target: m.target };
  }) };
}
/** Adds the programs and the app described by an exported file. `baseDir` is the folder on THIS PC that holds the program folders. Never overwrites. */
export function importApp(c: core.Config, manifest: any, baseDir: string, rename?: string): { name: string; warnings: string[] } {
  if (!manifest || manifest.pcbApp !== 1 || !Array.isArray(manifest.members)) throw new Error('This is not a PC Bridge app file');
  if (!baseDir || !path.isAbsolute(baseDir)) throw new Error('Say which folder on this PC holds the program folders (a full path)');
  const name = String(rename || manifest.name); if ((c.apps || []).some((a) => a.name === name)) throw new Error(`An app named "${name}" already exists; pick another name`);
  const warnings: string[] = []; const progs: any[] = []; const members: AppMember[] = [];
  for (const m of manifest.members) {
    if (m.kind === 'container') { members.push({ kind: 'container', name: String(m.name) }); warnings.push(`${m.name}: a container; it must exist on this PC (importing does not create it)`); continue; }
    if (m.kind !== 'program') throw new Error('Unknown member kind in the file');
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(String(m.folder || ''))) throw new Error(`${m.name}: bad folder name`);
    let pname = String(m.name); const same = (c.programs || []).find((x) => x.name === pname && x.cmd === String(m.cmd) && x.port === Number(m.port));
    if (same) { members.push({ kind: 'program', name: pname }); warnings.push(`${pname}: already registered here with the same command and port, so it is shared with the other app(s)`); continue; }
    if ((c.programs || []).some((x) => x.name === pname)) { pname = `${name}-${pname}`; warnings.push(`${m.name}: a program with that name exists, imported as ${pname}`); }
    const dir = path.join(baseDir, String(m.folder)); const env = Object.fromEntries(Object.entries(m.env || {}).map(([k, v]) => [k, String(v)]));
    const empty = Object.entries(env).filter(([, v]) => v === '').map(([k]) => k); if (empty.length) warnings.push(`${pname}: environment values are not in the file; fill in ${empty.join(', ')}`);
    progs.push({ name: pname, dir, cmd: String(m.cmd), port: Number(m.port), mode: 'local', env, runtime: m.runtime, failover: m.failover, ...(m.omitDev === true ? { omitDev: true } : {}), ...(m.ignoreScripts === true ? { ignoreScripts: true } : {}), ...(Array.isArray(m.needs) && m.needs.length ? { needs: m.needs.map(Number) } : {}) }); members.push({ kind: 'program', name: pname });
  }
  const before = { programs: c.programs, apps: c.apps };
  c.programs = [...(c.programs || []), ...progs]; c.apps = [...(c.apps || []), { name, members, note: typeof manifest.note === 'string' ? manifest.note.slice(0, 300) : undefined }];
  const errs = core.validateConfig(c); if (errs.length) { c.programs = before.programs; c.apps = before.apps; throw new Error(errs.join('\n')); }
  return { name, warnings };
}
