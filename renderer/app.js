'use strict';
// PC Bridge UI. Screens are plain functions that build DOM into #main; live data arrives over SSE (status / fwd / log / projects).
const VIEWS = [['overview', 'Overview'], ['containers', 'Containers'], ['ports', 'Ports'], ['sites', 'Move and split'], ['programs', 'Programs'], ['apps', 'Apps'], ['envs', 'Global envs'], ['forwards', 'Forwards'], ['api', 'API'], ['log', 'Log'], ['setup', 'Setup']];
const NAV_TIP = { overview: 'Both PCs side by side, and your containers with a button to move each one to another PC', containers: 'Every container on this PC: where it runs and the Move button', ports: 'Every listening port on this PC and what uses it', programs: 'Move any program (Node, Python...) to another PC; it is copied to that PC\'s non-C drive and its port is forwarded', apps: 'Group several programs/containers (frontend, backend...) into one app and send the whole thing to another PC with one button; share it as a file', envs: 'Every .env file on this PC and your other PCs in one place, grouped by folder: search, show, copy', sites: 'Sites already moved: share the load (80/20...), bring back, test', forwards: 'Make a port of a connected PC appear on this PC', api: 'Let other programs (AI agents, scripts) use PC Bridge', log: 'Every command PC Bridge ran', setup: 'Connect another PC, backup address, start with Windows, quit' };
// ---- clickable addresses (link / portLinks / dockerPorts are in ui.js) ----
const pageLinks = (port, pages) => (pages || []).map((g) => link(port, g, g, { class: 'plink pg' }));
/** Ports of containers on the OTHER PC: localhost when this PC forwards that port, otherwise the other PC's own address. */
const remotePortLinks = (text) => {
  const ps = dockerPorts(text); if (!ps.length) return text || '-';
  const fwd = (pt) => (cfg.projects || []).some((p) => (p.ports || []).includes(pt) && p.mode && p.mode !== 'local') || (cfg.programs || []).some((p) => p.port === pt && p.mode === 'remote') || (cfg.forwards || []).some((f) => f.localPort === pt);
  return el('span', {}, ...ps.flatMap((pt, i) => [i ? ', ' : null, fwd(pt) ? link(pt) : el('a', { class: 'plink', href: 'http://' + remote().host + ':' + pt + '/', target: '_blank', rel: 'noopener', title: 'Open on ' + remote().name + ' directly (this port is not forwarded to this PC)' }, String(pt))]));
};
/** Ask for the extra pages (paths on the port) of a program or project and save them. */
async function editPages(kind, name, cur, after) {
  const v = prompt('Extra pages of ' + name + ' to open, as paths separated by spaces (example: /docs/try.html /health). Leave empty to clear.', (cur || []).join(' '));
  if (v === null) return;
  const r = await call('pages:set', kind, name, v.split(/[\s,]+/).filter(Boolean)); if (r) { toast('Saved'); await reloadCfg(); after(); }
}
const ICON_OF = { overview: 'overview', containers: 'containers', ports: 'ports', sites: 'split', programs: 'programs', apps: 'apps', envs: 'envs', forwards: 'forwards', api: 'api', log: 'log', setup: 'setup' };
const V = {};
let cfg = null, status = null, fwdState = [], cfgFile = '', cur = 'overview', openAtLogin = false, timers = [], ovDraw = null, fwdPaint = null, logAppend = null;
const hist = { local: { cpu: [], ram: [] }, remote: { cpu: [], ram: [] } };
const logLines = [];
const remote = () => cfg.remotes[cfg.activeRemote];
const online = () => !!status?.ssh?.ok;
const push = (a, v) => { a.push(v); if (a.length > 60) a.shift(); };
const every = (ms, fn) => { const t = setInterval(fn, ms); timers.push(t); return t; };
const clearTimers = () => { timers.forEach(clearInterval); timers = []; };
const copyText = (text) => navigator.clipboard?.writeText(text).then(() => toast('Copied'));

// ---------- rail, status bar ----------
function buildRail() {
  const nav = $('#nav'); nav.replaceChildren();
  for (const [id, label] of VIEWS) nav.append(el('button', { type: 'button', data: { v: id }, onclick: () => show(id), title: NAV_TIP[id] || label }, icon(ICON_OF[id]), el('span', {}, label)));
}
function paintRail() {
  const s = status; const stale = s && Date.now() - s.ts > 15000; const ok = online() && !stale;
  $('#link-state').replaceChildren(mark(!s ? 'unk' : stale ? 'warn' : ok ? 'ok' : 'bad', !s ? 'CHECKING' : stale ? 'STALE' : ok ? 'OK' : 'DOWN'));
  $('#link-lat').textContent = s?.ssh?.latencyMs != null ? s.ssh.latencyMs + ' ms' : '';
  $('#link-names').textContent = 'THIS -- ' + (cfg ? remote().name.toLowerCase() : 'remote');
  $('#bar-upd').textContent = s ? 'updated ' + new Date(s.ts).toLocaleTimeString() : 'waiting for first poll';
  $('#bar-poll').textContent = s?.route && !s.route.primary ? 'via backup address ' + s.route.host : '';
  document.title = (ok ? '' : '(down) ') + 'PC Bridge';
}
$('#bar-test').onclick = (e) => act(e.currentTarget, async () => {
  const p = $('#testpanel'); p.classList.remove('hidden');
  p.replaceChildren(el('div', { class: 'hd' }, el('strong', {}, 'Testing everything'), el('span', { class: 'muted' }, 'connection, remote Docker, forwards, sites, ports...')));
  const r = await window.api.call('test:all');
  p.replaceChildren(el('div', { class: 'hd' }, el('strong', {}, 'Test results'), el('button', { class: 'btn', type: 'button', text: 'Close', onclick: () => p.classList.add('hidden') })), r.ok ? resultRows(r.data) : resultRows([{ name: 'test:all', ok: false, detail: r.error, ms: 0 }]));
});

