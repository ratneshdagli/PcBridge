// One catalogue of the AI endpoints on this PC (the Groq/Gemini key gateway plus any local OpenAI-style server listed in endpoints.json),
// with a status check and a ready-to-paste prompt for any AI agent. A key is only ever REFERENCED by file path and field, never read or shown here.
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { KEYGW_PORT } from './keygw';

export interface Endpoint { name: string; baseUrl: string; health?: string; auth?: 'none' | 'bearer'; keyFile?: string; keyField?: string; docs?: string[]; notes?: string; builtin?: boolean; how?: string }
const file = () => path.join(process.env.APPDATA || '', 'pc-bridge', 'endpoints.json');

const builtin = (): Endpoint[] => [
  { name: 'Groq (key gateway)', builtin: true, baseUrl: `http://127.0.0.1:${KEYGW_PORT}/groq/<your-program-name>/openai/v1`, health: `http://127.0.0.1:${KEYGW_PORT}/_health`, auth: 'none', how: 'OpenAI-style. Use any dummy api_key. Put your own program name where <your-program-name> is so usage is counted per program. The gateway adds a real account key and moves to the next account when one runs out.', notes: 'Groq models only. Never copy or log a Groq key.' },
  { name: 'Gemini (key gateway)', builtin: true, baseUrl: `http://127.0.0.1:${KEYGW_PORT}/gemini/<your-program-name>`, health: `http://127.0.0.1:${KEYGW_PORT}/_health`, auth: 'none', how: 'Gemini API paths as normal (/v1beta/models/...:generateContent, or /v1beta/openai for OpenAI-style). Use any dummy key. Put your own program name where <your-program-name> is.', notes: 'Gemini models only. Never copy or log a Gemini key.' },
];

function custom(): Endpoint[] {
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8').replace(/^﻿/, ''));
    return (Array.isArray(j) ? j : []).filter((e) => typeof e?.name === 'string' && typeof e?.baseUrl === 'string').slice(0, 50).map((e) => ({
      name: e.name.slice(0, 80), baseUrl: e.baseUrl.slice(0, 300), health: typeof e.health === 'string' ? e.health : undefined, auth: e.auth === 'bearer' ? 'bearer' : 'none',
      keyFile: typeof e.keyFile === 'string' ? e.keyFile : undefined, keyField: typeof e.keyField === 'string' ? e.keyField : undefined,
      docs: Array.isArray(e.docs) ? e.docs.filter((d: unknown) => typeof d === 'string').slice(0, 10) : undefined, notes: typeof e.notes === 'string' ? e.notes.slice(0, 1500) : undefined, how: typeof e.how === 'string' ? e.how.slice(0, 1500) : undefined,
    }));
  } catch { return []; }
}

const up = (url?: string) => new Promise<boolean>((resolve) => {
  if (!url || !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) return resolve(false);   // only this PC is ever probed
  const r = http.get(url, { timeout: 1500 }, (res) => { res.resume(); resolve((res.statusCode || 500) < 500); });
  r.on('error', () => resolve(false)); r.on('timeout', () => { r.destroy(); resolve(false); });
});

export function promptOf(e: Endpoint): string {
  const l = [`${e.name}: base URL ${e.baseUrl}`];
  if (e.how) l.push(e.how);
  if (e.auth === 'bearer') l.push(`Auth: send "Authorization: Bearer <key>". Read the key at call time from ${e.keyFile ? `the field "${e.keyField || 'apiKey'}" in ${e.keyFile}` : 'its config'}; never hardcode, copy, print or log it.`);
  else l.push('Auth: none needed.');
  if (e.health) l.push(`Health check: GET ${e.health}`);
  if (e.docs?.length) l.push(`Read for details: ${e.docs.join(' , ')}`);
  if (e.notes) l.push(e.notes);
  return l.join('\n');
}

export async function list() {
  const all = [...builtin(), ...custom()];
  return Promise.all(all.map(async (e) => ({ ...e, up: await up(e.health), prompt: promptOf(e) })));
}
export async function promptAll(): Promise<string> {
  const es = await list();
  return ['You can use these AI endpoints on this PC. Pick the one that fits; use each only as described.', ...es.map((e, i) => `${i + 1}. ${e.prompt}`), 'Never copy, print or hardcode any API key. Only call these from code running on this PC (they listen on 127.0.0.1).'].join('\n\n');
}
