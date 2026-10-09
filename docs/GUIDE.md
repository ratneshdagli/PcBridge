# PC Bridge: full guide

Small, low-RAM Windows app that connects THIS PC to a second PC over Tailscale + SSH keys: live stats of both, Docker containers, every listening port, moving sites to the other PC (all of it, or a weighted share such as 80/20), port forwards, a "connect a PC" wizard, a local API for other programs, and Test buttons everywhere.

**No Electron.** One tiny Node process (~45-55 MB) serves the UI on `127.0.0.1` only; the window is your already-running Edge/Chrome in `--app` mode (no extra browser process, no bundled Chromium). It shells out to the system `ssh`, `docker`, `tailscale`, `tar` and `wsl`; every command is shown in the **Log**.

## Run

```bash
cd pc-bridge
npm install          # once (typescript + node types only, ~34 MB)
npm start            # build + run (opens the window)
npm test             # real end-to-end tests against the remote PC (~10 min; run when this PC is idle)
```
Everyday use: the **PC Bridge** desktop shortcut (or `PC-Bridge.vbs`; Node 18+ on PATH, `dist/` built). Starting it again only opens the window of the running service. Closing the window leaves PC Bridge running (failover needs it). **Setup → Quit** stops it and first puts moved sites back on this PC.
`PC-Bridge.vbs --tray` adds a red/green tray icon (PowerShell based, ~70 MB, so off by default). **Setup → start when I sign in** is an opt-in HKCU Run entry (default off).
Config: `%APPDATA%\pc-bridge\config.json` (host/user/key path/API token only, never passwords).

## Screens
| Screen | What it does |
|---|---|
| **Overview** | THIS PC and REMOTE side by side: CPU, RAM, GPU, every drive, sparklines; link state and route in use; remote Docker containers (start/stop/restart/logs); keep-awake; Test connection. |
| **Containers** | Every container on this PC. **Move** copies its config and data to the remote and stops it here; the percentage says how much traffic the remote takes (100 = all). |
| **Ports** | Every listening port on this PC: program, PID, purpose, CPU/RAM/IO, reachable from the network or this PC only, whether it can move. Sortable, filter (`/`), Test per row. |
| **Move and split** | Per site: slider + presets `100/0 80/20 50/50 20/80 0/100` (THIS/REMOTE), live counters, failover / move-back / keep-on-remote switches, Test, Bring back. |
| **Programs** | Anything that is not a container (Node/Python server, a browser service...): **Prepare other PC** (creates `E:\PCBridge` there and unpacks portable Node with a checked hash, nothing on C:), **Move to remote PC** (copies the folder, `npm install`, runs it under a restarting supervisor, forwards its port), **Bring back**, **Log**, **Test**. If a program on this PC holds the port, PC Bridge asks before stopping it. |
| **Forwards** | `localhost:L -> remote:R` tunnels with auto-reconnect. |
| **API** | Switch the local API on/off, allow control, port, token, examples, endpoint table with usage, clients, recent calls, Test. |
| **Log** | Every command and error. |
| **Setup** | Connect another PC (wizard), switch active PC, edit the connection (incl. backup LAN address), start with Windows, Quit. |

The status bar's **Test everything** runs every self test (connection, remote Docker, forwards, sites, ports) and lists `[PASS]/[FAIL]` rows.