function show(id) {
  clearTimers(); cur = id; ovDraw = null; fwdPaint = null; logAppend = null;
  document.querySelectorAll('#nav button').forEach((b) => (b.dataset.v === id ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  const m = $('#main'); m.replaceChildren(); m.scrollTop = 0;
  const pane = el('section', { class: 'pane', id: 'v-' + id }); m.append(pane); (V[id] || V.overview)(pane);
}

// ---------- OVERVIEW ----------
function metricCol(title, host, x, h) {
  const col = el('div', { class: 'col' }, el('h2', {}, el('span', {}, title), el('span', { class: 'mono' }, host || '')));
  if (!x) { col.append(el('div', { class: 'empty' }, 'no data')); return col; }
  col.append(el('div', { class: 'm' }, el('span', { class: 'k' }, 'CPU'), bar(x.cpu), spark(h.cpu), el('span', { class: 'v' }, x.cpu + ' %')));
  col.append(el('div', { class: 'm' }, el('span', { class: 'k' }, 'RAM'), bar(pctOf(x.ramUsedMB, x.ramTotalMB)), spark(h.ram), el('span', { class: 'v' }, `${(x.ramUsedMB / 1024).toFixed(1)} / ${(x.ramTotalMB / 1024).toFixed(1)} GB`)));
  if (x.nvidia) { const [n, u, mu, mt] = x.nvidia.split(';')[0].split(',').map((t) => t.trim()); col.append(el('div', { class: 'm' }, el('span', { class: 'k' }, 'GPU'), bar(+u), el('span', { class: 'muted mono gname3', title: n }, n), el('span', { class: 'v' }, u + ' %')), el('div', { class: 'm' }, el('span', { class: 'k' }, 'VRAM'), bar(pctOf(+mu, +mt)), el('span', {}), el('span', { class: 'v' }, `${(mu / 1024).toFixed(1)} / ${(mt / 1024).toFixed(1)} GB`))); }
  else col.append(el('div', { class: 'm' }, el('span', { class: 'k' }, 'GPU'), el('span', { class: 'muted' }, 'no NVIDIA'), el('span', { class: 'muted mono gname', title: (x.gpuNames || []).join(', ') }, (x.gpuNames || []).join(', '))));
  for (const d of x.disks.filter((q) => q.totalGB > 0)) col.append(el('div', { class: 'drive' }, el('span', { class: 'k' }, d.id), bar(100 - pctOf(d.freeGB, d.totalGB)), el('span', { class: 'v' }, `${d.freeGB} GB free of ${d.totalGB}`)));
  return col;
}
V.overview = (p) => {
  const bannerBox = el('div'), colsBox = el('div', { class: 'cols' }), linkLine = el('div', { class: 'row mono' }), lr = el('div'), dockerLine = el('span', { class: 'muted' }), tableBox = el('div'), out = el('pre', { class: 'blk hidden' });
  const needOnline = [], movBox = el('div'); const reloadMov = () => loadContainers(movBox, reloadMov);
  const ob = (label, fn) => { const b = btn(label, fn); needOnline.push(b); return b; };
  const ctxBtn = btn('', async () => { await call(status?.contextIsRemote ? 'ctx:local' : 'ctx:remote'); }); needOnline.push(ctxBtn);
  p.append(el('h1', {}, 'Overview'), el('p', { class: 'sub' }, 'Both PCs side by side, read across. Updates every 3 seconds.'), bannerBox, colsBox,
    section('Your containers: move to another PC', btn('Refresh', reloadMov, '', { title: 'Read the container list again.' })), movBox, section('Link', testBtn('Test connection', 'test:connection', [], lr)), linkLine, lr,
    section('Docker on ' + (cfg ? remote().name : 'the connected PC'), ob('Wake', async () => { const r = await call('wake'); if (r) toast('Docker engine ' + r.data + ' is up'); }), ctxBtn, ob('Open shell', async () => { const r = await call('shell:open'); if (r) toast('Opened ' + r.data); })),
    el('div', { class: 'row' }, sw('keep awake', !!cfg?.keepAwake, async (v) => { const r = await call('keepawake', v); if (!r) return false; cfg.keepAwake = v; }), dockerLine), tableBox, out);
  ovDraw = () => {
    const s = status;
    // the link came up (or went down) after the container table was drawn: its "runs on" / Move state is stale
    if (s && movBox._on !== undefined && movBox._on !== online()) reloadMov();
    needOnline.forEach((b) => (b.disabled = !online()));
    ctxBtn.textContent = s?.contextIsRemote ? 'Point docker CLI back at this PC' : `Point docker CLI at ${remote().name}`;
    ctxBtn.title = s?.contextIsRemote ? 'Make the "docker" command in your terminals use this PC again.' : `Make the "docker" command in your terminals talk to ${remote().name}.`;
    bannerBox.replaceChildren(s && !s.ssh.ok ? el('div', { class: 'banner' }, el('h2', {}, s.ssh.headline || (remote().name + ' is not reachable')), el('div', { class: 'mono' }, s.ssh.error || ''), s.ssh.checklist?.length ? el('ol', {}, s.ssh.checklist.map((c) => el('li', {}, c))) : null) : '');
    colsBox.replaceChildren(metricCol('This PC', s?.local?.host, s?.local, hist.local), metricCol(cfg ? remote().name : 'Other PC', s?.metrics?.host || '', s?.metrics, hist.remote));
    const rt = s?.route; linkLine.replaceChildren(mark(online() ? 'ok' : 'bad', online() ? 'OK' : 'DOWN'), `ssh ${s?.ssh?.latencyMs ?? '-'} ms`, el('span', { class: 'muted' }, `tailscale ${s?.tailscale?.state ?? '?'}`), el('span', { class: 'muted' }, rt ? 'address ' + rt.host + (rt.primary ? '' : ' (backup)') : ''), el('span', { class: 'muted' }, 'docker context ' + (s?.context ?? '?')));
    const d = s?.docker; dockerLine.textContent = !online() ? 'remote unreachable' : !d ? '' : !d.wslRunning ? 'WSL is idle: containers are stopped until it wakes' : !d.daemonUp ? 'daemon not answering: ' + (d.error || '') : `daemon up, ${d.containers.filter((c) => c.state === 'running').length} of ${d.containers.length} running`;
    const rows = (d?.containers || []).map((c) => el('tr', {}, el('td', {}, c.name), el('td', { class: 'mono' }, c.image), el('td', {}, mark(c.state === 'running' ? 'ok' : 'unk', c.state)), el('td', { class: 'n' }, c.cpu), el('td', { class: 'n' }, c.mem), el('td', { class: 'mono', title: c.ports || '' }, remotePortLinks(c.ports)),
      el('td', { class: 'act' }, el('div', { class: 'acts' }, ...['start', 'stop', 'restart', 'logs'].map((a) => btn(a, async () => { const r = await call('container', c.name, a); if (r) { out.textContent = r.data || '(no output)'; out.classList.toggle('hidden', a !== 'logs'); if (a !== 'logs') toast(a + ' ' + c.name); } }, '', { disabled: !online() || (a === 'start' && c.state === 'running') || ((a === 'stop' || a === 'restart') && c.state !== 'running'), title: c.state === 'running' ? ({ start: 'Already running', stop: `Stop ${c.name} on ${remote().name}`, restart: `Restart ${c.name} on ${remote().name}`, logs: 'Show the last log lines' })[a] : ({ start: `Start ${c.name} on ${remote().name}`, stop: 'Not running', restart: 'Not running', logs: 'Show the last log lines' })[a] }))))));
    tableBox.replaceChildren(el('table', {}, el('thead', {}, el('tr', {}, ...['Container', 'Image', 'State', 'CPU', 'Memory', 'Ports', ''].map((h, i) => el('th', { class: i === 3 || i === 4 ? 'n' : '' }, h)))), el('tbody', {}, rows.length ? rows : el('tr', {}, el('td', { colSpan: 7, class: 'empty' }, online() ? 'no containers' : '-')))));
  };
  ovDraw(); reloadMov();
};

// ---------- CONTAINERS (this PC) ----------
/** One table used on Overview and Containers: where each container runs (read live from the PCs), whether the target PC has a copy, and the one button that matters. Works with any number of PCs. */
function containerTable(list, reload) {
  const multi = cfg.remotes.length > 1;
  const rows = list.map((c) => {
    const pc = c.pc || remote().name, away = c.offloaded, split = c.mode === 'split';
    // "Running right now on" is what is actually running (read from the PCs), not what the settings say
    const here = c.state === 'running', there = !!c.remoteRunning, st = !online() && !here && !away ? 'unknown' : here && there ? 'both' : there ? 'remote' : here ? 'here' : 'none';
    const WHERE = { remote: [`ONLY ON ${pc}`, 'w-ok', `Running on ${pc} and NOT on this PC. localhost on this PC is forwarded there.`], here: ['ONLY ON THIS PC', '', 'Running on this PC only.'], both: [split ? `BOTH (${100 - c.share}% this PC / ${c.share}% ${pc})` : 'BOTH PCs (should be one)', split ? 'w-ok' : 'w-warn', split ? 'Both PCs run it and share the traffic.' : 'It runs on both PCs right now. PC Bridge stops the copy on this PC within about 30 seconds.'], none: ['NOT RUNNING', 'muted', 'Not running on any PC.'], unknown: [`unknown (${pc} unreachable)`, 'muted', `${pc} is not reachable, so only this PC can be checked.`] }[st];
    const where = el('span', { class: WHERE[1], title: WHERE[2] }, WHERE[0]);
    const copy = c.twin ? el('span', { class: there ? 'w-ok' : 'muted', title: `The container exists on ${pc}.` }, there ? 'yes, running' : 'yes, stopped') : el('span', { class: 'muted', title: `Nothing on ${pc} yet. Moving copies its config and data there.` }, 'no');
    let act;
    if (away) {
      const pct = el('input', { class: 'input w1', type: 'number', min: 0, max: 100, value: c.share, title: `Percent of connections ${pc} serves. 100 = all, 0 = all on this PC.`, 'aria-label': 'percent on the other PC' });
      act = el('div', { class: 'acts' }, pct, el('span', { class: 'muted' }, '% on ' + pc),
        btn('Apply', async () => { const m = await call('proj:share', c.project, Math.round(+pct.value)); if (m) { toast(m.data); await reloadCfg(); reload(); } }, '', { title: 'Change how the load is shared between this PC and ' + pc + ', without restarting anything.' }),
        btn('Bring back', async () => { if (await call('proj:home', c.project)) { toast(c.name + ' is back on this PC'); await reloadCfg(); reload(); } }, '', { title: `Run it on this PC again and stop using the copy on ${pc}. It stays here until you move it again.` }));
    } else if (!c.ports.length) act = el('span', { class: 'muted', title: 'Only containers that publish a port to this PC can be forwarded. Services that only talk inside their compose network have nothing to forward.' }, 'cannot move: no published port');
    else if (st === 'remote') act = el('span', { class: 'muted', title: `It already runs on ${pc} without being managed by PC Bridge here, so there is nothing to move.` }, `already on ${pc}`);
    else {
      const sel = multi ? el('select', { class: 'input', title: 'Which PC should run it', 'aria-label': 'target PC' }, ...cfg.remotes.map((r) => el('option', { value: r.name, selected: r.name === pc }, r.name))) : null;
      const target = () => (sel ? sel.value : remote().name);
      const pct = el('input', { class: 'input w1', type: 'number', min: 1, max: 100, value: 100, title: 'Percent of connections for the target PC. 100 = move everything. Less = both PCs run it (e.g. 80 = 80/20).', 'aria-label': 'percent on the target PC' });
      const go = btn('Move to ' + target(), async () => { const m = await call('containers:offload', c.name, Math.round(+pct.value), target()); if (m) { toast(m.data); await reloadCfg(); reload(); } }, 'primary', { disabled: !online(), title: online() ? `Copies this container to ${target()}, starts it there and forwards localhost:${c.ports.join(',')} to it. Nothing is deleted here.` : `${target()} is not reachable.` });
      if (sel) sel.onchange = () => { go.textContent = 'Move to ' + target(); };
      act = el('div', { class: 'acts' }, sel, pct, el('span', { class: 'muted' }, '% there'), go);
    }
    return el('tr', {}, el('td', {}, c.name, c.composeProject ? el('span', { class: 'tag', title: 'Part of the compose project ' + c.composeProject }, c.composeProject) : null), el('td', {}, where), el('td', {}, copy), el('td', { class: 'mono' }, portLinks(c.ports)), el('td', { class: 'act' }, act));
  });
  return el('table', {}, el('thead', {}, el('tr', {}, ['Container', 'Running right now on', multi ? 'Copy on the target PC' : 'Copy on ' + remote().name, 'Port', 'Move'].map((h) => el('th', {}, h)))), el('tbody', {}, rows.length ? rows : el('tr', {}, el('td', { colSpan: 5, class: 'empty' }, 'no containers'))));
}
async function loadContainers(box, reload) {
  box.replaceChildren(el('div', { class: 'empty' }, 'reading Docker on this PC…')); const r = await window.api.call('containers:list');
  box._on = online(); box.replaceChildren(r.ok ? containerTable(r.data, reload) : el('div', { class: 'empty' }, r.error));
}
V.containers = (p) => {
  const body = el('div'); const load = () => loadContainers(body, load); every(3000, () => { if (status && body._on !== undefined && body._on !== online()) load(); });
  p.append(el('h1', {}, 'Containers on this PC'), el('p', { class: 'sub' }, 'To run a container on another PC, press "Move to <PC name>" on its row (with several PCs, pick the PC first). PC Bridge copies its config and data there, starts it, and forwards the same localhost port, so nothing else has to change. "Running right now on" is read live from the PCs; "Bring back" undoes a move.'), section('Local Docker', btn('Refresh', async () => { await load(); }, '', { title: 'Read the container list again.' })), body);
  load();
};

// ---------- PROGRAMS (anything that is not a container) ----------
V.programs = (p) => {
  const body = el('div'), res = el('div'), form = el('div', { class: 'row' });
  const f = { name: el('input', { class: 'input w2', placeholder: 'name, e.g. camofox', title: 'Short name (letters, digits, - _).' }), dir: el('input', { class: 'input w3', placeholder: 'folder, e.g. D:\\apps\\myapp', title: 'Full path of the program folder on this PC. Everything in it is copied (node_modules and .git are skipped).' }), cmd: el('input', { class: 'input w3', placeholder: 'start command, e.g. node server.js', title: 'The command that starts it, run inside the folder.' }), port: el('input', { class: 'input w1', type: 'number', placeholder: 'port', title: 'The port it listens on. Same number here and on the other PC.' }), needs: el('input', { class: 'input w2', placeholder: 'needs from this PC (ports)', 'aria-label': 'ports of services that stay on this PC', title: 'Optional. Ports of things that must stay on THIS PC, e.g. 1234 for LM Studio. Separate with commas. While the program runs on another PC it can still reach them on localhost.' }) };
  form.append(f.name, f.dir, f.cmd, f.port, f.needs, btn('Add program', async () => { if (!f.name.value.trim() || !f.dir.value.trim() || !f.cmd.value.trim() || !f.port.value) { toast('Fill in the name, folder, start command and port first'); return; } const r = await call('programs:add', { name: f.name.value.trim(), dir: f.dir.value.trim(), cmd: f.cmd.value.trim(), port: +f.port.value, needs: f.needs.value.split(/[,\s]+/).filter(Boolean).map(Number) }); if (r) { toast('Added'); Object.values(f).forEach((i) => (i.value = '')); await reloadCfg(); load(); } }, 'primary', { title: 'Only registers it. Nothing is copied or stopped until you press Move.' }));
  const showUpdates = (r) => res.replaceChildren(r.ok ? resultRows(r.data.map((u) => ({ name: u.name + (u.current ? ' ' + u.current : '') + (u.latest && u.latest !== u.current ? ' -> ' + u.latest : ''), ok: u.state !== 'failed', warn: u.state === 'outdated' || u.state === 'info', detail: u.state + (u.detail ? ': ' + u.detail : ''), ms: 0 }))) : resultRows([{ name: 'update', ok: false, detail: r.error, ms: 0 }]));
  async function load() {
    const r = await window.api.call('programs:list'); if (!r.ok) { body.replaceChildren(el('div', { class: 'empty' }, r.error)); return; }
    const rows = r.data.map((g) => {
      const away = g.mode === 'remote'; const live = away ? (g.live ? (g.live.supervisor && g.live.portUp ? mark('ok', 'RUNNING ON ' + g.pc) : mark('bad', 'moved to ' + g.pc + ', but not answering')) : mark('unk', g.pc + ' unreachable')) : g.holder ? mark('ok', 'running on THIS PC') : mark('unk', 'not running');
      const sel = !away && cfg.remotes.length > 1 ? el('select', { class: 'input', 'aria-label': 'target PC', title: 'Which PC should run it' }, ...cfg.remotes.map((r) => el('option', { value: r.name, selected: r.name === g.pc }, r.name))) : null; const tgt = () => (sel ? sel.value : g.pc);
      const act = away ? el('div', { class: 'acts' }, btn('Bring back', async () => { const m = await call('programs:home', g.name); if (m) { toast(m.data); await reloadCfg(); load(); } }, '', { title: 'Stop the copy on ' + g.pc + ' and start it here again from its folder.' }), btn('Log', async () => { const m = await call('programs:logs', g.name); if (m) res.replaceChildren(el('pre', { class: 'blk' }, m.data)); }, '', { title: 'Last lines the program printed on ' + g.pc + '.' }), btn('Push changes', async () => { const m = await call('programs:push', g.name); if (m) toast(m.data); }, '', { title: 'Send the files you changed in the folder on this PC to ' + g.pc + ' (no full copy, no restart).' }))
        : el('div', { class: 'acts' }, sel, btn('Move to ' + tgt(), async () => {
          if (g.holder && !confirm(`Port ${g.port} is used by process ${g.holder} on this PC. To move the program, PC Bridge must stop that process (it is not restarted automatically). Continue?`)) return;
          const m = await call('programs:move', g.name, g.holder || undefined, tgt()); if (m) { toast(m.data); await reloadCfg(); load(); }
        }, 'primary', { disabled: !online(), title: 'Copies the folder to ' + tgt() + ' (its non-C drive), installs the libraries there, starts it under a restarting supervisor and forwards localhost:' + g.port + '.' }), btn('Remove', async () => { if (await call('programs:remove', g.name)) { await reloadCfg(); load(); } }, '', { title: 'Forget this entry (files are not deleted).' }));
      const open = (txt) => el('a', { href: 'http://localhost:' + g.port + '/', target: '_blank', rel: 'noopener', title: 'Open http://localhost:' + g.port + ' in the browser' }, txt);   // localhost:port reaches the program wherever it runs
      return el('tr', {}, el('td', {}, open(g.name)), el('td', {}, live), el('td', { class: 'mono', title: g.dir }, g.cmd), el('td', { class: 'mono' }, open(g.port), ...pageLinks(g.port, g.pages).flatMap((a) => [' ', a]), ' ', btn('Pages', () => editPages('program', g.name, g.pages, load), '', { title: 'Add the pages of ' + g.name + ' you open often (like /docs/try.html) as links.' })), el('td', { class: 'act' }, act, testBtn('Test', 'test:program', [g.name], res)));
    });
    body.replaceChildren(el('table', {}, el('thead', {}, el('tr', {}, ['Program', 'Running right now on', 'Command', 'Open', ''].map((h) => el('th', {}, h)))), el('tbody', {}, rows.length ? rows : el('tr', {}, el('td', { colSpan: 5, class: 'empty' }, 'no programs yet: add one below')))));
  }
  p.append(el('h1', {}, 'Programs'), el('p', { class: 'sub' }, 'For anything that is not a Docker container (a Node or Python server, a browser service...). PC Bridge copies the folder to another PC, runs it there with automatic restarts, and forwards the same localhost port. Everything it puts on a PC goes under ' + (cfg?.remoteRoot || 'E:\\PCBridge') + ' (never C:).'),
    section('Programs', btn(cfg.remotes.length > 1 ? 'Prepare all PCs' : 'Prepare ' + remote().name, async () => { const all = []; for (const r of cfg.remotes) { const x = await call('programs:prepare', r.name); if (x) all.push(...x.data.map((l) => ({ name: (cfg.remotes.length > 1 ? '[' + r.name + '] ' : '') + l.replace(/^ok /, ''), ok: true, detail: '', ms: 0 }))); } res.replaceChildren(resultRows(all)); }, '', { disabled: !online(), title: 'Creates the PC Bridge folder on each PC\'s non-C drive and unpacks portable Node there (checksum checked). No installer, nothing on C:.' }), btn('Check updates', async () => { res.replaceChildren(el('div', { class: 'muted' }, 'checking the PCs…')); const r = await window.api.call('programs:update', false); showUpdates(r); }, '', { disabled: !online(), title: 'Shows what is outdated on the PCs that run your programs (Node, uv, libraries, Linux packages). Changes nothing.' }), btn('Update everything', async () => { if (!confirm('Update Node, uv and the libraries of every moved program on the PCs that run them, then restart those programs?')) return; res.replaceChildren(el('div', { class: 'muted' }, 'updating… this can take a few minutes')); const r = await window.api.call('programs:update', true); showUpdates(r); await reloadCfg(); load(); }, 'primary', { disabled: !online(), title: 'Updates portable Node (same major, checksum checked), uv and each program\'s libraries, then restarts the programs.' }), sw('update weekly', !!cfg?.autoUpdate, async (v) => { const r = await call('programs:autoupdate', v); if (!r) return false; cfg.autoUpdate = v; }), btn('Refresh', load)), body, res, section('Add a program'), form);
  load();
};

// ---------- APPS (a group of programs / containers moved as one) ----------
V.apps = (p) => {
  const body = el('div'), res = el('div'), editor = el('div'), share = el('div'); let containers = null;
  const pcs = () => cfg.remotes.map((r) => r.name); const pcName = (v) => (v === '@here' ? 'this PC' : v);
  const targetSel = (cur, defLabel) => el('select', { class: 'input', 'aria-label': 'PC' }, el('option', { value: '' }, defLabel), el('option', { value: '@here', selected: cur === '@here' }, 'this PC'), ...pcs().map((n) => el('option', { value: n, selected: cur === n }, n)));
  const showPlan = (rows) => res.replaceChildren(resultRows(rows.map((r) => ({ name: `${r.name} (${r.kind}): ${r.from} → ${r.to}`, ok: !r.blocker, warn: r.action === 'already', detail: (r.blocker || (r.action === 'already' ? 'already there' : r.action === 'home' ? 'will come back to this PC' : 'will be moved')) + (r.shared ? ` (shared: also used by ${r.shared.join(', ')}; it runs in one place for all of them)` : ''), ms: 0 }))));
  const showLines = (lines) => res.replaceChildren(resultRows(lines.map((l) => ({ name: l, ok: true, detail: '', ms: 0 }))));
  // live progress of a long move: every 1.5 s read the service log ("[program x] 3/5 ...") and show a bar per program, the elapsed time and how long ago the last news came
  function track(label) {
    const t0 = Date.now(); const box = el('div', { class: 'blk' }); res.replaceChildren(box);
    const draw = async () => {
      const r = await window.api.call('logs:all'); if (!r.ok) return;
      const cur = {}; let last = t0;
      for (const e of r.data) { if (e.t < t0 - 1000) continue; const m = /^\[program ([^\]]+)\] (\d)\/5 (.*)/.exec(e.msg); if (m) { cur[m[1]] = { i: +m[2], text: m[3] }; last = Math.max(last, e.t); } else if (/^\[program [^\]]+\] copy (finished|failed)/.test(e.msg)) last = Math.max(last, e.t); }
      const ago = Math.round((Date.now() - last) / 1000);
      box.replaceChildren(el('div', {}, `${label} - running for ${Math.round((Date.now() - t0) / 1000)} s, last news ${ago} s ago` + (ago > 90 ? ' (a big copy is silent for minutes: it is still working unless the top-left status says offline)' : '')),
        ...Object.entries(cur).map(([n, s]) => el('div', { class: 'mono' }, `${n}  ${'█'.repeat(s.i - 1)}${'░'.repeat(6 - s.i)} ${(s.i - 1) * 20}%  step ${s.i}/5: ${s.text.slice(0, 70)}`)));
    };
    draw(); const id = setInterval(draw, 1500); return () => clearInterval(id);
  }
  async function send(a, target) {
    const pl = await call('apps:plan', a.name, target || undefined); if (!pl) return; showPlan(pl.data); const blocked = pl.data.filter((r) => r.blocker);
    const todo = pl.data.filter((r) => r.action !== 'already'); if (!todo.length) { toast('Nothing to do: every part is already there'); return; }
    if (!confirm(`Move "${a.name}"?\n\n` + todo.map((r) => `• ${r.name}: ${r.from} → ${r.to}` + (r.shared ? ` (also used by ${r.shared.join(', ')})` : '')).join('\n') + (blocked.length ? '\n\nTo do this PC Bridge must STOP:\n' + blocked.map((r) => '• ' + r.blocker).join('\n') + '\n(they are not restarted automatically)' : '') + '\n\nIf one part fails, the parts already moved are put back.')) return;
    const stop = track('Moving ' + a.name); let r; try { r = await window.api.call('apps:send', a.name, target || undefined, blocked.length > 0); } finally { stop(); }
    if (r.ok) showLines(r.data); else res.replaceChildren(resultRows([{ name: 'move', ok: false, detail: r.error, ms: 0 }])); await reloadCfg(); load();
  }
  async function home(a) { if (!confirm(`Bring every part of "${a.name}" back to this PC?`)) return; const stop = track('Bringing ' + a.name + ' back'); let r; try { r = await window.api.call('apps:home', a.name); } finally { stop(); } if (r.ok) showLines(r.data); else res.replaceChildren(resultRows([{ name: 'bring back', ok: false, detail: r.error, ms: 0 }])); await reloadCfg(); load(); }
  async function exportIt(a) {
    const r = await call('apps:export', a.name, false); if (!r) return; const text = JSON.stringify(r.data, null, 2);
    share.replaceChildren(section('Share "' + a.name + '"', btn('Copy', async () => copyText(text), 'primary', { title: 'Copy the file text.' }), btn('Save as file', () => { const u = URL.createObjectURL(new Blob([text], { type: 'application/json' })); const l = el('a', { href: u, download: a.name + '.pcbapp.json' }); document.body.append(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(u), 2000); }, '', { title: 'Download ' + a.name + '.pcbapp.json' })),
      el('p', { class: 'muted' }, 'This file lists the parts, commands and ports. Secret environment values are left out, and the code itself is not inside: copy the program folders yourself, or keep them in git. On the other PC choose Import below.'), el('pre', { class: 'blk' }, text));
  }
  function edit(a) {
    const isNew = !a; const d = a ? JSON.parse(JSON.stringify(a)) : { name: '', note: '', members: [] }; const orig = a ? a.name : undefined;
    const name = el('input', { class: 'input w2', value: d.name, placeholder: 'app name, e.g. shop', title: 'Letters, digits, - and _.' }), note = el('input', { class: 'input w3', value: d.note || '', placeholder: 'note (optional)' }), dflt = targetSel(d.target, 'default: ' + remote().name);
    const rows = el('div'); const names = el('datalist', { id: 'app-names' }); const paintNames = () => names.replaceChildren(...[...(cfg.programs || []).map((x) => x.name), ...(containers || [])].map((n) => el('option', { value: n })));
    const addRow = (m) => {
      const kind = el('select', { class: 'input', 'aria-label': 'kind', title: 'program = something added on the Programs screen; container = a Docker container on this PC' }, el('option', { value: 'program', selected: m.kind === 'program' }, 'program'), el('option', { value: 'container', selected: m.kind === 'container' }, 'container'));
      const nm = el('input', { class: 'input w2', value: m.name || '', placeholder: 'name', 'aria-label': 'member name' }), tg = targetSel(m.target, 'same as the app'); nm.setAttribute('list', 'app-names');
      const row = el('div', { class: 'row' }, kind, nm, tg, btn('Remove', () => row.remove(), '', { title: 'Take this part out of the app' }));
      row._get = () => ({ kind: kind.value, name: nm.value.trim(), ...(tg.value ? { target: tg.value } : {}), ...(m.project ? { project: m.project } : {}), ...(m.ports && m.ports.length ? { ports: m.ports } : {}) }); rows.append(row);
    };
    d.members.forEach(addRow); if (!d.members.length) addRow({ kind: 'program' }); paintNames();
    if (!containers) window.api.call('containers:list').then((r) => { containers = r.ok ? r.data.map((c) => c.name) : []; paintNames(); });
    editor.replaceChildren(section(isNew ? 'New app' : 'Edit "' + orig + '"'), el('div', { class: 'row' }, name, note, el('span', { class: 'muted' }, 'default PC'), dflt), el('p', { class: 'muted' }, 'Parts are moved in this order. A part can have its own PC (even "this PC" to keep it here): they still reach each other on localhost.'), rows, names,
      el('div', { class: 'row' }, btn('Add a part', () => addRow({ kind: 'program' }), '', { title: 'Another program or container in this app' }), btn('Save', async () => { const r = await call('apps:save', { name: name.value.trim(), note: note.value.trim(), target: dflt.value || undefined, members: [...rows.children].map((x) => x._get()) }, orig); if (r) { toast('Saved'); editor.replaceChildren(); await reloadCfg(); load(); } }, 'primary'), btn('Cancel', () => editor.replaceChildren())));
    if (editor.scrollIntoView) editor.scrollIntoView({ block: 'nearest' });
  }
  // every address in one place: each program / container / forward with its port and saved pages, where it runs, and which app it is in
  const hub = el('div');
  async function loadLinks() {
    const r = await window.api.call('links:list'); if (!r.ok) { hub.replaceChildren(el('div', { class: 'empty' }, r.error)); return; }
    const rows = r.data.map((x) => el('tr', {}, el('td', {}, el('b', {}, x.name), ' ', el('span', { class: 'tag' }, x.kind)), el('td', {}, x.pc === 'this PC' ? mark('unk', 'this PC') : mark('ok', x.pc)), el('td', {}, x.apps.join(', ') || '-'),
      el('td', {}, el('span', { class: 'lnk' }, ...x.links.map((l, i) => el('a', { class: 'plink' + (i ? ' pg' : ''), href: l.url, target: '_blank', rel: 'noopener', title: 'Open ' + l.url }, l.label))))));
    hub.replaceChildren(el('table', {}, el('thead', {}, el('tr', {}, ['Name', 'Runs on', 'In app', 'Open (click)'].map((h) => el('th', {}, h)))), el('tbody', {}, rows.length ? rows : el('tr', {}, el('td', { colSpan: 4, class: 'empty' }, 'nothing registered yet')))));
  }
  async function load() {
    loadLinks();
    const r = await window.api.call('apps:list'); if (!r.ok) { body.replaceChildren(el('div', { class: 'empty' }, r.error)); return; }
    const rows = r.data.map((a) => {
      const sel = targetSel('', 'default'); sel.options[0].textContent = 'default: ' + (a.target ? pcName(a.target) : remote().name);
      const pin = (m) => { const s = targetSel(m.target, 'goes with the app'); s.title = 'Where "' + m.name + '" goes when you press Send all. "this PC" keeps it here while the rest moves.'; s.setAttribute('aria-label', 'PC for ' + m.name); s.onchange = async () => { const d2 = { name: a.name, note: a.note, target: a.target, members: a.members.map((x) => ({ kind: x.kind, name: x.name, target: x.name === m.name && x.kind === m.kind ? s.value || undefined : x.target, project: x.project, ports: x.ports })) }; if (await call('apps:save', d2, a.name)) { toast('Saved: ' + m.name + ' goes ' + (s.value ? 'to ' + pcName(s.value) : 'with the app')); await reloadCfg(); load(); } }; return s; };
      const chips = el('div', { class: 'acts', style: 'margin-bottom:8px' }, ...a.members.map((m) => el('span', { class: 'row' }, pin(m), el('span', { class: 'tag', title: `${m.kind} ${m.name} runs on ${m.pc}` + (m.sharedWith && m.sharedWith.length ? `; shared with ${m.sharedWith.join(', ')}` : '') + (m.ports.length ? ', port ' + m.ports.join(', ') : '') + (m.up === false ? ' (that PC does not answer)' : '') }, `${m.name} · ${m.pc}${m.sharedWith && m.sharedWith.length ? ' · shared' : ''}${m.up === false ? ' ✗' : ''}`),
        el('span', { class: 'lnk' }, ...(m.ports || []).flatMap((pt) => [link(pt, ':' + pt), ' ']), ...pageLinks((m.ports || [])[0], m.pages).flatMap((x) => [x, ' ']),
          (m.ports || []).length ? btn('Pages', () => editPages(m.kind === 'program' ? 'program' : 'project', m.kind === 'program' ? m.name : m.project || m.name, m.pages, load), '', { title: 'Add pages of ' + m.name + ' you open often (like /docs/try.html) as links.' }) : null))));
      const w = a.where === 'this PC' ? mark('unk', 'on THIS PC') : a.where.startsWith('split') ? mark('warn', a.where) : mark('ok', 'on ' + a.where);
      return el('tr', {}, el('td', {}, el('b', {}, a.name), a.note ? el('div', { class: 'muted' }, a.note) : null), el('td', {}, w, a.links ? el('div', { class: 'muted', title: 'Parts on different PCs reach each other on localhost through links PC Bridge keeps open.' }, a.links + ' link' + (a.links > 1 ? 's' : '')) : null), el('td', {}, chips,
        el('div', { class: 'acts' }, sel, btn('Send all', () => send(a, sel.value), 'primary', { disabled: !online(), title: 'Move every part of ' + a.name + ' to the chosen PC, in order. If one fails the others are put back.' }), btn('Bring back', () => home(a), '', { title: 'Run every part of ' + a.name + ' on this PC again.' }), btn('Plan', async () => { const p2 = await call('apps:plan', a.name, sel.value || undefined); if (p2) showPlan(p2.data); }, '', { title: 'Show what Send would do. Changes nothing.' }), btn('Test', async () => { res.replaceChildren(el('div', { class: 'muted' }, 'testing…')); const t = await window.api.call('apps:test', a.name); res.replaceChildren(resultRows(t.ok ? t.data : [{ name: 'test', ok: false, detail: t.error, ms: 0 }])); }, '', { title: 'Does every part answer on its localhost port?' }), btn('Edit', () => edit(a), '', { title: 'Change the parts, their order or their PCs.' }), btn('Export', () => exportIt(a), '', { title: 'Make a file you can share and import on another PC.' }), btn('Remove', async () => { if (!confirm(`Forget the app "${a.name}"? The parts keep running where they are.`)) return; if (await call('apps:remove', a.name)) { await reloadCfg(); load(); } }, 'danger', { title: 'Delete the grouping only. Programs and containers are not touched.' }))));
    });
    body.replaceChildren(el('table', {}, el('thead', {}, el('tr', {}, ['App', 'Running', 'Parts (and where each one runs) and actions'].map((h) => el('th', {}, h)))), el('tbody', {}, rows.length ? rows : el('tr', {}, el('td', { colSpan: 3, class: 'empty' }, 'no apps yet: press "New app" below')))));
  }
  const imp = { text: el('textarea', { class: 'input', rows: 5, placeholder: 'paste the app file text here, or choose a file', 'aria-label': 'app file text', style: 'width:100%' }), dir: el('input', { class: 'input w3', placeholder: 'folder on this PC that contains the program folders, e.g. D:\\code', title: 'Each program of the app is expected in a sub folder of this folder.' }), as: el('input', { class: 'input w2', placeholder: 'new name (optional)' }) };
  const pick = el('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'app file', onchange: async (e) => { const f = e.target.files[0]; if (f) imp.text.value = await f.text(); } });
  p.append(el('h1', {}, 'Apps'), el('p', { class: 'sub' }, 'An app is a group of things that belong together: a website front end, its server, a database container... Put them in one app and send the whole thing to another PC (or bring it back) with one button. Parts on different PCs still reach each other on localhost.'),
    section('Your apps', btn('New app', () => edit(null), 'primary', { title: 'Group programs and containers into one app.' }), btn('Refresh', load)), body, section('All addresses (click to open)', btn('Refresh', loadLinks, '', { title: 'Read the list again.' })), hub, res, editor, share,
    section('Import an app', btn('Import', async () => { let m; try { m = JSON.parse(imp.text.value); } catch (e) { toast('That is not valid app file text'); return; } const r = await call('apps:import', m, imp.dir.value.trim(), imp.as.value.trim() || undefined); if (r) { toast('Imported "' + r.data.name + '"'); res.replaceChildren(resultRows(r.data.warnings.length ? r.data.warnings.map((w) => ({ name: w, ok: true, warn: true, detail: '', ms: 0 })) : [{ name: 'imported', ok: true, detail: '', ms: 0 }])); imp.text.value = ''; await reloadCfg(); load(); } }, '', { title: 'Adds the programs and the app from the file. Nothing is moved or overwritten.' })),
    el('div', { class: 'row' }, pick, imp.dir, imp.as), imp.text);
  load();
};

// ---------- GLOBAL ENVS (every .env file in one place, grouped by folder) ----------
// The list lives only in this window's memory: it is read fresh on every scan, never saved, and gone after Clear or closing the window.
const envState = { data: null, q: '', show: false, examples: false, remote: true, extra: '' };
V.envs = (p) => {
  const body = el('div'), res = el('div'), sum = el('div', { class: 'muted mono' });
  const filter = el('input', { class: 'input w3', placeholder: 'filter by folder, file or variable name', value: envState.q, 'aria-label': 'filter', oninput: (e) => { envState.q = e.target.value; paint(); } });
  const extra = el('input', { class: 'input w4', placeholder: 'extra folders to scan, full paths separated by ;', value: envState.extra, 'aria-label': 'extra folders', title: 'Optional. This PC\'s drives (except C:), your user folder, and every program folder PC Bridge knows are scanned already.' });
  const chk = (label, key, tip) => el('label', { class: 'chk', title: tip }, el('input', { type: 'checkbox', checked: envState[key], onchange: (e) => { envState[key] = e.target.checked; if (key !== 'remote') paint(); } }), label);
  function paint() {
    const d = envState.data; body.replaceChildren();
    if (!d) { body.append(el('div', { class: 'empty' }, sum.textContent.startsWith('scanning') ? '' : 'Nothing on screen. Press Scan.')); return; }
    const q = envState.q.trim().toLowerCase(), hit = (f) => !q || (f.folder + ' ' + f.name + ' ' + f.path).toLowerCase().includes(q);
    const files = d.files.filter((f) => (envState.examples || f.kind !== 'example') && (hit(f) || f.vars.some((v) => v.key.toLowerCase().includes(q))));
    const groups = new Map(); for (const f of files) { const k = f.pc + '|' + f.dir; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); }
    sum.textContent = `${files.length} file(s) in ${groups.size} folder(s), ${files.reduce((a, f) => a + f.vars.length, 0)} variable(s) · scanned ${d.scannedDirs} folders in ${(d.ms / 1000).toFixed(1)} s` + (d.truncated ? ' · STOPPED EARLY (time or file limit): add the folder you care about under "extra folders"' : '');
    if (!groups.size) body.append(el('div', { class: 'empty' }, 'No .env file matches.'));
    for (const fl of groups.values()) {
      const f0 = fl[0], local = f0.pc === 'this PC';
      const block = el('div', { class: 'envgrp' }, el('div', { class: 'envhd' }, el('b', {}, f0.folder), el('span', { class: 'tag' }, f0.pc), el('span', { class: 'muted mono', title: f0.dir }, f0.dir),
        el('span', { class: 'acts' }, local ? btn('Open folder', () => call('envs:reveal', f0.path), '', { title: 'Show the file in Explorer' }) : null, btn('Copy path', () => copyText(f0.dir)))));
      for (const f of fl) {
        const vars = hit(f) ? f.vars : f.vars.filter((v) => v.key.toLowerCase().includes(q));
        const rows = vars.map((v) => {
          const val = el('span', { class: 'mono envval', title: 'Click to show or hide' }); let shown = envState.show;
          const draw = () => { val.textContent = !v.value ? '(empty)' : shown ? v.value : '•'.repeat(Math.min(v.value.length, 14)); }; val.onclick = () => { shown = !shown; draw(); }; draw();
          return el('tr', {}, el('td', { class: 'mono' }, v.key), el('td', {}, val), el('td', { class: 'act' }, el('div', { class: 'acts' }, btn('Copy value', () => copyText(v.value)), btn('Copy line', () => copyText(v.key + '=' + v.value)))));
        });
        block.append(el('div', { class: 'envfile' }, el('div', { class: 'row' }, el('span', { class: 'mono' }, f.name), f.kind === 'example' ? el('span', { class: 'tag', title: 'A template: the names of the variables, usually not real values' }, 'example') : null,
          el('span', { class: 'muted' }, `${f.vars.length} variable(s) · changed ${new Date(f.mtime).toLocaleDateString()}`), btn('Copy file', () => copyText(f.text), '', { title: 'Copy the whole file exactly as it is' })),
          rows.length ? el('table', {}, el('tbody', {}, rows)) : el('div', { class: 'muted' }, 'no variables in this file')));
      }
      body.append(block);
    }
  }
  async function scan() {
    envState.data = null; body.replaceChildren(); res.replaceChildren(); sum.textContent = 'scanning this PC' + (envState.remote ? ' and your other PC(s)' : '') + '… this can take a minute or two (every drive is read)';
    const r = await window.api.call('envs:scan', { extra: extra.value.split(';').map((x) => x.trim()).filter(Boolean), includeRemote: envState.remote });
    envState.extra = extra.value; if (!r.ok) { sum.textContent = ''; toast(r.error, true); paint(); return; }
    envState.data = r.data; res.replaceChildren(...r.data.notes.map((n) => el('div', { class: 'muted mono' }, n))); paint();
  }
  p.append(el('h1', {}, 'Global envs'), el('p', { class: 'sub' }, 'Every .env file found on this PC and in the PC Bridge folder of your other PCs, grouped by the folder it lives in. Values are hidden until you click one (or tick "show values"). Nothing is saved: the list is read fresh on every scan and disappears when you press Clear or close the window.'),
    section('Find', btn('Scan', scan, 'primary', { title: 'Read every drive again' }), btn('Clear', () => { envState.data = null; sum.textContent = ''; paint(); }, '', { title: 'Remove all values from this screen' })),
    el('div', { class: 'row' }, filter, extra, chk('show values', 'show', 'Show every value instead of dots'), chk('example files', 'examples', 'Also list .env.example / .env.sample templates'), chk('other PCs', 'remote', 'Also read the .env files of programs that were moved to your other PCs (rescan after changing this)')), sum, res, body);
  paint(); if (!envState.data) scan();
};

