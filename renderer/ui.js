'use strict';
// Tiny UI toolkit: DOM helpers, controls, bars, sparklines, test-result rows. All data is inserted as text (never innerHTML).
window.__errors = [];
window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (k === 'text') n.textContent = v; else if (k === 'data') Object.assign(n.dataset, v); else if (k.startsWith('aria-') || k === 'role') n.setAttribute(k, v); else n[k] = v;
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
};
const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...kids) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); for (const c of kids) n.append(c); return n; };

async function call(ch, ...a) {
  const r = await window.api.call(ch, ...a);
  if (!r.ok) { toast(r.error, true); return null; }
  return { data: r.data };
}
let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = err ? 'err' : ''; clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), err ? 10000 : 3500);
}
/** Run an async action with the button disabled + spinner so a double click can't start it twice. */
async function act(b, fn) {
  if (b.disabled) return;
  b.disabled = true; b.classList.add('busy');
  try { return await fn(); } finally { b.disabled = false; b.classList.remove('busy'); }
}
const TIPS = { 'Test connection': 'Check the link to the other PC: Tailscale, ssh, key, Docker.', Wake: 'Start Docker (WSL) on the other PC if it went idle.', 'Open shell': 'Open a terminal connected to the other PC.', 'Point docker CLI at REMOTE': 'Make the "docker" command in your terminals talk to the other PC.', 'Point docker CLI back at this PC': 'Make the "docker" command talk to this PC again.', start: 'Start this container on the other PC.', stop: 'Stop this container on the other PC.', restart: 'Restart this container on the other PC.', logs: 'Show the last log lines of this container.', Refresh: 'Read the data again.', Copy: 'Copy these results to the clipboard.', Close: 'Close this panel.', Test: 'Run a quick check and show PASS / FAIL.', Move: 'Move to the other PC.', Quit: 'Put moved sites back on this PC, then stop PC Bridge.' };
const btn = (label, fn, cls = '', extra = {}) => el('button', { class: 'btn ' + cls, type: 'button', text: label, title: TIPS[label] || TIPS[label.replace(/^Test.*/, 'Test')] || '', onclick: (e) => act(e.currentTarget, () => fn(e.currentTarget)), ...extra });

/** Switch: role=switch button with a visible ON/OFF word. */
function sw(label, checked, onchange) {
  const b = el('button', { class: 'sw', type: 'button', role: 'switch', 'aria-checked': String(!!checked) }, el('span', { class: 'trk' }), el('span', { class: 'st' }, checked ? 'ON' : 'OFF'), label ? el('span', {}, label) : null);
  b.set = (v) => { b.setAttribute('aria-checked', String(!!v)); b.querySelector('.st').textContent = v ? 'ON' : 'OFF'; };
  b.addEventListener('click', async () => { const v = b.getAttribute('aria-checked') !== 'true'; b.set(v); const ok = await onchange(v); if (ok === false) b.set(!v); });
  return b;
}
/** Segmented control (presets such as 100/0 80/20 50/50). */
function seg(options, value, onpick) {
  const wrap = el('div', { class: 'seg', role: 'group' });
  const paint = (v) => wrap.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === String(v))));
  for (const [v, label] of options) wrap.append(el('button', { type: 'button', text: label, data: { v: String(v) }, onclick: () => { paint(v); onpick(v); } }));
  paint(value); wrap.paint = paint; return wrap;
}

const fmtMB = (v) => (v >= 1024 ? (v / 1024).toFixed(1) + ' GB' : Math.round(v) + ' MB');
const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? s + ' s ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago'; };
const pctOf = (a, b) => (b ? Math.round((a * 100) / b) : 0);

