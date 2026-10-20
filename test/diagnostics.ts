import { strict as assert } from 'node:assert';
import { diagnoseSsh, parseTailscaleStatus } from '../src/core';

const host = '100.64.0.1';
const peer = { HostName: 'remote', TailscaleIPs: [host], Online: false };
for (const BackendState of ['NoState', 'Starting', 'Stopped', 'NeedsLogin']) {
  const ts = parseTailscaleStatus({ BackendState, Health: ['Cannot reach coordination server'], Peer: { peer } }, host);
  assert.equal(ts.scope, 'local');
  assert.match(ts.detail, /Cannot reach coordination server/);
  const d = diagnoseSsh('TCP timed out', ts);
  assert.match(d.headline, /This PC.*remote PC status is unknown/);
  assert.match(d.checklist.join(' '), /restart Tailscale on this PC/);
  assert.match(diagnoseSsh('Permission denied (publickey)', ts).headline, /key was rejected/);
}
const disconnected = parseTailscaleStatus({ BackendState: 'Running', Self: { Online: false }, Peer: { peer } }, host);
assert.equal(disconnected.scope, 'local');
const offline = parseTailscaleStatus({ BackendState: 'Running', Self: { Online: true }, Peer: { peer } }, host);
assert.equal(offline.scope, 'remote');
assert.match(diagnoseSsh('timed out', offline).headline, /Remote PC is offline/);
const online = parseTailscaleStatus({ BackendState: 'Running', Peer: { peer: { ...peer, Online: true } } }, host);
assert.equal(online.state, 'online');
assert.match(diagnoseSsh('Connection refused', online).headline, /sshd/);
assert.equal(parseTailscaleStatus({ BackendState: 'Running' }, host).state, 'unknown');
console.log('Connection diagnostics regression checks passed');