// ---------- PORTS ----------
let portSort = { k: 'port', d: 1 }, portFilter = '', showSys = false;
V.ports = (p) => {
  const SYS = /^(svchost|System|lsass|services|wininit|spoolsv|jhi_service|MouseWithoutBorders|OneDrive.*)(\.exe)?$/i;
  const sum = el('p', { class: 'sub' }, 'Reading…'); const tb = el('tbody'); const res = el('div'); let rows = [], busy = false;
  const filter = el('input', { class: 'input w3', placeholder: 'filter  ( / )', value: portFilter, 'aria-label': 'filter ports', oninput: (e) => { portFilter = e.target.value; paint(); } });
  const sys = el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: showSys, onchange: (e) => { showSys = e.target.checked; paint(); } }), 'system ports');
  const cols = [['port', 'Port', 'n'], ['exposed', 'Reachable from', ''], ['process', 'Program (PID)', ''], ['purpose', 'Used for', ''], ['cpu', 'CPU', 'n'], ['ramMB', 'RAM', 'n'], ['ioKBs', 'Disk I/O', 'n']];
  const head = el('tr', {}, ...cols.map(([k, l, c]) => el('th', { class: 'sortable ' + c, text: l, onclick: () => { portSort = { k, d: portSort.k === k ? -portSort.d : 1 }; paint(); } })), el('th', {}, ''));
  p.append(el('h1', {}, 'Ports on this PC'), sum, section('Listening', filter, sys, btn('Refresh', async () => { await load(); })), el('table', {}, el('thead', {}, head), tb), res);
  function paint() {
    const q = portFilter.trim().toLowerCase(); const list = rows.filter((r) => (showSys || !SYS.test(r.process) || r.kind !== 'process') && (!q || (r.port + ' ' + r.process + ' ' + r.purpose + ' ' + (r.container || '')).toLowerCase().includes(q)));
    const k = portSort.k; list.sort((a, b) => ((a[k] > b[k]) - (a[k] < b[k])) * portSort.d);
    const ex = rows.filter((r) => r.exposed).length;
    sum.textContent = `${rows.length} listening, ${list.length} shown. ${ex} reachable from the network, the rest from this PC only. RAM of the shown programs: ${fmtMB([...new Map(list.map((r) => [r.pid, r.ramMB])).values()].reduce((a, b) => a + b, 0))}.`;
    head.querySelectorAll('th.sortable').forEach((th, i) => { th.textContent = cols[i][1] + (portSort.k === cols[i][0] ? (portSort.d > 0 ? ' ▲' : ' ▼') : ''); });
    tb.replaceChildren(...list.map((r) => {
      const action = r.move.state === 'remote' ? el('span', { class: 'w-ok', title: 'This port is forwarded: another PC answers it.' }, 'answered by ' + remote().name) : r.move.action === 'offload' ? btn('Move to ' + remote().name, async () => { const m = await call('containers:offload', r.container, 100); if (m) { toast(m.data); await reloadCfg(); load(); } }, '', { disabled: !online(), title: `Copies the container behind this port to ${remote().name} and forwards the port there.` }) : el('span', { class: 'muted', title: r.move.reason || '' }, r.kind === 'bridge' ? 'PC Bridge' : 'this PC only');
      return el('tr', {}, el('td', { class: 'n' }, link(r.port)), el('td', {}, r.exposed ? el('span', { class: 'w-warn', title: r.addrs.join(', ') }, 'network') : el('span', { class: 'muted' }, 'this PC')), el('td', {}, `${r.process} (${r.pid})`), el('td', { title: r.cmd }, r.purpose),
        el('td', { class: 'n' }, r.containerCpu || r.cpu + ' %'), el('td', { class: 'n' }, r.containerMem || fmtMB(r.ramMB)), el('td', { class: 'n' }, r.ioKBs ? r.ioKBs.toFixed(0) + ' KB/s' : '-'),
        el('td', { class: 'act' }, el('div', { class: 'acts' }, action, btn('Test', async () => { const t = await window.api.call('test:port', r.port); res.replaceChildren(resultRows(t.ok ? [t.data] : [{ name: 'localhost:' + r.port, ok: false, detail: t.error, ms: 0 }])); }))));
    }));
  }
  async function load() { if (busy) return; busy = true; try { const r = await window.api.call('ports:list'); if (r.ok) { rows = r.data.local; paint(); } else sum.textContent = r.error; } finally { busy = false; } }
  load(); every(6000, load); filter.focus();
};

