# devbox

A container for agentic coding on a home lab: Claude Code and [herdr](https://herdr.dev), reached over SSH or mosh (e.g. Moshi on an iPhone, through the host's Tailscale). Agents can reach the internet but not your LAN, your Tailscale devices or the host.

## What's in it
- `devbox`: Debian 13 with sshd, mosh, git, the GitHub CLI (`gh`), build tools and [mise](https://mise.jdx.dev). You log in as `dev`: key only, no password, no sudo.
- Claude Code, herdr and [moshi-hook](https://getmoshi.app/docs/hooks) install into `dev`'s home on the first start and update themselves from there. Each start also installs their Claude Code hooks: herdr's (agent state in its sidebar) and Moshi's (phone notifications and approvals), and keeps the Moshi daemon running.
- `lanblock.sh`: at each start, before sshd, sets firewall rules inside the box's own network namespace that drop its traffic to 10/8, 172.16/12, 192.168/16, 100.64/10 (Tailscale) and 169.254/16, which covers the host too. Replies to your incoming sessions still pass. The host's firewall isn't touched. If the rules can't be set, the box doesn't start. `dev` has no root, so it can't remove them.
- Data lives in host folders under `DEVBOX_DATA` (default `./data`, next to the compose file), outside Docker's storage: `home` is `dev`'s home folder (your work, Claude's login, the tools and their caches), `hostkeys` keeps the box's SSH identity across rebuilds, and `tmp` is its `/tmp`.

## Setup
Needs Docker with Compose on a Linux host.

1. In Moshi, create a key and copy its public key.
2. Deploy the stack:
   - **Dockhand:** add a Git stack from this repo (compose file `compose.yaml`), turn on **Build images on deploy**, and set the environment variable `AUTHORIZED_KEYS` to your public key. Deploy, then wait for `Server listening` in the devbox logs.
   - **Plain Compose:**
     ```sh
     git clone https://github.com/rbxnk/devbox && cd devbox
     echo "AUTHORIZED_KEYS=ssh-ed25519 AAAA… moshi" > .env
     docker compose up -d --build
     docker compose logs -f devbox   # wait for "Server listening"
     ```
   Several keys go in the same variable, separated by `;`. Change a key by editing it and redeploying.

   Optional: set `MOSHI_PAIRING_TOKEN` too (Moshi: Settings → Integrations) and the box pairs with the app on its first start. You can also pair later over SSH: `moshi-hook pair --store file --token …`, then restart the stack.
3. In Moshi, add a host: the home lab's Tailscale name or IP, port `2222`, user `dev`, your key, mosh on.
4. First login: run `claude` and sign in (open the link it prints on your phone), and `gh auth login` if agents should use GitHub. Then run `herdr`. `moshi-hook doctor` checks the Moshi side.

Check the isolation from inside the box, naming a couple of LAN IPs (your router, another machine):
```sh
check.sh 192.168.1.1 192.168.1.20
```
Every line should read `ok`.

## Installing tools
There's no sudo, so:
- Languages and CLIs: `mise use -g node@lts python go …`. They install into the home folder and survive rebuilds.
- Python tools: `uv tool install …` (get uv with `mise use -g uv`). Node tools: `npm i -g …` once Node is installed through mise.
- Single binaries: put them in `~/.local/bin`.
- System packages you always want: add them to the `apt-get install` list in the `Dockerfile`, then `docker compose up -d --build devbox`.
- A one-off package as root, from the host: `docker compose exec -u root devbox apt-get install -y PKG`. It's gone after the next rebuild.

mise itself updates when you rebuild the image.

## Notes
- Mosh uses UDP 60000–60010, one port per open session, so about 11 sessions at once. With herdr you rarely need more than one.
- SSH (2222) and mosh are published on all host interfaces. To allow only Tailscale, prefix the ports in `compose.yaml` with the host's Tailscale IP, e.g. `"100.x.y.z:2222:22"`.
- DNS goes to 1.1.1.1 and 9.9.9.9, because a resolver on your LAN or Tailscale would be blocked.
- Set `DEVBOX_DATA` to an absolute path to keep the data elsewhere. As a Dockhand Git stack, `./data` sits inside Dockhand's clone of the repo (git ignores it); check once that a redeploy leaves it in place.
- Files in `DEVBOX_DATA` are owned by uid 99 and gid 100, Unraid's `nobody:users`. On another host, set `DEV_UID` and `DEV_GID` (in Dockhand's environment or `.env`) to your user's ids, e.g. 1000 (not 0: that would make `dev` root, and the build refuses it).
- Change the subnet with `DEVBOX_SUBNET` if 172.30.99.0/24 clashes with something.
- `/tmp` isn't cleared on restart; empty `$DEVBOX_DATA/tmp` yourself if it grows. Root installs still go in Docker's storage (a rebuild clears them), and `docker builder prune` frees old build cache.
- CPU, memory and process limits are in `compose.yaml` (`cpus`, `mem_limit`, `pids_limit`).
- The box has no Docker socket and no git credentials. Sign `gh` in with a token scoped to what the agents need (`gh auth login`, then `gh auth setup-git` so `git` uses it too).
