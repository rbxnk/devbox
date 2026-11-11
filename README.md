# devbox

A container for agentic coding on a home lab: Claude Code and [herdr](https://herdr.dev), reached over SSH or mosh (e.g. Moshi on an iPhone, through the host's Tailscale). Agents can reach the internet but not your LAN, your Tailscale devices or the host.

## What's in it
- `devbox`: Debian 13 with sshd, mosh, git, the GitHub CLI (`gh`), build tools, Go, Node (LTS, with npm), Python 3 with `uv`, `flyctl` and [mise](https://mise.jdx.dev). You log in as `dev`, with an SSH key, a password (`DEV_PASSWORD`, optional) or both. There's no sudo.
- Claude Code, herdr (the TUI), [herdr-core](https://herdr.dev/mobile/) (`hc`) and [moshi-hook](https://getmoshi.app/docs/hooks) install into `dev`'s home on the first start and update themselves from there. Each start also installs their Claude Code hooks: herdr's (agent state in its sidebar) and Moshi's (phone notifications and approvals), and keeps the herdr-core server and the Moshi daemon running. herdr-core is what the herdr mobile and desktop apps connect to, over SSH.
- `lanblock.sh`: at each start, before sshd, sets firewall rules inside the box's own network namespace that drop its traffic to 10/8, 172.16/12, 192.168/16, 100.64/10 (Tailscale) and 169.254/16, which covers the host too. Replies to your incoming sessions still pass. The host's firewall isn't touched. If the rules can't be set, the box doesn't start. `dev` has no root, so it can't remove them.
- Data lives in host folders under `DEVBOX_DATA` (default `./data`, next to the compose file), outside Docker's storage: `home` is `dev`'s home folder (your work, Claude's login, the tools and their caches), `hostkeys` keeps the box's SSH identity and machine ID across rebuilds (herdr-core's identity, and so the herdr apps' view of the box, follows the machine ID), and `tmp` is its `/tmp`.

## Setup
Needs Docker with Compose on a Linux host.

1. In Moshi, create a key and copy its public key.
2. Deploy the stack:
   - **Dockhand:** add a Git stack from this repo (compose file `compose.yaml`), and set the environment variable `AUTHORIZED_KEYS` to your public key. Deploy, then wait for `Server listening` in the devbox logs.
   - **Plain Compose:**
     ```sh
     git clone https://github.com/rbxnk/devbox && cd devbox
     echo "AUTHORIZED_KEYS=ssh-ed25519 AAAA… moshi" > .env
     docker compose up -d --build
     docker compose logs -f devbox   # wait for "Server listening"
     ```
   For password login, set `DEV_PASSWORD` too (or instead of the key). Several keys go in the same variable, separated by `;`. Change a key by editing it and redeploying.

   Optional: set `MOSHI_PAIRING_TOKEN` too (Moshi: Settings → Integrations) and the box pairs with the app on its first start. You can also pair later over SSH: `moshi-hook pair --store file --token …`, then restart the stack.
3. In Moshi, add a host: the home lab's Tailscale name or IP, port `2222`, user `dev`, your key, mosh on.
4. First login: run `claude` and sign in (open the link it prints on your phone), and `gh auth login` if agents should use GitHub. Then run `herdr`. `moshi-hook doctor` checks the Moshi side.
5. Herdr app: add this box as a machine (the same host, port and user). It can sign in with the password and then add its own key to `~/.ssh/authorized_keys`, which sshd accepts.

Check the isolation from inside the box, naming a couple of LAN IPs (your router, another machine):
```sh
check.sh 192.168.1.1 192.168.1.20
```
Every line should read `ok`.

## The herdr PWA
`pwa/` is a phone-first web app for herdr-core, served from the box on port 8787: your spaces and their terminals, a chat view of Claude Code sessions (with its permission prompts, questions and suggested next prompt), a real terminal (Ghostty), each space's git changes, worktrees, and push notifications when an agent needs you or finishes.

1. Point a reverse proxy at `http://<host>:8787`, with HTTPS (a PWA needs it to install and to notify) and WebSocket upgrades passed through. Don't let it buffer responses on `/api/chat`, which is a stream.
2. Open the site and paste the token: `cat ~/.config/herdr-pwa/token` in the box. It is asked for once per browser.
3. For notifications, turn them on at the bottom of the list. On an iPhone, first add the site to the home screen and open it from there.

What to know:
- The token is the only lock, and whoever has it can run commands as `dev`. It is made on the first start; delete the file and restart the stack for a new one. Agents in the box can read it, like everything else `dev` owns.
- Port 8787 is published on all host interfaces, as plain HTTP. If the proxy runs on the same host, publish it to that host only: `"127.0.0.1:8787:8787"` in `compose.yaml`. `PWA_PORT` changes the host port.
- Spaces are shared with the herdr apps (the same `herdr-app` document in herdr-core), so a space or worktree made in one shows in the others. Worktrees go to `~/.herdr/worktrees/<repo>/<branch>`, as the desktop app makes them.
- The bridge adds one `PermissionRequest` hook to `~/.claude/settings.json`, next to herdr's and Moshi's, so Claude Code's prompts can be answered from the chat. A prompt answered in the terminal or in Moshi works as before. While the bridge is down, Claude Code notes that the hook failed and carries on.
- The chat view reads Claude Code's own session files, which have no published format: a Claude Code update can break it until the adapter (`pwa/server/chat.ts`) follows. The terminal view always works.
- If pushes to an iPhone are refused, set a contact Apple accepts: add `"subject": "mailto:you@example.com"` to `~/.config/herdr-pwa/push.json` and restart.
- To work on it: `cd pwa && npm install && npm test && npm run build && npm start`. `/tmp/herdr-pwa.log` has the running bridge's output.

## Installing tools
There's no sudo, so:
- Go, Node, Python, `uv` and `flyctl` are in the image; a rebuild updates them. For another version or language: `mise use -g node@22 rust …`. mise's versions install into the home folder, survive rebuilds and come first on the PATH.
- Python tools: `uv tool install …`, and `uv` or a venv for projects (plain `pip install` outside a venv is blocked on Debian). Node tools: `npm i -g …` (goes to `~/.local`). Go tools: `go install …` (goes to `~/go/bin`).
- Single binaries: put them in `~/.local/bin`.
- System packages you always want: add them to the `apt-get install` list in the `Dockerfile`, then `docker compose up -d --build devbox`.
- A one-off package as root, from the host: `docker compose exec -u root devbox apt-get install -y PKG`. It's gone after the next rebuild.

mise, Go, Node, uv and flyctl update when you rebuild the image. Sign `fly` in with `fly auth login`; its login is kept in the home folder.

## Notes
- The image's Node runs the herdr PWA's bridge (`/usr/bin/node`), whatever version mise puts first on your PATH.
- Mosh uses UDP 60000–60010, one port per open session, so about 11 sessions at once. With herdr you rarely need more than one.
- SSH (2222) and mosh are published on all host interfaces, so with `DEV_PASSWORD` set anyone on your LAN can try passwords: use a long one. To allow only Tailscale, prefix the ports in `compose.yaml` with the host's Tailscale IP, e.g. `"100.x.y.z:2222:22"`.
- DNS goes to 1.1.1.1 and 9.9.9.9, because a resolver on your LAN or Tailscale would be blocked.
- Set `DEVBOX_DATA` to an absolute path to keep the data elsewhere. As a Dockhand Git stack, `./data` sits inside Dockhand's clone of the repo (git ignores it); check once that a redeploy leaves it in place.
- Files in `DEVBOX_DATA` are owned by uid 99 and gid 100, Unraid's `nobody:users`. On another host, set `DEV_UID` and `DEV_GID` (in Dockhand's environment or `.env`) to your user's ids, e.g. 1000 (not 0: that would make `dev` root, and the build refuses it).
- Change the subnet with `DEVBOX_SUBNET` if 172.30.99.0/24 clashes with something.
- `/tmp` isn't cleared on restart; empty `$DEVBOX_DATA/tmp` yourself if it grows. Root installs still go in Docker's storage (a rebuild clears them), and `docker builder prune` frees old build cache.
- CPU, memory and process limits are in `compose.yaml` (`cpus`, `mem_limit`, `pids_limit`).
- sshd accepts keys from `AUTHORIZED_KEYS` and from `~/.ssh/authorized_keys`. Agents can write the second one too, so an agent could add a key of its own; check it now and then.
- The box has no Docker socket and no git credentials. Sign `gh` in with a token scoped to what the agents need (`gh auth login`, then `gh auth setup-git` so `git` uses it too).