// ---------- MOVE AND SPLIT ----------
const PRESETS = [[0, '100/0'], [20, '80/20'], [50, '50/50'], [80, '20/80'], [100, '0/100']];
V.sites = (p) => {
  const pcOf = (pr) => (cfg.remotes.find((r) => r.name === pr.remote) || remote()).name;   // the PC a site is (or would be) moved to
  p.append(el('h1', {}, 'Move and split'), el('p', { class: 'sub' }, 'Choose where each site runs. 100/0 = everything on this PC, 0/100 = everything on the PC it is moved to. Anything between runs the site on BOTH PCs and shares incoming connections (a connection goes entirely to one PC, so a browser that keeps its connection open stays on it). Each copy keeps its own data. If that PC stops answering, all traffic goes to this PC within seconds.'));
  const list = el('div'); const live = [];
  p.append(section('Sites', btn('Add compose folder…', async () => { const r = await call('proj:add'); if (r?.data) { toast('Added ' + r.data); await reloadCfg(); show('sites'); } })), list);
  if (!cfg.projects.length) list.append(el('div', { class: 'empty' }, 'No sites yet. Move a container from Containers, or add a folder with a docker-compose.yml.'));
  for (const pr of cfg.projects) {
    const pcn = pcOf(pr); const mode = pr.mode ?? 'local', share = mode === 'remote' ? 100 : mode === 'split' ? (pr.share ?? 50) : 0; let want = share;
    const where = el('div', { class: 'where' }), sb = el('div', { class: 'splitbar', role: 'img' }, el('i', { class: 'l' }), el('i', { class: 'r' })), res = el('div'), counters = el('div', { class: 'muted mono' });
    const lL = el('span', { class: 'end' }), lR = el('span', { class: 'end' });
    const paintSplit = (v, bars = true) => { lL.textContent = `THIS ${100 - v}%`; lR.textContent = `${v}% ${pcn.toUpperCase()}`; if (bars) { sb.firstChild.style.width = 100 - v + '%'; sb.lastChild.style.width = v + '%'; } };
    let presets;
    const range = el('input', { type: 'range', min: 0, max: 100, step: 1, value: share, 'aria-label': 'percent of connections to ' + pcn, oninput: (e) => { want = +e.target.value; paintSplit(want, false); presets.paint(''); } });
    presets = seg(PRESETS, PRESETS.some(([v]) => v === share) ? share : '', (v) => { want = +v; range.value = v; paintSplit(want, false); });
    where.textContent = mode === 'split' ? `split ${100 - share}/${share}` : mode === 'remote' ? `on ${pcn} (0/100)` : pr.failedOver ? `this PC (failed over, ${pcn} was down)` : 'this PC (100/0)'; paintSplit(share);
    const opt = (label, key) => sw(label, !!pr[key], async (v) => { const r = await call('proj:set', pr.name, { ports: pr.ports || [], failover: key === 'failover' ? v : !!pr.failover, autoFailback: key === 'autoFailback' ? v : !!pr.autoFailback, autoOffload: key === 'autoOffload' ? v : !!pr.autoOffload }); if (!r) return false; pr[key] = v; });
    list.append(el('div', { class: 'site' },
      el('div', {}, el('span', { class: 'nm' }, pr.name), ' ', el('span', { class: 'tag' }, pr.container ? 'container' : 'compose'), ' ', el('span', { class: 'muted mono' }, 'port ', portLinks(pr.ports)), ' ', ...pageLinks((pr.ports || [])[0], pr.pages).flatMap((x) => [x, ' ']), (pr.ports || []).length ? btn('Pages', () => editPages('project', pr.name, pr.pages, () => show('sites')), '', { title: 'Add pages of ' + pr.name + ' you open often (like /docs/try.html) as links.' }) : null, where, sb,
        el('div', { class: 'sliderline' }, lL, range, lR, presets, btn('Apply', async () => { const m = await call('proj:share', pr.name, want); if (m) { toast(m.data); await reloadCfg(); show('sites'); } }, 'primary', { disabled: !online() && want > 0 })),
        el('div', { class: 'optline' }, opt(`fail over to this PC if ${pcn} dies`, 'failover'), opt('move back when it recovers', 'autoFailback'), opt(`keep on ${pcn} automatically`, 'autoOffload')), counters, res),
      el('div', { class: 'acts' }, testBtn('Test', 'test:project', [pr.name], res), mode !== 'local' ? btn('Bring back', async () => { const m = await call('proj:home', pr.name); if (m) { toast(pr.name + ' is on this PC again'); await reloadCfg(); show('sites'); } }) : null,
        btn('Remove', async () => { if (!confirm(`Remove "${pr.name}" from the list? Containers and files are not deleted.`)) return; const m = await call('proj:remove', pr.name); if (m !== null) { await reloadCfg(); show('sites'); } }, 'danger'))));
    if (mode === 'split') live.push([pr, counters]);
  }
  const upd = async () => { if (!live.length) return; const r = await window.api.call('bal:stats'); if (!r.ok) return; for (const [pr, c] of live) { const b = r.data[pr.name]; if (b) c.textContent = 'connections: ' + b.backends.map((x) => `${x.name === 'local' ? 'this PC' : pcOf(pr)} ${x.conns} (${x.active} open${x.down ? ', DOWN' : ''})`).join(' · '); } };
  upd(); every(2000, upd);
};

