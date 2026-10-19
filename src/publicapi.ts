// Public local API: lets AI agents, scripts and any other program on THIS PC read PC Bridge's state and (optionally) control it.
// Off by default. Loopback only, bearer token on every call, separate switch for "control" (write) endpoints, Host check against DNS rebinding,
// every call is counted (per endpoint and per client) so the UI can show who uses what.
import * as crypto from 'crypto';
import * as http from 'http';
import * as core from './core';
import * as fs from 'fs';
import * as path from 'path';

/** When the compiled code of the RUNNING service was built (newest file in dist/src at start): tells which build is live. */
const BUILD = (() => { try { return new Date(Math.max(...fs.readdirSync(__dirname).filter((f) => f.endsWith('.js')).map((f) => fs.statSync(path.join(__dirname, f)).mtimeMs))).toISOString(); } catch { return 'unknown'; } })();

type H = Record<string, (...a: any[]) => Promise<unknown> | unknown>;
export interface ApiDeps { cfg: () => core.Config; save: () => void; H: H; status: () => core.Status | null; balStats: () => unknown; version: string }
interface Ctx { params: Record<string, string>; query: URLSearchParams; body: any }
export interface Route { method: 'GET' | 'POST'; path: string; scope: 'public' | 'read' | 'control'; summary: string; body?: string; returns?: string; example?: string; run: (c: Ctx) => Promise<unknown> | unknown }
interface Stat { calls: number; errors: number; lastAt: number; lastClient: string; totalMs: number; bytesOut: number }
export interface UsageEntry { t: number; method: string; path: string; status: number; ms: number; client: string }

export const newToken = () => 'pcb_' + crypto.randomBytes(24).toString('hex');
export const defaultApi = (): NonNullable<core.Config['api']> => ({ enabled: false, port: 8787, token: '', control: false });

export class PublicApi {
  private server: http.Server | null = null; private stats = new Map<string, Stat>(); private clients = new Map<string, { calls: number; lastAt: number; lastPath: string }>(); private recent: UsageEntry[] = [];
  private startedAt = 0; private inflight = 0; routes: Route[];
  constructor(private d: ApiDeps) { this.routes = this.table(); }

  get running() { return !!this.server; }
  private api() { return this.d.cfg().api ?? defaultApi(); }

