// The "Crawler" tab's data: PC Bridge only READS the crawler (ACS, port 8900) with cheap GET calls; it never starts a crawl.
import * as http from 'http';

export const CRAWLER_PORT = 8900;

function get(p: string, timeout = 2500): Promise<any> {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: CRAWLER_PORT, path: p, method: 'GET', timeout }, (res) => {
      let s = ''; res.on('data', (c) => { if (s.length < 2e6) s += c; }); res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve(null); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); }); r.end();
  });
}

/** Live view for the tab: jobs, sites and layers from /status, plus saved logins and schedules (counts only, never cookie values). */
export async function status() {
  const s = await get('/status', 10000);   // the crawler probes its layers for this, about 3 s
  if (!s) return { up: false, port: CRAWLER_PORT, jobs: [], sites: [], layers: [] };
  const [ses, sch] = await Promise.all([get('/sessions'), get('/schedules')]);
  const count = (x: any) => (Array.isArray(x) ? x.length : Array.isArray(x?.sessions) ? x.sessions.length : Array.isArray(x?.schedules) ? x.schedules.length : Array.isArray(x?.domains) ? x.domains.length : 0);
  return { up: true, port: CRAWLER_PORT, jobs: s.jobs || [], sites: s.sites || [], layers: s.layers || [], sessions: count(ses), schedules: count(sch) };
}

/** "Copy as prompt": a short, self-contained brief so any AI session can use the crawler. No keys in it. */
export const prompt = (): string => `The crawler (ACS, "All-in-one website") runs on this PC at http://127.0.0.1:${CRAWLER_PORT}. Use it instead of writing your own scraper.
Read-only (free): GET /status (jobs, sites, layers), GET /health, GET /sessions, GET /schedules.
Crawl: POST /crawl/async returns a job_id; poll GET /jobs/{id} or stream WS /jobs/{id}/stream. POST /crawl/batch blocks and returns everything. POST /search (SearXNG) and POST /research (search plus crawl the top results). GET /cdp/screenshot and POST /cdp/navigate drive the user's real Chrome tab.
It tries lighter layers first and escalates (curl_cffi, httpx, playwright, patchright, scrapling, crawl4ai, camoufox, webcmd, firecrawl, vision, jina, trafilatura, cdp). Results come back as JSON over HTTP, nothing is saved to disk. For LLM calls use the key gateway at http://127.0.0.1:8795/groq/<program>/... or /gemini/<program>/... with any dummy key, never a real key.
PC Bridge's Crawler tab shows the same live data.`;