// ---------- FORWARDS ----------
V.forwards = (p) => {
  const tb = el('tbody'); const res = el('div');
  fwdPaint = () => {
    tb.replaceChildren(...cfg.forwards.map((f) => {
      const st = fwdState.find((x) => x.localPort === f.localPort); const on = st && st.state !== 'stopped' && st.state !== 'failed';
      return el('tr', {}, el('td', {}, f.name, f.autoStart ? el('span', { class: 'tag' }, 'auto') : null), el('td', { class: 'mono' }, link(f.localPort, 'localhost:' + f.localPort), ` -> ${f.remoteHost}:${f.remotePort}`), el('td', {}, mark(!st ? 'unk' : st.state === 'active' ? 'ok' : st.state === 'failed' ? 'bad' : 'warn', st ? st.state : 'stopped'), st?.restarts ? el('span', { class: 'muted mono' }, ` ${st.restarts} reconnects`) : null),
        el('td', { class: 'act' }, el('div', { class: 'acts' }, on ? btn('Stop', async () => { await call('fwd:stop', f.localPort); }) : btn('Start', async () => { await call('fwd:start', f.localPort); }, '', { disabled: !online() }),
          btn('Test', async () => { const t = await window.api.call('test:port', f.localPort); res.replaceChildren(resultRows(t.ok ? [t.data] : [{ name: 'localhost:' + f.localPort, ok: false, detail: t.error, ms: 0 }])); }), btn('Remove', async () => { if (confirm('Remove this forward?')) { await call('fwd:remove', f.localPort); await reloadCfg(); fwdPaint(); } }, 'danger'))));
    }));
    if (!cfg.forwards.length) tb.append(el('tr', {}, el('td', { colSpan: 4, class: 'empty' }, 'no forwards')));
  };
  const f = { name: el('input', { class: 'input w2', placeholder: 'name' }), lp: el('input', { class: 'input w1', type: 'number', placeholder: 'local' }), rh: el('input', { class: 'input w2', value: '127.0.0.1', 'aria-label': 'address on the connected PC' }), rp: el('input', { class: 'input w1', type: 'number', placeholder: 'port there', title: 'The port on the connected PC' }), auto: el('input', { type: 'checkbox', 'aria-label': 'open it automatically' }) };
  p.append(el('h1', {}, 'Port forwards'), el('p', { class: 'sub' }, 'A forward makes localhost:PORT on this PC reach a port on the connected PC (' + remote().name + ') through an SSH tunnel. It reconnects by itself, with back-off, if the link drops. For whole sites use Move and split.'),
    section('Forwards'), el('table', {}, el('thead', {}, el('tr', {}, ['Name', 'Route', 'State', ''].map((h) => el('th', {}, h)))), tb), res, section('Add'),
    el('div', { class: 'row' }, f.name, f.lp, el('span', { class: 'muted' }, '->'), f.rh, f.rp, el('label', { class: 'chk' }, f.auto, 'start automatically'),
      btn('Add', async () => { if (!f.name.value.trim() || !f.lp.value || !f.rp.value) { toast('Fill in the name, the local port and the port on the other PC first'); return; } const r = await call('fwd:add', { name: f.name.value.trim(), localPort: +f.lp.value, remoteHost: f.rh.value.trim(), remotePort: +f.rp.value, autoStart: f.auto.checked }); if (r !== null) { toast('Added'); await reloadCfg(); fwdPaint(); } }, 'primary')));
  fwdPaint();
};

