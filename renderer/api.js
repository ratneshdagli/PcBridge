'use strict';
// Talks to the local PC Bridge service (same origin, 127.0.0.1). Same shape the old Electron preload exposed: api.call / api.on.
const es = new EventSource('/events');
window.api = {
  call: async (ch, ...a) => {
    try { return await (await fetch('/api/' + encodeURIComponent(ch), { method: 'POST', body: JSON.stringify(a) })).json(); }
    catch (e) { return { ok: false, error: 'PC Bridge service is not reachable (' + e.message + '). Start PC-Bridge.vbs again.' }; }
  },
  on: (ev, cb) => es.addEventListener(ev, (m) => cb(JSON.parse(m.data))),
};