  private table(): Route[] {
    const H = this.d.H; const R = (r: Route) => r;
    const num = (v: string, what: string) => { const n = Number(v); if (!Number.isInteger(n)) throw new HttpError(400, `${what} must be a whole number`); return n; };
    return [
      R({ method: 'GET', path: '/health', scope: 'public', summary: 'Is PC Bridge up? (no token needed, no data)', example: 'curl http://127.0.0.1:{port}/api/v1/health', run: () => ({ ok: true, version: this.d.version, build: BUILD, uptimeS: Math.round((Date.now() - this.startedAt) / 1000) }) }),
      R({ method: 'GET', path: '/status', scope: 'read', summary: 'Live status of the remote PC (online, latency, CPU/RAM/disks/GPU, Docker + containers) and of this PC.', run: () => this.d.status() ?? { error: 'no status yet' } }),
      R({ method: 'GET', path: '/ports', scope: 'read', summary: 'Every listening port on this PC: program, PID, purpose, CPU/RAM/IO, reachable-from-network flag, whether it can be offloaded.', run: async () => { const r = (await H['ports:list']()) as any; return { ...r, local: r.local.map(({ cmd: _c, ...p }: any) => p) }; } }),
      R({ method: 'GET', path: '/containers', scope: 'read', summary: 'Docker containers on this PC with their published ports and whether they are already offloaded.', run: () => H['containers:list']() }),
      R({ method: 'GET', path: '/projects', scope: 'read', summary: 'Offloaded / split sites: where each runs, its share (% to the remote) and live balancer counters.', run: async () => { const c = this.d.cfg(); const bal = this.d.balStats() as Record<string, unknown>; return c.projects.map((p) => ({ ...p, balancer: bal[p.name] ?? null })); } }),
      R({ method: 'GET', path: '/forwards', scope: 'read', summary: 'Port forwards (this PC -> remote) and their live state.', run: async () => ({ presets: this.d.cfg().forwards, live: ((await H['config:get']()) as any).fwd }) }),
      R({ method: 'GET', path: '/remotes', scope: 'read', summary: 'The configured remote PCs (no secrets) and which one is active.', run: () => { const c = this.d.cfg(); return { active: c.activeRemote, remotes: c.remotes.map((r) => ({ name: r.name, host: r.host, user: r.user, port: r.port, routes: r.routes ?? [], fastCopy: r.fastCopy !== false })) }; } }),
      R({ method: 'GET', path: '/peers', scope: 'read', summary: 'PCs on your Tailscale network that could be connected (online, SSH open).', run: () => H['setup:discover']() }),
      R({ method: 'GET', path: '/logs', scope: 'read', summary: 'Recent command log. Query: n (default 200, max 1500), errors=1 for errors only.', example: 'curl -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:{port}/api/v1/logs?n=50&errors=1"',
        run: async ({ query }) => { const n = Math.min(1500, Math.max(1, Number(query.get('n') || 200))); let l = ((await H['logs:all']()) as core.LogEntry[]); if (query.get('errors')) l = l.filter((e) => e.kind === 'err'); return l.slice(-n).map((e) => ({ ...e, msg: e.msg.replace(/((?:^|\s)(?:-e|--env|--password|--pass|--token|--secret|--api-key)[ =])\S+/gi, '$1***').replace(/([A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z_]*=)\S+/g, '$1***') })); } }),
      R({ method: 'GET', path: '/usage', scope: 'read', summary: 'Who called which endpoint, how often, how fast; the last 200 calls.', run: () => this.usage() }),
      R({ method: 'GET', path: '/test/all', scope: 'read', summary: 'Run every self test (connection, remote Docker, forwards, sites, ports). Returns [{name, ok, detail, ms}].', run: () => H['test:all']() }),
      R({ method: 'GET', path: '/test/connection', scope: 'read', summary: 'Self test of the link to the remote PC only.', run: () => H['test:connection']() }),
      R({ method: 'GET', path: '/test/project/:name', scope: 'read', summary: 'Self test of one site (including the load split when it is split).', run: ({ params }) => H['test:project'](params.name) }),
      R({ method: 'GET', path: '/test/port/:port', scope: 'read', summary: 'Does localhost:port answer (TCP and HTTP)?', run: ({ params }) => H['test:port'](num(params.port, 'port')) }),
      R({ method: 'POST', path: '/projects/:name/share', scope: 'control', summary: 'Choose how the load is shared: share = % of connections for the remote PC (0 = all on this PC, 100 = all on the remote, e.g. 80 = 80/20).', body: '{ "share": 0-100 }', example: 'curl -X POST -H "Authorization: Bearer $TOKEN" -d \'{"share":80}\' http://127.0.0.1:{port}/api/v1/projects/searxng/share',
        run: ({ params, body }) => H['proj:share'](params.name, Number(body?.share)) }),
      R({ method: 'POST', path: '/projects/:name/offload', scope: 'control', summary: 'Move the site completely to the remote PC (same as share 100).', run: ({ params }) => H['proj:offload'](params.name) }),
      R({ method: 'POST', path: '/projects/:name/home', scope: 'control', summary: 'Bring the site back to this PC (stays here until you offload it again).', run: ({ params }) => H['proj:home'](params.name) }),
      R({ method: 'POST', path: '/containers/:name/offload', scope: 'control', summary: 'Offload any container of this PC (copies its config and data to the remote). Optional share (default 100).', body: '{ "share": 0-100, "target": "PC name" }  (both optional; defaults: 100 and the active PC)', run: ({ params, body }) => H['containers:offload'](params.name, body?.share === undefined ? 100 : Number(body.share), body?.target) }),
      R({ method: 'GET', path: '/programs', scope: 'read', summary: 'Plain programs registered for moving (name, folder, command, port, where they run, remote state).', run: () => H['programs:list']() }),
      R({ method: 'GET', path: '/test/program/:name', scope: 'read', summary: 'Self test of one moved program (remote folder not on C:, supervisor, port, forward).', run: ({ params }) => H['test:program'](params.name) }),
      R({ method: 'GET', path: '/programs/updates', scope: 'read', summary: 'What is outdated on the remote: portable Node, uv, each moved program\'s libraries, Linux packages in WSL (report only). Changes nothing.', run: () => H['programs:update'](false) }),
      R({ method: 'POST', path: '/programs/update', scope: 'control', summary: 'Update the remote\'s Node (same major, checksum verified), uv and every moved program\'s libraries, then restart the affected programs.', run: () => H['programs:update'](true) }),
      R({ method: 'POST', path: '/programs/:name/move', scope: 'control', summary: 'Move a registered program to a PC: copies it, installs its libraries there, starts it, forwards its port back to localhost. Fails if a process on this PC holds the port; pass that process id as stopLocalPid to let PC Bridge stop it.', body: '{ "target": "PC name", "stopLocalPid": 1234 } (both optional)', returns: 'text: where it runs now', run: ({ params, body }) => H['programs:move'](params.name, body?.stopLocalPid === undefined ? undefined : Number(body.stopLocalPid), body?.target) }),
      R({ method: 'POST', path: '/programs/:name/home', scope: 'control', summary: 'Bring a program back to this PC.', run: ({ params }) => H['programs:home'](params.name) }),
      R({ method: 'POST', path: '/forwards/:port/start', scope: 'control', summary: 'Start a saved port forward.', run: ({ params }) => H['fwd:start'](num(params.port, 'port')) }),
      R({ method: 'POST', path: '/forwards/:port/stop', scope: 'control', summary: 'Stop a port forward.', run: ({ params }) => H['fwd:stop'](num(params.port, 'port')) }),
      R({ method: 'POST', path: '/remote/wake', scope: 'control', summary: 'Wake Docker (WSL) on the remote PC.', run: () => H['wake']() }),
      R({ method: 'GET', path: '/info', scope: 'public', summary: 'START HERE. Self-description of this API: how to authenticate, what every endpoint does, what it returns, and the usual workflows. No token needed, no private data.', returns: '{ name, version, base, auth, scopes, concepts, workflows, endpoints[] }', run: () => this.info(this.api().port) }),
      R({ method: 'GET', path: '/guide', scope: 'public', summary: 'The same as /info but as one plain-text (Markdown) page: paste it straight into any AI as instructions.', returns: 'text/markdown', run: () => ({ __text: this.guide(this.api().port, '<TOKEN>') }) }),
      R({ method: 'GET', path: '/overview', scope: 'read', summary: 'EVERYTHING in one call: all PCs and whether they answer, remote status, containers, ports, moved sites, programs, forwards.', returns: '{ pcs[], status, containers[], ports, projects[], programs[], forwards } (a part that failed is { error })', run: async () => {
        const one = async (f: () => unknown) => { try { return await f(); } catch (e: any) { return { error: String(e.message || e).split('\n')[0] }; } };
        return { pcs: await one(() => H['pcs:list']()), status: this.d.status() ?? { error: 'no status yet' }, containers: await one(() => H['containers:list']()), ports: await one(async () => { const r = (await H['ports:list']()) as any; return { ...r, local: r.local.map(({ cmd: _c, ...p }: any) => p) }; }), projects: await one(() => this.d.cfg().projects), programs: await one(() => H['programs:list']()), forwards: await one(() => this.d.cfg().forwards) }; } }),
      R({ method: 'GET', path: '/pcs', scope: 'read', summary: 'Every connected PC: name, address, which one is active, does it answer now, and which sites/programs run on it.', returns: '[{ name, host, user, active, reachable: true|false|null, sites[], programs[] }]', run: () => H['pcs:list']() }),
      R({ method: 'GET', path: '/app', scope: 'read', summary: 'PC Bridge itself: memory used and uptime.', returns: '{ rssMB, heapMB, uptimeS }', run: () => H['app:stats']() }),
      R({ method: 'GET', path: '/programs/:name/logs', scope: 'read', summary: 'Last lines of a moved program\'s output on its PC.', returns: 'text', run: ({ params }) => H['programs:logs'](params.name) }),
      R({ method: 'GET', path: '/test/forward/:port', scope: 'read', summary: 'Does a saved forward answer on localhost:port?', returns: 'text', run: ({ params }) => H['fwd:test'](num(params.port, 'port')) }),
      R({ method: 'GET', path: '/remote/containers/:name/logs', scope: 'read', summary: 'Last log lines of a container on the ACTIVE remote PC.', returns: 'text', run: ({ params }) => H['container'](params.name, 'logs') }),
      R({ method: 'POST', path: '/remote/containers/:name/:action', scope: 'control', summary: 'start | stop | restart a container on the ACTIVE remote PC (action is the last path part).', returns: 'text', run: ({ params }) => { if (!['start', 'stop', 'restart'].includes(params.action)) throw new HttpError(400, 'action must be start, stop or restart'); return H['container'](params.name, params.action); } }),
      R({ method: 'POST', path: '/programs', scope: 'control', summary: 'REGISTER a program (the way to hand code to PC Bridge): a folder on this PC + its start command + its port. It does not move it yet; call /programs/:name/move next. Registering a name that already exists UPDATES it in place (refused with 400 while it runs on another PC).', body: '{ "name": "myapp", "dir": "D:\\code\\myapp", "cmd": "node server.js", "port": 3000, "env": {"KEY":"value"} (optional), "runtime": "node"|"python" (optional, else guessed), "ignoreScripts": true (optional, Node: skip the install scripts of dependencies, e.g. when "gyp ERR! find VS" shows a native package tries to compile on a PC without Visual Studio although it ships a ready binary; the own postinstall of the program still runs),"omitDev": true (optional, Node: install only "dependencies" on the other PC, skipping devDependencies such as test tools that can fail there), "needs": [1234] (optional: ports of services that stay on THIS PC, e.g. LM Studio; while the program runs on another PC they answer there on localhost:1234 too), "python": "3.13" (optional, Python: version of the venv built on the other PC, default 3.12), "requirements": "requirements.lock" (optional, Python: install from this file of the folder instead of requirements.txt / pyproject.toml; if pyproject.toml exists the project itself is then installed with --no-deps; a failing pin is named in the error), "pullExcludes": ["data","models"] (optional: folders that "home", Quit and failover do NOT copy back from the other PC; they stay there, pushing them still works), "requireFast": true (optional: the copy must use the home network: otherwise it is refused before anything is copied) }. Everything in the folder is copied, including .env and database files; only node_modules, .git, __pycache__ and .venv are skipped (a Windows venv is never copied: a fresh one is built from requirements.txt on the other PC).', returns: 'true',
        run: ({ body }) => { if (!body?.name || !body?.dir || !body?.cmd || !body?.port) throw new HttpError(400, 'name, dir, cmd and port are required'); try { return H['programs:add'](body); } catch (e: any) { throw new HttpError(400, String(e.message || e).split('\n')[0]); } } }),
      R({ method: 'POST', path: '/programs/:name/push', scope: 'control', summary: 'Send changed files of a program that already runs on another PC, WITHOUT a new full copy and without restarting it (unless asked). Use it after you edit files in the program\'s folder on this PC. Without "files" it sends every file changed since the last copy or push. node_modules, .venv, .git and __pycache__ are never sent.', body: '{ "files": ["docs/try.html", { "path": "lib/x.js", "content": "...", "base64": false }] (optional; a string is a path relative to the program folder, an object sends the content itself so the folder need not exist on this PC), "restart": true|false (optional, default false; true restarts the program on its PC and waits up to 30 s for its port, the answer says whether it came back) }', returns: 'text: what was sent and, with restart, whether the program answers again',
        run: async ({ params, body }) => { try { return await H['programs:push'](params.name, body?.files, body?.restart === true); } catch (e: any) { throw new HttpError(400, String(e.message || e).split('\n')[0]); } } }),
      R({ method: 'GET', path: '/links', scope: 'read', summary: 'Every address worth opening, in one list: each program, container/compose project and forward with its clickable localhost URLs (the main port plus its saved pages such as /docs/try.html), where it runs and which apps it belongs to. localhost:PORT works wherever the program runs.', returns: '[{ kind:"program"|"container"|"compose"|"forward", name, pc, apps:[...], links:[{ label, url }] }]', run: () => H['links:list']() }),
      R({ method: 'POST', path: '/pages', scope: 'control', summary: 'Set the extra pages (paths on its port, like /docs/try.html) that PC Bridge shows as clickable links for a program or project. An empty list clears them.', body: '{ "kind": "program"|"project", "name": "camofox", "pages": ["/docs/try.html"] }', returns: 'the saved list',
        run: ({ body }) => { try { return H['pages:set'](body?.kind, body?.name, body?.pages); } catch (e: any) { throw new HttpError(400, String(e.message || e).split('\n')[0]); } } }),
      R({ method: 'POST', path: '/net/check', scope: 'control', summary: 'Check outbound internet from another PC: for each address the DNS answer and several GET attempts (status + ms), plus that PC\'s DNS servers and system proxy. Read-only; use it to find intermittent failures.', body: '{ "urls": ["https://en.wikipedia.org/"] (1-8), "program": "name" (optional: check from the PC that program runs on; default = active PC), "tries": 3 (optional, 1-4) }', returns: 'JSON',
        run: async ({ body }) => { try { return await H['net:check'](body?.urls, body?.program, body?.tries); } catch (e: any) { throw new HttpError(400, String(e.message || e).split('\n')[0]); } } }),
      R({ method: 'POST', path: '/programs/:name/remove', scope: 'control', summary: 'Forget a program (only when it runs on this PC; bring it back first).', returns: 'true', run: ({ params }) => H['programs:remove'](params.name) }),
      R({ method: 'POST', path: '/programs/prepare', scope: 'control', summary: 'Create the PC Bridge folder on a PC\'s non-C drive and unpack portable Node there (checksum checked). Safe to repeat.', body: '{ "target": "PC name" } (optional, default = active PC)', returns: 'text lines', run: ({ body }) => H['programs:prepare'](body?.target) }),
      R({ method: 'POST', path: '/programs/autoupdate', scope: 'control', summary: 'Switch the weekly automatic update of Node, uv and program libraries on or off.', body: '{ "on": true|false }', returns: 'true|false', run: ({ body }) => H['programs:autoupdate'](body?.on === true) }),
      R({ method: 'POST', path: '/remotes/active', scope: 'control', summary: 'Choose which PC is the default for new moves. Things already moved stay where they are.', body: '{ "name": "PC name" }', returns: 'the new active name', run: ({ body }) => { const i = this.d.cfg().remotes.findIndex((r) => r.name === body?.name); if (i < 0) throw new HttpError(400, 'unknown PC name (see GET /pcs)'); return H['remote:use'](i); } }),
      R({ method: 'POST', path: '/forwards', scope: 'control', summary: 'Save a new forward: remotePort on the active PC appears as localPort on this PC. Start it with /forwards/:port/start.', body: '{ "name": "x", "localPort": 9000, "remotePort": 9000, "remoteHost": "127.0.0.1", "autoStart": true }', returns: 'ok', run: ({ body }) => { if (!body?.name || !Number.isInteger(body?.localPort) || !Number.isInteger(body?.remotePort)) throw new HttpError(400, 'name, localPort, remotePort are required'); return H['fwd:add']({ remoteHost: '127.0.0.1', ...body }); } }),
      R({ method: 'POST', path: '/forwards/:port/remove', scope: 'control', summary: 'Delete a saved forward (stops it first).', returns: 'ok', run: ({ params }) => H['fwd:remove'](num(params.port, 'port')) }),
      R({ method: 'GET', path: '/apps', scope: 'read', summary: 'Apps = named groups of programs/containers that move together. Where each member runs now and whether that PC answers.', returns: '[{ name, note, target, where:"this PC"|"<PC>"|"split across ...", links, members:[{kind,name,target,pc,ports,up}] }]', run: () => H['apps:list']() }),
      R({ method: 'GET', path: '/apps/:name/plan', scope: 'read', summary: 'Dry run of "send": what would move where, and what blocks it. Changes nothing. Query: target=<PC name> (optional).', returns: '[{ kind, name, from, to, action:"move"|"home"|"already", blocker? }]', run: ({ params, query }) => H['apps:plan'](params.name, query.get('target') || undefined) }),
      R({ method: 'GET', path: '/apps/:name/export', scope: 'read', summary: 'The app as one shareable JSON file (programs with command and port, containers by name). Environment values are left out unless withEnv=1.', returns: '{ pcbApp:1, name, members[] }', run: ({ params, query }) => H['apps:export'](params.name, query.get('withEnv') === '1') }),
      R({ method: 'GET', path: '/test/app/:name', scope: 'read', summary: 'Self test of an app: does every member answer on its localhost port?', returns: '[{ name, ok, detail, ms }]', run: ({ params }) => H['apps:test'](params.name) }),
      R({ method: 'POST', path: '/apps', scope: 'control', summary: 'Create or replace an app. Members are existing programs (register them first with POST /programs) and/or container names. Members are moved in the order listed.', body: '{ "name": "shop", "note": "", "target": "PC name"|"@here" (optional default PC), "members": [ { "kind": "program"|"container", "name": "api", "target": "PC name"|"@here" (optional per member) } ], "original": "old name (only when renaming)" }', returns: 'true',
        run: ({ body }) => H['apps:save']({ name: body?.name, members: body?.members, target: body?.target, note: body?.note }, body?.original ?? body?.name) }),
      R({ method: 'POST', path: '/apps/import', scope: 'control', summary: 'Add an app from an exported file. baseDir = folder on THIS PC that contains the program folders. Never overwrites an existing app or program.', body: '{ "manifest": { ...exported file... }, "baseDir": "D:\code", "rename": "newname" (optional) }', returns: '{ name, warnings[] }', run: ({ body }) => H['apps:import'](body?.manifest, body?.baseDir, body?.rename) }),
      R({ method: 'POST', path: '/apps/:name/send', scope: 'control', summary: 'Send the WHOLE app: every member goes to its PC (member target, else this target, else the app default, else the active PC), in order. All-or-nothing: on a failure the members already moved go back. Members on different PCs still reach each other on localhost (reverse links).', body: '{ "target": "PC name" (optional), "stopLocal": true|false (optional; allow stopping a process on this PC that holds a member\'s port) }', returns: 'lines: "<member>: now on <PC>"', run: ({ params, body }) => H['apps:send'](params.name, body?.target, body?.stopLocal === true) }),
      R({ method: 'POST', path: '/apps/:name/home', scope: 'control', summary: 'Bring the WHOLE app back to this PC (runs here again).', returns: 'lines', run: ({ params }) => H['apps:home'](params.name) }),
      R({ method: 'POST', path: '/apps/:name/remove', scope: 'control', summary: 'Forget the app definition only (members keep running where they are; programs stay registered).', returns: 'true', run: ({ params }) => H['apps:remove'](params.name) }),
      R({ method: 'POST', path: '/refresh', scope: 'control', summary: 'Poll the remote right now instead of waiting for the next cycle.', run: () => H['status:refresh']() }),
    ];
  }