// ---------- API ----------
V.api = (p) => {
  const body = el('div'), tres = el('div'); let tokenShown = false;
  p.append(el('h1', {}, 'Local API'), el('p', { class: 'sub' }, 'Lets AI agents, scripts and any other program on this PC read PC Bridge and, if you allow it, control it. Loopback only, a token on every call, and nothing listens until you switch it on.'), body);
  const render = (a) => {
    body.replaceChildren(); const tok = a.token || '';
    const port = el('input', { class: 'input w1', type: 'number', value: a.port, 'aria-label': 'API port' });
    body.append(section('Access'),
      el('div', { class: 'row' }, sw('API', a.enabled, async (v) => { const r = await call('api:set', { enabled: v }); if (!r) return false; await load(); }), sw('allow control (change things, not only read)', a.control, async (v) => { const r = await call('api:set', { control: v }); if (!r) return false; await load(); }),
        el('span', { class: 'muted' }, 'port'), port, btn('Apply port', async () => { const r = await call('api:set', { port: +port.value }); if (r) { toast('Port changed'); await load(); } })),
      a.enabled ? el('div', { class: 'row mono' }, mark(a.usage.running ? 'ok' : 'bad', a.usage.running ? 'LISTENING' : 'NOT LISTENING'), a.base, el('a', { href: a.docs, target: '_blank', rel: 'noopener' }, 'open docs')) : el('p', { class: 'muted' }, 'The API is OFF: nothing listens on its port.'));
    if (!a.enabled) return;
    body.append(section('Token', btn(tokenShown ? 'Hide' : 'Show', async () => { tokenShown = !tokenShown; render(a); }), btn('Copy', async () => copyText(tok)), btn('Make a new one', async () => { if (confirm('Programs using the old token stop working. Continue?')) { const r = await call('api:token'); if (r) { toast('New token'); await load(); } } }, 'danger')),
      el('div', { class: 'mono tok' }, tokenShown ? tok : tok.slice(0, 8) + '•'.repeat(32)));
    const ex = (title, text) => el('div', {}, el('div', { class: 'row' }, el('span', { class: 'muted' }, title), btn('Copy', async () => copyText(text))), el('pre', { class: 'blk' }, text));
    const T = tokenShown ? tok : '<token>';
    body.append(section('Use it'), ex('curl', `curl -H "Authorization: Bearer ${T}" ${a.base}/status\ncurl -X POST -H "Authorization: Bearer ${T}" -d '{"share":80}' ${a.base}/projects/searxng/share`),
      ex('PowerShell', `$h = @{ Authorization = "Bearer ${T}" }\nInvoke-RestMethod ${a.base}/status -Headers $h\nInvoke-RestMethod ${a.base}/projects/searxng/share -Method Post -Headers $h -Body '{"share":80}'`),
      ex('Python', `import requests\nH = {"Authorization": "Bearer ${T}"}\nprint(requests.get("${a.base}/ports", headers=H).json())`),
      ex('Tell your AI agent (AGENTS.md)', `PC Bridge API: ${a.base} (Authorization: Bearer ${T}). Docs: ${a.docs}\nGET /status, /ports, /containers, /projects, /logs, /test/all.${a.control ? '\nPOST /projects/{name}/share {"share":0-100} moves load between this PC and the remote.' : ''}`));
    const short = (t) => `PC Bridge is a small Windows app on this PC. It links this PC to my other PC(s) over Tailscale + SSH and can move Docker containers, websites, programs and whole apps (frontend + backend) between them; localhost URLs keep working after a move. It has a local HTTP API.\nRead the full guide first (no token needed): ${a.base}/guide  (or JSON: ${a.base}/info)\nToken for every other call: Authorization: Bearer ${t}\nThen call ${a.base}/overview to see everything at once.`;
    body.append(section('Short prompt', btn('Copy short prompt', async () => copyText(short(tok)), 'primary', { title: 'A few lines: what PC Bridge is and where the full guide is. Includes your real token.' }), btn('Copy (token left out)', async () => copyText(short('<TOKEN>')))),
      el('p', { class: 'muted' }, 'The quick version to paste into an AI chat. It says what this app does and points to the full guide below.'), el('pre', { class: 'blk' }, short(T)));
    const gpre = el('pre', { class: 'blk' }, 'loading…'); window.api.call('api:guide', false).then((r) => { gpre.textContent = r.ok ? r.data : r.error; });
    body.append(section('Copy for an AI', btn('Copy (token left out)', async () => { const r = await call('api:guide', false); if (r) copyText(r.data); }, 'primary', { title: 'The complete guide below with <TOKEN> as a placeholder. Safe to paste anywhere; add the token yourself.' }), btn('Copy with my token', async () => { if (!confirm('This copies the real token. Only paste it into an AI you trust on this PC. Continue?')) return; const r = await call('api:guide', true); if (r) copyText(r.data); }, '', { title: 'Same guide with your real token filled in, ready to use.' })),
      el('p', { class: 'muted' }, 'Give this to your AI agent: it explains how to connect, every endpoint, what it returns and the usual steps (register a program, move it, check it, bring it back). An AI can also read it live from GET /api/v1/info (no token needed) or /api/v1/guide.'), gpre);
    const f = (t) => (t ? new Date(t).toLocaleTimeString() : '-');
    body.append(section('Endpoints', testBtn('Test the API', 'api:test', [], tres)), tres,
      el('table', {}, el('thead', {}, el('tr', {}, ['', 'Path', 'Scope', 'What it does', 'Calls', 'Err', 'ms', 'Last client', 'Last'].map((h, i) => el('th', { class: i >= 4 && i <= 6 ? 'n' : '' }, h)))), el('tbody', {}, a.usage.endpoints.map((e) => el('tr', {}, el('td', { class: 'mono' }, e.method), el('td', { class: 'mono' }, e.path), el('td', {}, el('span', { class: 'tag' }, e.scope)), el('td', { title: e.summary + (e.body ? '  Body: ' + e.body : '') + (e.returns ? '  Returns: ' + e.returns : '') }, e.summary, e.body ? el('div', { class: 'muted mono' }, 'body ' + e.body) : null, e.returns ? el('div', { class: 'muted mono' }, 'returns ' + e.returns) : null), el('td', { class: 'n' }, e.calls), el('td', { class: 'n ' + (e.errors ? 'w-bad' : '') }, e.errors), el('td', { class: 'n' }, e.avgMs), el('td', {}, e.lastClient || '-'), el('td', { class: 'mono' }, f(e.lastAt)))))));
    body.append(section('Programs using it'), el('table', {}, el('thead', {}, el('tr', {}, ['Client', 'Calls', 'Last path', 'Last'].map((h) => el('th', {}, h)))), el('tbody', {}, a.usage.clients.length ? a.usage.clients.map((c) => el('tr', {}, el('td', {}, c.name), el('td', { class: 'n' }, c.calls), el('td', { class: 'mono' }, c.lastPath), el('td', { class: 'mono' }, f(c.lastAt)))) : el('tr', {}, el('td', { colSpan: 4, class: 'empty' }, 'nobody yet')))));
    body.append(section('Recent calls'), el('table', {}, el('thead', {}, el('tr', {}, ['Time', 'Call', 'Status', 'ms', 'Client'].map((h) => el('th', {}, h)))), el('tbody', {}, a.usage.recent.slice(0, 30).map((c) => el('tr', {}, el('td', { class: 'mono' }, f(c.t)), el('td', { class: 'mono' }, `${c.method} ${c.path}`), el('td', { class: c.status >= 400 ? 'w-bad mono' : 'mono' }, c.status), el('td', { class: 'n' }, c.ms), el('td', {}, c.client))))));
  };
  async function load() { const r = await call('api:get'); if (r) render(r.data); }
  load(); every(5000, () => { if (document.activeElement?.tagName !== 'INPUT') load(); });
};