## Load split (default: 100% on one PC)
`share` = % of connections the remote gets. 0 and 100 use the plain single-PC paths. In between, the site runs on **both** PCs and a weighted TCP proxy owns `127.0.0.1:port` and `::1:port` (the local container keeps its published port; Windows lets the more specific loopback bind coexist, and the proxy reaches the local copy through this PC's Tailscale/LAN address). Split is exact (80/20 over 250 connections = 200/50); a dead backend costs zero client errors (the connection is retried on the other PC; only idempotent GET/HEAD/OPTIONS requests are replayed); the remote is marked down by the status poll within one cycle; everything goes to this PC while the remote is unhealthy.
Limits: the share is per **connection** (a browser or agent that keeps one connection open stays on one PC); both copies keep their own data and secrets (two SearXNG instances with different `secret_key` reject each other's signed URLs); the local container must be published on all addresses (not `127.0.0.1` only); both PCs use RAM; one port per split site.

## Connect a PC (Setup)
**Find PCs on Tailscale** lists your tailnet (online, SSH open). Enter the Windows user, **Check**: key file, reachability of every address, key sign-in (no password), system / WSL / Docker, the `docker.cmd` shim, and the PC's same-Wi-Fi/LAN address. If the key is not accepted PC Bridge shows your public key and where it belongs; **it never edits `authorized_keys`, sshd, firewall, SSH keys or Tailscale**. The one remote change it can make, creating `docker.cmd`, is shown in full and only happens when you click the button.
**Fast copy over the home network (on by default, Setup > Active connection):** when this PC and the other PC are on the same Wi-Fi/LAN, big copies (send a program, copy back, push changes) use the other PC's LAN address instead of Tailscale: measured 43 MB/s vs 2.5 MB/s (37 GB ≈ 15 min instead of ≈ 4 h), copy time limit 3 h instead of 15 min. The LAN address is asked from the other PC itself and only used after a real key login on it worked (same key and host-key entry, `known_hosts` untouched); otherwise the normal address is used. Control, status and Docker keep using the main address. Off: untick it (`remotes[].fastCopy: false`; the API shows it in `GET /remotes`). The 1.5 GB cap of Docker container data is unchanged.

**Backup (LAN) address:** keeps things working when Tailscale drops. Sticky: the main address is used while it answers; on failure the backup is used, with the same host key (`HostKeyAlias`, `known_hosts` untouched); it returns to the main address after 5 stable polls.

## Local API for other programs (off by default)
**API → switch on.** `http://127.0.0.1:8787/api/v1`, loopback only, `Authorization: Bearer <token>` on everything except `/health`; **Allow control** (write endpoints) is a separate switch; Host header checked (DNS rebinding), no CORS. `/api/v1/docs` (HTML) and `/api/v1/openapi.json` document every endpoint; `/api/v1/usage` and the API screen show calls per endpoint, per client (send `X-Client-Name`), latency and the last 200 calls.
Read: `GET /status /ports /containers /projects /forwards /remotes /peers /logs /usage /test/all /test/connection /test/project/{name} /test/port/{port}`.
Control: `POST /projects/{name}/share {"share":0-100}`, `/projects/{name}/offload`, `/projects/{name}/home`, `/containers/{name}/offload`, `/forwards/{port}/start|stop`, `/remote/wake`, `/refresh`.

## Programs, and where things live on the other PC
Everything PC Bridge puts on the remote lives under `remoteRoot` (default `E:\PCBridge`; C: is refused): `tools\node` (portable Node), `apps\<name>`, `logs`, `run`, `tmp`, `npm-cache`, and the remote Docker's WSL disk (`wsl`). No installer, PATH, registry, service or admin. Limits: the program must start with one command; data it writes is not synced back on Bring back; Python programs need Python on the remote (not installed for you); no automatic failover for programs yet (the supervisor restarts it if it crashes). With Docker Desktop off on this PC, moved sites keep working; only listing local containers, new container moves and Bring back/failover need it (they start Docker Desktop).

**Updates (Programs screen).** *Check updates* only reports; *Update everything* updates the remote's portable Node (newest release of the same major, SHA-256 checked, old version restored if it fails), `uv`, every moved program's libraries (`npm update` within the ranges in `package.json`; `uv pip install --upgrade -r requirements.txt`) and the supervisor, then restarts the affected programs. *update weekly* does the same about once a week while the remote is reachable (off by default). Linux packages in WSL (the Docker engine) are only reported; update them inside WSL yourself. API: `GET /programs/updates`, `POST /programs/update`. A major Node jump is reported, never applied automatically.
Python programs: `uv` creates a private venv per program and downloads its own Python under `<root>\python`. Programs fail over to this PC after 3 bad polls; on the way back, files the program changed on the remote are copied back (never over newer local files).

## Things to know
1. **Remote WSL sleeps by itself** about a minute after the last session ends (containers stop). PC Bridge holds one background SSH session (keep-awake). Closing PC Bridge lets it idle off again.
2. **Failover only works while PC Bridge runs.** Quit moves sites back first; a crash or kill leaves a forwarded port dead until you start PC Bridge again. Failover takes roughly 10-20 s; Docker Desktop is started if needed.
3. Docker only: compose projects or single containers (privileged/GPU/custom-network/docker.sock containers are refused with a reason). Plain programs (a Python API, Camofox...) can't move; put them in a container first.
4. Offload and split never delete anything; the remote twin is created once and reused.
5. One active remote at a time (plus this PC). Several remotes can be configured and switched; N-way splits across several remotes are not implemented.
6. The remote Tailscale CLI is unusable over SSH (it belongs to another Windows user), so Tailscale state is read from this PC.

## Layout
`src/core.ts` ssh/docker/tailscale logic, routes, Forwarder, Offloader (offload, split, failover) · `src/balancer.ts` weighted TCP proxy · `src/setup.ts` wizard + self tests · `src/publicapi.ts` local API · `src/server.ts` the service (HTTP API + SSE, poller, tray, quit-restore) · `renderer/` UI (`ui.js` toolkit, `app.js` screens, `api.js` transport, `icon.svg`/`icon.ico`) · `test/e2e.ts` real end-to-end tests · `test/fakedocker.ts` scripted local engine.
Security: service and API bound to 127.0.0.1; per-run random token (cookie, HttpOnly, SameSite=Strict) plus Host/Origin checks for the UI; constant-time token compare for the API; whitelisted channels; strict CSP; all remote text inserted via `textContent`; host/user/container/address names validated before they reach a command line; no secrets beyond the API token; nothing listens on a public interface.

## Troubleshooting
| Symptom | Fix |
|---|---|
| Red / DOWN | Overview shows why (Tailscale offline, ssh refused, key rejected...) and a checklist. |
| "key was rejected" | Setup → Check shows the exact public key and where it belongs on that PC. |
| Docker panel "WSL is idle" | Wake, or enable keep awake. |
| `docker: not recognized` on `docker --context remote` | Setup → Check → create `docker.cmd`. |
| Split refused: "not reachable on <ip>:<port>" | The local container is published on 127.0.0.1 only; publish it on all addresses. |
| API 401 / 403 | Wrong token / control switch is off (API screen). |

## Apps (a group of programs and containers moved as one)

An **app** is a named list of parts: programs (added on the Programs screen) and/or Docker containers. Open **Apps**, press *New app*, add the parts in the order they should start, optionally give a part its own PC (or "this PC" to keep it here), and save.

- **Send all** moves every part to the chosen PC in order. It is all-or-nothing: if one part fails, the parts already moved are put back.
- **Bring back** runs every part on this PC again. **Plan** shows what Send would do without changing anything. **Test** checks every part's localhost port.
- Parts of one app on different PCs still reach each other on `localhost`: PC Bridge keeps a reverse link (`ssh -R`) from this PC to each PC that needs it. Nothing is exposed to the network.
- **Export** writes one `.pcbapp.json` file (parts, commands, ports; secret environment values are left out, the code itself is not inside). **Import** on another PC adds the programs and the app; you say which folder holds the program folders.
- Local API: `GET /api/v1/apps`, `/apps/{name}/plan`, `/apps/{name}/export`, `POST /apps`, `/apps/{name}/send`, `/apps/{name}/home`, `/apps/import`. Start with `GET /api/v1/info` (no token) or `/api/v1/guide`.

## Program options (register with `POST /api/v1/programs` or the Programs screen)

| Field | Meaning |
|---|---|
| `name`, `dir`, `cmd`, `port` | Required. `dir` is the folder on this PC, `cmd` is run inside it (on the other PC too), `port` is where it listens (same number on both PCs). |
| `env` | Extra environment variables. |
| `runtime` | `node` or `python` (guessed from the folder if left out). |
| `python` | Python version of the venv built on the other PC, e.g. `"3.13"` (default `3.12`; downloaded by `uv` under `<root>\python`). |
| `requirements` | File in the folder to install from instead of `requirements.txt` / `pyproject.toml`, e.g. `requirements.lock`. If a `pyproject.toml` exists the project itself is then installed with `--no-deps`. A pin that cannot be installed is named in the error. |
| `needs` | Ports of services that stay on this PC (for example a local LLM on `1234`); they answer on `localhost:<port>` on the other PC too, through a reverse tunnel. |
| `omitDev`, `ignoreScripts` | Node only: install without devDependencies / without dependency install scripts. |
| `pullExcludes` | Folders (e.g. `["data","models"]`) that **Bring back**, **Quit** and failover do not copy back from the other PC. They stay there; pushing them still works. |
| `requireFast` | Refuse before copying anything unless the copy can use the home network (see below). |
| `failover` | Start it on this PC again if the other PC dies (default on). |

**Push changes.** After you edit files of a program that already runs on another PC, `POST /programs/{name}/push` (or the *Push changes* button) sends only those files: no new full copy, no reinstall, no restart unless `{"restart": true}`.

**Closing PC Bridge.** *Quit* gives moved programs and containers a 10 minute grace period on the other PC. Open PC Bridge again within that time and nothing moves; otherwise everything comes back to this PC. Quit twice to bring things back immediately.

## Fast copies (home network)
Big copies use the other PC's LAN address when both PCs are on the same Wi-Fi/LAN (measured 43 MB/s against 2.5 MB/s through Tailscale), with a 3 hour limit instead of 15 minutes. They also use Git for Windows' `ssh` when it is installed (`Program Files\Git\usr\bin\ssh.exe`): on the tested PC Windows' own `ssh.exe` read a piped stream at only 0.2 MB/s, Git's at 30-88 MB/s. Untick *fast copy over the home network* in Setup to always use the main address.

## Running the tests
`npm test` is an **end-to-end** suite: it moves real test programs and containers to a real second PC. Tell it which PC to use:

```powershell
$env:PCB_REMOTE_NAME = "THE-OTHER-PC"   # its Windows computer name
$env:PCB_REMOTE_HOST = "100.x.y.z"      # its Tailscale (or LAN) address
$env:PCB_REMOTE_USER = "windows-user"   # its Windows user
npm test                                # about 10 minutes; run it while this PC is idle
```
`ONLY=<regex> npm test` runs just the tests whose name matches.