function bar(pct) {
  const p = Math.max(0, Math.min(100, pct)); const i = el('i', { class: p >= 90 ? 'bad' : p >= 75 ? 'warn' : '' }); i.style.width = p + '%';
  return el('div', { class: 'bar', role: 'img', 'aria-label': p + ' percent' }, i);
}
function spark(vals) {
  const w = 60, h = 16, s = svg('svg', { class: 'spark', viewBox: `0 0 ${w} ${h}`, 'aria-hidden': 'true' });
  if (vals.length > 1) { const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * (w - 1)).toFixed(1)},${(h - 1 - (Math.max(0, Math.min(100, v)) / 100) * (h - 2)).toFixed(1)}`).join(' '); s.append(svg('polyline', { points: pts })); }
  return s;
}
const mark = (kind, word) => el('span', { class: kind === 'ok' ? 'w-ok' : kind === 'bad' ? 'w-bad' : kind === 'warn' ? 'w-warn' : 'muted' }, el('span', { class: 'st-sq ' + kind }), word);

/** Clickable addresses. localhost:PORT on this PC reaches a program wherever it runs (tunnel/forward), so these links work after a move too. */
const lurl = (port, path = '/') => 'http://localhost:' + port + path;
const link = (port, text, path = '/', extra = {}) => el('a', { class: 'plink', href: lurl(port, path), target: '_blank', rel: 'noopener', title: 'Open ' + lurl(port, path), ...extra }, text ?? String(port));
const portLinks = (ports, empty = '-') => (ports && ports.length ? el('span', {}, ...ports.flatMap((pt, i) => [i ? ', ' : null, link(pt)])) : empty);
/** Host ports out of docker's "0.0.0.0:8080->80/tcp, [::]:8080->80/tcp" text. */
const dockerPorts = (s) => [...new Set([...String(s || '').matchAll(/:(\d+)->/g)].map((m) => +m[1]))];

function section(title, ...actions) { return el('div', { class: 'sec' }, el('h2', {}, title), el('div', { class: 'acts' }, ...actions)); }

/** [PASS]/[FAIL] rows with a one-line summary. results = [{name, ok, detail, ms, warn}] */
function resultRows(results) {
  const pass = results.filter((r) => r.ok && !r.warn).length, warn = results.filter((r) => r.ok && r.warn).length, fail = results.filter((r) => !r.ok).length;
  const box = el('div', { class: 'inline-res' }, el('div', { class: 'summary ' + (fail ? 'w-bad' : warn ? 'w-warn' : 'w-ok') }, `${pass} pass${warn ? ', ' + warn + ' note' : ''}, ${fail} fail`));
  results.forEach((r, i) => {
    const row = el('div', { class: 'res' }, el('span', { class: 'tg ' + (r.ok ? (r.warn ? 'w-warn' : 'w-ok') : 'w-bad') }, r.ok ? (r.warn ? '[NOTE]' : '[PASS]') : '[FAIL]'), el('span', {}, r.name), el('span', { class: 'det' }, r.detail || ''), el('span', { class: 'ms' }, r.ms ? r.ms + ' ms' : ''));
    row.style.animationDelay = Math.min(i, 12) * 30 + 'ms'; box.append(row);
  });
  box.append(el('div', { class: 'acts' }, el('button', { class: 'btn', type: 'button', text: 'Copy', onclick: () => navigator.clipboard?.writeText(results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}: ${r.detail}`).join('\n')).then(() => toast('Copied')) })));
  return box;
}
/** A Test button that runs `channel` and shows [PASS]/[FAIL] rows into `target`. */
function testBtn(label, channel, args, target, extraCls = '') {
  return btn(label, async () => {
    target.replaceChildren(el('div', { class: 'muted' }, 'running…')); const r = await window.api.call(channel, ...args);
    target.replaceChildren(r.ok ? resultRows(Array.isArray(r.data) ? r.data : [r.data]) : resultRows([{ name: label, ok: false, detail: r.error, ms: 0 }]));
  }, extraCls);
}

const ICONS = {
  overview: 'M2 3h12M2 8h12M2 13h12', containers: 'M2 5l6-3 6 3v6l-6 3-6-3zM2 5l6 3 6-3M8 8v6', ports: 'M2 8h3M11 8h3M5 5h6v6H5z',
  split: 'M2 4h5l2 4h5M2 12h5l2-4', programs: 'M3 3h10v10H3zM6 6l2 2-2 2M9 10h2', apps: 'M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z', forwards: 'M2 8h11M9 4l4 4-4 4', envs: 'M3 2h7l3 3v9H3zM10 2v3h3M5 8h6M5 11h6', api: 'M5 3L2 8l3 5M11 3l3 5-3 5', log: 'M3 3h10M3 6h7M3 9h10M3 12h6', setup: 'M2 5h12M2 11h12M6 3v4M10 9v4',
};
const icon = (k) => svg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }, svg('path', { d: ICONS[k] }));