// ---------- LOG ----------
let logPoll = false, logErr = false;
V.log = (p) => {
  const pre = el('pre', { id: 'log' });
  const paintLine = (e) => { if ((e.poll && !logPoll) || (logErr && e.kind !== 'err')) return; pre.append(el('div', { class: e.kind === 'err' ? 'e' : e.kind === 'cmd' ? 'c' : 'i' }, new Date(e.t).toLocaleTimeString() + '  ' + e.msg)); };
  const redraw = () => { pre.replaceChildren(); logLines.forEach(paintLine); pre.scrollTop = pre.scrollHeight; };
  p.append(el('h1', {}, 'Command log'), el('p', { class: 'sub' }, 'Every command PC Bridge runs on either PC, and every error.'),
    section('Log', el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: logPoll, onchange: (e) => { logPoll = e.target.checked; redraw(); } }), 'status polling'), el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: logErr, onchange: (e) => { logErr = e.target.checked; redraw(); } }), 'errors only'),
      btn('Copy', async () => copyText(logLines.map((e) => `${new Date(e.t).toISOString()} ${e.kind} ${e.msg}`).join('\n'))), btn('Clear', async () => { await call('logs:clear'); logLines.length = 0; redraw(); })), pre);
  logAppend = (e) => { const near = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 60; paintLine(e); if (near) pre.scrollTop = pre.scrollHeight; };
  call('logs:all').then((r) => { if (r && cur === 'log') { logLines.length = 0; logLines.push(...r.data); redraw(); } });
};