  async start() {
    if (this.server) return; const a = this.api(); if (!a.token) throw new Error('no API token');
    this.startedAt = Date.now();
    this.server = http.createServer((q, r) => void this.handle(q, r).catch(() => { try { r.writeHead(500).end('{"error":"internal"}'); } catch { /* gone */ } }));
    await new Promise<void>((res, rej) => { this.server!.once('error', (e: any) => { this.server = null; rej(new Error(e.code === 'EADDRINUSE' ? `API port ${a.port} is already used by another program` : e.message)); }); this.server!.listen(a.port, '127.0.0.1', () => res()); });
    core.log('info', `Public API on http://127.0.0.1:${a.port}/api/v1 (${a.control ? 'read + control' : 'read-only'})`);
  }
  async stop() { const s = this.server; this.server = null; if (s) { await new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections?.(); }); core.log('info', 'Public API stopped'); } }
  /** Apply the config (start / stop / restart on port change). */
  async apply() { const a = this.api(); const port = (this.server?.address() as any)?.port; if (!a.enabled) return this.stop(); if (this.server && port !== a.port) await this.stop(); if (!this.server) await this.start(); }

  private static RET: Record<string, string> = {
    'GET /status': '{ ssh:{ok}, docker:{ok,containers[{name,state,ports}]}, system:{cpu,ram,disks[],gpu}, local:{...} } for the ACTIVE remote PC',
    'GET /ports': '{ local:[{port,pid,program,purpose,cpu,ramMB,reachableFromNetwork,canOffload}], remote:[...] }',
    'GET /containers': '[{ name, image, ports[], offloaded, project, pc, mode:"local"|"remote"|"split", share, twin, remoteRunning }]',
    'GET /projects': '[{ name, mode:"local"|"remote"|"split", share, remote, ports[], balancer }]',
    'GET /forwards': '{ presets:[{name,localPort,remotePort,remoteHost,autoStart}], live:[...] }',
    'GET /remotes': '{ active:index, remotes:[{name,host,user,port,routes[],fastCopy:bool (true = big copies use the home-network address when on the same Wi-Fi, ~17x faster than Tailscale)}] }',
    'GET /peers': '[{ name, ip, online, sshOpen }]',
    'GET /logs': '[{ t, kind:"info"|"cmd"|"err", msg }] (secrets are masked)',
    'GET /usage': '{ running, endpoints[{calls,errors,avgMs}], clients[], recent[] }',
    'GET /programs': '[{ name, dir, cmd, port, mode, pc, live:{running,pid,port}|null, holder }]',
    'GET /programs/updates': '[{ name, current, latest, outdated }]',
    'GET /test/all': '[{ name, ok, detail, ms }]',
  };
  private static WORKFLOWS = [
    'See everything: GET /overview (one call) or GET /pcs, /status, /containers, /ports, /projects, /programs.',
    'Hand code to another PC: POST /programs {name,dir,cmd,port} -> POST /programs/prepare -> POST /programs/{name}/move. localhost:{port} on this PC then reaches the copy on the other PC; the URL never changes.',
    'Check it works: GET /test/program/{name}, GET /programs/{name}/logs, GET /test/port/{port}.',
    'Bring it back: POST /programs/{name}/home (copies changed files back and starts it here again).',
    'Move a whole stack (frontend + backend + ...): register each program (POST /programs), group them (POST /apps), look (GET /apps/{name}/plan), then POST /apps/{name}/send {"target":"<PC>"}. Back: POST /apps/{name}/home. Share it: GET /apps/{name}/export then POST /apps/import on another PC.',
    'Move a Docker container: POST /containers/{name}/offload {"share":100}. Split the load: POST /projects/{name}/share {"share":80}. Back: POST /projects/{name}/home.',
    'Update the other PC (Node, uv, libraries): GET /programs/updates to look, POST /programs/update to apply; POST /programs/autoupdate {"on":true} for weekly.',
    'Another PC joins later: connect it once in PC Bridge > Setup; then moves accept "target":"<PC name>". GET /pcs lists them.',
  ];
  private static CONCEPTS = [
    'Everything is on THIS PC at 127.0.0.1; nothing is exposed to the network. Other PCs are reached by PC Bridge over Tailscale + SSH keys, never by this API.',
    'Scopes: public (no token), read (token), control (token AND "Allow control" switched on in PC Bridge > API).',
    '"remote" / "other PC" means a connected PC by NAME (GET /pcs). The active PC is only the default for new moves.',
    'An APP is a named group of programs and/or containers (frontend, backend, database...). It is sent, brought back, tested and shared as one; each part can have its own PC (member "target": a PC name, or "@here" to keep that part on this PC while the rest moves) and they still reach each other on localhost. A part may be in SEVERAL apps (e.g. a shared search service): it still runs in ONE place for all of them (GET /apps shows "sharedWith"), and bringing one app back leaves a shared part where it is while another app still needs it.',
    'A moved site/program keeps its localhost port: PC Bridge forwards it, so clients never change their URL.',
    'Programs are copied to the other PC\'s non-C drive (E:\\PCBridge). Nothing is installed on C:.',
    'Errors are JSON { "error": "..." } with HTTP 400/401/403/404/413/429/500.',
  ];
  private ret(r: Route) { return r.returns ?? PublicApi.RET[`${r.method} ${r.path}`] ?? null; }

  /** Machine-readable self description (GET /info). */
  info(port: number) {
    return { name: 'PC Bridge local API', version: this.d.version, build: BUILD, base: `http://127.0.0.1:${port}/api/v1`,
      auth: 'Header  Authorization: Bearer <token>  on every endpoint except /health, /info, /guide, /docs, /openapi.json. The token is in PC Bridge > API (Show / Copy). Optional header X-Client-Name: <your name> shows you in the "Programs using it" list.',
      switchOn: 'PC Bridge > API: switch API on (listens on 127.0.0.1 only), switch "allow control" on to use the control endpoints.',
      scopes: { public: 'no token', read: 'token, only reads', control: 'token + Allow control' }, concepts: PublicApi.CONCEPTS, workflows: PublicApi.WORKFLOWS,
      endpoints: this.routes.map((r) => ({ method: r.method, path: '/api/v1' + r.path, scope: r.scope, summary: r.summary, body: r.body ?? null, returns: this.ret(r) })),
      moreDocs: { html: `http://127.0.0.1:${port}/api/v1/docs`, openapi: `http://127.0.0.1:${port}/api/v1/openapi.json`, text: `http://127.0.0.1:${port}/api/v1/guide` } };
  }

  /** The whole API as one Markdown page an AI can read (GET /guide, and the UI "Copy for an AI" button). */
  guide(port: number, token: string) {
    const base = `http://127.0.0.1:${port}/api/v1`; const L: string[] = [];
    L.push(`# PC Bridge local API (v${this.d.version})`, '', 'PC Bridge connects this Windows PC to other PCs (over Tailscale + SSH) and can move Docker containers and plain programs (Node, Python) to them. This API lets you read everything that is going on and, if allowed, control it.', '',
      '## Connect', `- Base URL: \`${base}\` (127.0.0.1 only)`, `- Header on every call except the public ones: \`Authorization: Bearer ${token}\``, '- Optional header: `X-Client-Name: <your name>` (shows in PC Bridge > API > Programs using it)', '- Bodies are JSON. Errors are `{ "error": "..." }`.',
      '- Public (no token): GET /health, /info, /guide, /docs, /openapi.json. read = token. control = token AND "Allow control" switched on in PC Bridge > API (otherwise HTTP 403).', '', '## Concepts', ...PublicApi.CONCEPTS.map((x) => '- ' + x), '', '## Typical workflows', ...PublicApi.WORKFLOWS.map((x) => '- ' + x), '', '## Endpoints', '');
    for (const sc of ['public', 'read', 'control'] as const) {
      L.push(`### ${sc}`, '');
      for (const r of this.routes.filter((x) => x.scope === sc)) { L.push(`- \`${r.method} /api/v1${r.path}\` - ${r.summary}`); if (r.body) L.push(`  - body: \`${r.body}\``); const t = this.ret(r); if (t) L.push(`  - returns: ${t}`); }
      L.push('');
    }
    L.push('## Examples', '```', `curl ${base}/info`, `curl -H "Authorization: Bearer ${token}" ${base}/overview`, `curl -X POST -H "Authorization: Bearer ${token}" -d '{"name":"myapp","dir":"D:\\\\code\\\\myapp","cmd":"node server.js","port":3000}' ${base}/programs`, `curl -X POST -H "Authorization: Bearer ${token}" ${base}/programs/myapp/move`, '```');
    return L.join('\n');
  }

  usage() {
    return { running: this.running, startedAt: this.startedAt, endpoints: this.routes.map((r) => { const s = this.stats.get(`${r.method} ${r.path}`); return { method: r.method, path: '/api/v1' + r.path, scope: r.scope, summary: r.summary, body: r.body ?? null, returns: this.ret(r), calls: s?.calls ?? 0, errors: s?.errors ?? 0, avgMs: s?.calls ? Math.round(s.totalMs / s.calls) : 0, lastAt: s?.lastAt ?? null, lastClient: s?.lastClient ?? null, bytesOut: s?.bytesOut ?? 0 }; }),
      clients: [...this.clients.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.lastAt - a.lastAt), recent: this.recent.slice(-200).reverse() };
  }

  private match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue; const a = route.path.split('/'), b = path.split('/'); if (a.length !== b.length) continue; const params: Record<string, string> = {}; let ok = true;
      for (let i = 0; i < a.length; i++) { if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]); else if (a[i] !== b[i]) { ok = false; break; } }
      if (ok) return { route, params };
    }
    return null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const a = this.api(); const t0 = Date.now(); const port = a.port; const url = new URL(req.url || '/', 'http://x');
    const send = (status: number, body: unknown, type = 'application/json') => { const s = typeof body === 'string' ? body : JSON.stringify(body); res.writeHead(status, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(s); return Buffer.byteLength(s); };
    const host = req.headers.host || ''; if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) { send(403, { error: 'bad host' }); return; }
    if (!url.pathname.startsWith('/api/v1')) { send(404, { error: 'see /api/v1/docs' }); return; }
    const path = url.pathname.slice('/api/v1'.length) || '/';
    if (path === '/docs') { send(200, this.docsHtml(port), 'text/html'); return; }
    if (path === '/openapi.json') { send(200, this.openapi(port)); return; }
    const client = String(req.headers['x-client-name'] || req.headers['user-agent'] || 'unknown').slice(0, 80);
    const m = this.match(req.method || 'GET', path); let status = 200, bytes = 0, key = `${req.method} ${path}`, rec = false, authed = false;
    if (this.inflight >= 32) { send(429, { error: 'too many requests in flight' }); return; }
    this.inflight++;
    try {
      if (!m) { status = 404; bytes = send(404, { error: 'unknown endpoint', see: '/api/v1/docs' }); return; }
      key = `${m.route.method} ${m.route.path}`; rec = true; authed = m.route.scope === 'public';
      if (m.route.scope !== 'public') {
        const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); const okTok = got.length === a.token.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(a.token));
        if (!okTok) { status = 401; bytes = send(401, { error: 'missing or wrong token: send  Authorization: Bearer <token>  (copy it from PC Bridge > API)' }); return; }
        authed = true;
        if (m.route.scope === 'control' && !a.control) { status = 403; bytes = send(403, { error: 'control endpoints are switched off in PC Bridge > API ("Allow control")' }); return; }
      }
      let body: any = undefined;
      if (req.method === 'POST') { let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e6) throw new HttpError(413, 'body too large'); } if (raw.trim()) { try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'body must be JSON'); } } }
      const out: any = await m.route.run({ params: m.params, query: url.searchParams, body }); bytes = out && typeof out === 'object' && typeof out.__text === 'string' ? send(200, out.__text, 'text/markdown') : send(200, out ?? { ok: true });
    } catch (e: any) { status = e instanceof HttpError ? e.status : 500; const why = String(e.message || e).split('\n')[0]; bytes = send(status, { error: why, status, endpoint: key || undefined }); if (status !== 404) core.log('err', `API ${req.method} ${path} -> ${status}: ${why}`); }
    finally {
      this.inflight--; if (!rec) return; // unknown paths are not recorded; clients only after the token check (both would grow without limit)
      const ms = Date.now() - t0; const s = this.stats.get(key) ?? { calls: 0, errors: 0, lastAt: 0, lastClient: '', totalMs: 0, bytesOut: 0 };
      s.calls++; if (status >= 400 && status !== 401 && status !== 403) s.errors++; /* 401/403 = refused token or control off: the API working, not failing */ s.lastAt = Date.now(); s.lastClient = client; s.totalMs += ms; s.bytesOut += bytes; this.stats.set(key, s);
      if (authed) { if (!this.clients.has(client) && this.clients.size >= 100) this.clients.delete(this.clients.keys().next().value!);
      const c = this.clients.get(client) ?? { calls: 0, lastAt: 0, lastPath: '' }; c.calls++; c.lastAt = Date.now(); c.lastPath = path; this.clients.set(client, c); }
      if (path !== '/usage') this.recent.push({ t: Date.now(), method: req.method || 'GET', path, status, ms, client }); if (this.recent.length > 400) this.recent.splice(0, 200);
    }
  }

  openapi(port: number) {
    const paths: Record<string, any> = {};
    for (const r of this.routes) { const p = '/api/v1' + r.path.replace(/:(\w+)/g, '{$1}'); paths[p] = { ...(paths[p] || {}), [r.method.toLowerCase()]: { summary: r.summary, description: r.body ? 'Body: ' + r.body : undefined, security: r.scope === 'public' ? [] : [{ bearer: [] }], 'x-scope': r.scope,
      parameters: (r.path.match(/:(\w+)/g) || []).map((x) => ({ name: x.slice(1), in: 'path', required: true, schema: { type: 'string' } })), responses: { 200: { description: 'JSON' }, 401: { description: 'token' }, 403: { description: 'control switched off' } } } }; }
    return { openapi: '3.0.3', info: { title: 'PC Bridge local API', version: this.d.version, description: 'Loopback only. Send Authorization: Bearer <token>.' }, servers: [{ url: `http://127.0.0.1:${port}` }], components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } }, paths };
  }

  docsHtml(port: number) {
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
    const rows = this.routes.map((r) => `<tr><td><code>${r.method}</code></td><td><code>/api/v1${esc(r.path)}</code></td><td>${r.scope}</td><td>${esc(r.summary)}${this.ret(r) ? `<br><small>Returns: ${esc(this.ret(r)!)}</small>` : ''}${r.body ? `<br><small>Body: <code>${esc(r.body)}</code></small>` : ''}</td></tr>`).join('');
    return `<!doctype html><meta charset="utf-8"><title>PC Bridge API</title><style>body{font:15px/1.5 system-ui;max-width:980px;margin:32px auto;padding:0 16px;background:#0b0f14;color:#e6edf3}code,pre{background:#161b22;padding:2px 6px;border-radius:6px}pre{padding:12px;overflow:auto}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #263041;padding:8px;text-align:left;vertical-align:top}a{color:#7cc4ff}</style>
<h1>PC Bridge local API</h1><p>Base URL <code>http://127.0.0.1:${port}/api/v1</code> · loopback only · every call except <code>/health</code> needs <code>Authorization: Bearer &lt;token&gt;</code> (PC Bridge → API tab). <code>control</code> endpoints work only while "Allow control" is on. Machine-readable: <a href="/api/v1/openapi.json">openapi.json</a> &middot; <a href="/api/v1/info">info</a> &middot; paste-into-an-AI page: <a href="/api/v1/guide">guide</a>.</p>
<table><tr><th>Method</th><th>Path</th><th>Scope</th><th>What it does</th></tr>${rows}</table>
<h2>Examples</h2><pre>curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:${port}/api/v1/status
curl -X POST -H "Authorization: Bearer $TOKEN" -d '{"share":80}' http://127.0.0.1:${port}/api/v1/projects/searxng/share</pre></html>`;
  }
}

class HttpError extends Error { constructor(public status: number, m: string) { super(m); } }