// ---------- SETUP ----------
V.setup = (p) => {
  p.append(el('h1', {}, 'Setup'), el('p', { class: 'sub' }, 'Connect another PC, edit the connection, manage the app. Only SSH keys are used: no password is asked for or stored, and nothing on either PC is changed without showing you exactly what first.'));
  const pcs = el('div'); p.append(section('Connected PCs'), pcs);
  pcs.append(el('p', { class: 'sub' }, 'The active PC is shown on Overview and used by default for new moves. Sites and programs already moved to another PC keep running there when you change it.'), el('table', {}, el('thead', {}, el('tr', {}, ['', 'Name', 'Address', 'User', 'Backup addresses', ''].map((h) => el('th', {}, h)))), el('tbody', {}, cfg.remotes.map((r, i) => el('tr', {}, el('td', {}, i === cfg.activeRemote ? mark('ok', 'ACTIVE') : ''), el('td', {}, r.name), el('td', { class: 'mono' }, `${r.host}:${r.port}`), el('td', { class: 'mono' }, r.user), el('td', { class: 'mono' }, (r.routes || []).join(', ') || '-'), el('td', { class: 'act' }, i === cfg.activeRemote ? null : btn('Make active', async () => { const m = await call('remote:use', i); if (m) { toast(m.data + ' is now the active PC'); await reloadCfg(); show('setup'); } }, '', { title: 'The active PC is the one shown on Overview and used by default for new moves, forwards and keep-awake. Things already moved to another PC keep running there.' })))))));
  const peers = el('div'), checkOut = el('div');
  const c = { host: el('input', { class: 'input w2', placeholder: '100.x.y.z' }), user: el('input', { class: 'input w2', placeholder: 'windows user' }), key: el('input', { class: 'input w4', value: remote().keyPath, 'aria-label': 'SSH key file' }), port: el('input', { class: 'input w1', type: 'number', value: 22, 'aria-label': 'SSH port' }), routes: [] };
  const cand = () => ({ host: c.host.value.trim(), user: c.user.value.trim(), keyPath: c.key.value.trim(), port: +c.port.value || 22, routes: c.routes });
  p.append(section('Connect a PC', btn('Find PCs on Tailscale', async () => {
    peers.replaceChildren(el('div', { class: 'empty' }, 'asking Tailscale…')); const r = await window.api.call('setup:discover'); if (!r.ok) { peers.replaceChildren(el('div', { class: 'empty' }, r.error)); return; }
    peers.replaceChildren(...r.data.map((q) => el('div', { class: 'peer' }, el('div', {}, el('strong', {}, q.name), ' ', el('span', { class: 'mono muted' }, (q.ip4 || '-') + ' · ' + q.os), ' ', q.self ? el('span', { class: 'tag' }, 'this PC') : mark(q.online ? (q.sshOpen ? 'ok' : 'warn') : 'unk', q.online ? (q.sshOpen ? 'ssh open' : 'online, no ssh') : 'offline')),
      q.self || !q.ip4 ? el('span') : btn('Use', async () => { c.host.value = q.ip4; if (!c.user.value) c.user.focus(); else await check(); }))));
  })), el('p', { class: 'sub' }, 'Pick a PC from your Tailscale network (or type its address), enter the Windows user name on it, then Check. PC Bridge signs in with the key you already have and tells you what is missing.'), peers,
    el('div', { class: 'row' }, el('label', { class: 'fld' }, 'address', c.host), el('label', { class: 'fld' }, 'user on that PC', c.user), el('label', { class: 'fld' }, 'ssh port', c.port), el('label', { class: 'fld' }, 'private key', c.key), btn('Check', async () => { await check(); }, 'primary')), checkOut);
  async function check() {
    if (!c.host.value.trim() || !c.user.value.trim()) { toast('Enter the address and the user name first', true); return; }
    checkOut.replaceChildren(el('div', { class: 'empty' }, 'checking… (up to a minute: it wakes WSL on that PC)')); const r = await window.api.call('setup:check', cand()); if (!r.ok) { checkOut.replaceChildren(el('div', { class: 'empty' }, r.error)); return; }
    const ul = el('ul', { class: 'steps' });
    for (const s of r.data.steps) {
      const li = el('li', {}, el('span', { class: 'mono ' + (s.ok === true ? 'w-ok' : s.ok === false ? 'w-bad' : 'muted') }, s.ok === true ? '[OK]' : s.ok === false ? '[FIX]' : '[--]'),
        el('div', {}, el('div', {}, el('strong', {}, s.title)), el('div', { class: 'mono muted' }, s.detail), s.fix ? el('pre', { class: 'blk' }, s.fix) : null,
          s.action?.id === 'install-shim' ? el('div', {}, el('pre', { class: 'blk' }, 'Will create on that PC:\n' + s.action.preview), btn(s.action.label, async () => { const m = await call('setup:installShim', cand(), true); if (m) { toast(m.data); await check(); } }, 'primary')) : null,
          s.action?.id === 'add-routes' ? el('div', {}, el('div', { class: 'muted' }, s.action.preview), btn(s.action.label, async (b) => { c.routes = [...new Set([...c.routes, ...(s.action.routes || [])])]; toast('Backup address added to this connection'); b.disabled = true; })) : null));
      ul.append(li);
    }
    const nm = r.data.info?.host || cand().host;
    checkOut.replaceChildren(ul, el('div', { class: 'row' }, el('span', { class: r.data.ready ? 'w-ok' : 'w-bad' }, r.data.ready ? 'Ready to connect.' : 'Fix the items above, then Check again.'),
      btn('Connect and use it', async () => { const m = await call('setup:apply', { ...cand(), name: nm }, true); if (m) { toast(m.data.active ? 'Connected and active' : 'Added'); await reloadCfg(); show('setup'); } }, 'primary', { disabled: !r.data.ready }),
      btn('Add without switching', async () => { const m = await call('setup:apply', { ...cand(), name: nm }, false); if (m) { toast('Added'); await reloadCfg(); show('setup'); } }, '', { disabled: !r.data.ready })));
  }
  const r0 = remote(); const e = { name: el('input', { class: 'input w2', value: r0.name, 'aria-label': 'PC name' }), host: el('input', { class: 'input w2', value: r0.host, 'aria-label': 'host or Tailscale IP' }), user: el('input', { class: 'input w2', value: r0.user, 'aria-label': 'windows user' }), port: el('input', { class: 'input w1', type: 'number', value: r0.port, 'aria-label': 'SSH port' }), key: el('input', { class: 'input w4', value: r0.keyPath, 'aria-label': 'SSH key file' }), ctx: el('input', { class: 'input w2', value: r0.contextName, 'aria-label': 'Docker context name' }),
    fast: el('input', { type: 'checkbox', checked: r0.fastCopy !== false }),
    routes: el('input', { class: 'input w3', value: (r0.routes || []).join(', '), placeholder: 'LAN IP, comma separated' }), excl: el('input', { class: 'input w4', value: cfg.syncExcludes.join(', '), 'aria-label': 'folders skipped when copying' }) };
  p.append(section('Active connection', btn('Show config file', async () => { await call('config:reveal'); })),
    el('div', { class: 'row' }, ...[['name', e.name], ['address (Tailscale IP)', e.host], ['user', e.user], ['ssh port', e.port], ['docker context', e.ctx]].map(([l, n]) => el('label', { class: 'fld' }, l, n))),
    el('div', { class: 'row' }, el('label', { class: 'chk', title: 'When this PC and the other PC are on the same Wi-Fi / LAN, big copies (sending a program, copying back, push) go straight over the home network: about 17x faster than through Tailscale. Everything else keeps using Tailscale.' }, e.fast, 'fast copy over the home network (when on the same Wi-Fi)'), el('label', { class: 'fld' }, 'private key path', e.key), el('label', { class: 'fld' }, 'backup addresses (same Wi-Fi / LAN)', e.routes), el('label', { class: 'fld' }, 'sync excludes', e.excl), btn('Save', async () => {
      const remotes = cfg.remotes.slice(); remotes[cfg.activeRemote] = { ...r0, name: e.name.value.trim(), host: e.host.value.trim(), user: e.user.value.trim(), port: +e.port.value, keyPath: e.key.value.trim(), contextName: e.ctx.value.trim(), fastCopy: e.fast.checked, routes: e.routes.value.split(',').map((x) => x.trim()).filter(Boolean) };
      const r = await call('config:save', { remotes, syncExcludes: e.excl.value.split(',').map((x) => x.trim()).filter(Boolean) }); if (r) { toast('Saved'); await reloadCfg(); }
    }, 'primary')), el('p', { class: 'muted' }, 'Config file: ', el('code', {}, cfgFile)));
  const stats = el('span', { class: 'mono muted' });
  p.append(section('This app'), el('div', { class: 'row' }, sw('start PC Bridge when I sign in to Windows', openAtLogin, async (v) => { const r = await call('login:set', v); if (!r) return false; openAtLogin = v; }), btn('Quit PC Bridge', async () => { if (confirm('Quit PC Bridge? Sites and programs moved to other PCs are brought back to this PC first (can take a minute).')) { await call('app:quit'); document.body.textContent = 'PC Bridge is quitting. You can close this window.'; } }, 'danger'), stats),
    el('p', { class: 'muted' }, 'Closing this window keeps PC Bridge running in the background (failover needs it). Quit stops it and puts moved sites and programs back on this PC first.'));
  const upd = async () => { const r = await window.api.call('app:stats'); if (r.ok) stats.textContent = `service memory ${r.data.rssMB} MB · up ${Math.round(r.data.uptimeS / 60)} min`; }; upd(); every(10000, upd);
};

// ---------- data wiring ----------
async function reloadCfg() {
  const r = await call('config:get'); if (!r) return;
  cfg = r.data.config; cfgFile = r.data.file; fwdState = r.data.fwd; openAtLogin = !!r.data.openAtLogin; if (r.data.status) onStatus(r.data.status, false);
  $('#railfoot').textContent = (cfg.projects.filter((q) => q.mode && q.mode !== 'local').length + (cfg.programs || []).filter((q) => q.mode === 'remote').length) + ' item(s) running on another PC';
}
function onStatus(s, redraw = true) {
  status = s;
  if (s.local) { push(hist.local.cpu, s.local.cpu); push(hist.local.ram, pctOf(s.local.ramUsedMB, s.local.ramTotalMB)); }
  if (s.metrics) { push(hist.remote.cpu, s.metrics.cpu); push(hist.remote.ram, pctOf(s.metrics.ramUsedMB, s.metrics.ramTotalMB)); }
  paintRail(); if (redraw && cfg && ovDraw) ovDraw();
}
window.api.on('status', (s) => onStatus(s));
window.api.on('fwd', (f) => { const ch = JSON.stringify(f) !== JSON.stringify(fwdState); fwdState = f; if (ch && fwdPaint) fwdPaint(); });
window.api.on('log', (e) => { logLines.push(e); if (logLines.length > 3000) logLines.splice(0, 500); if (logAppend) logAppend(e); });
window.api.on('projects', (list) => { if (!cfg) return; cfg.projects = list; if (cur === 'sites') show('sites'); toast('A site moved (see Log)'); });
setInterval(paintRail, 5000);
setInterval(async () => { const r = await window.api.call('app:stats'); if (r.ok) $('#bar-mem').textContent = 'service ' + r.data.rssMB + ' MB'; }, 10000);
document.addEventListener('keydown', (e) => { if (e.key === '/' && cur === 'ports' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) { e.preventDefault(); document.querySelector('#v-ports input')?.focus(); } });
(async () => { buildRail(); await reloadCfg(); show('overview'); paintRail(); document.body.dataset.ready = '1'; })();
