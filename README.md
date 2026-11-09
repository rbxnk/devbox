# devbox

A container for agentic coding on a home lab: Claude Code and [herdr](https://herdr.dev), reached over SSH or mosh (e.g. Moshi on an iPhone, through the host's Tailscale). Agents can reach the internet but not your LAN, your Tailscale devices or the host.

## What's in it
- `devbox`: Debian 13 with sshd, mosh, git and build tools. You log in as `dev`: key only, no password, no sudo. Claude Code and herdr install into `dev`'s home on the first start and update themselves from there.
- `lanblock`: a helper on the host's network that adds firewall rules to the host (`DOCKER-USER` and `INPUT`), dropping the devbox's traffic to 10/8, 172.16/12, 192.168/16, 100.64/10 (Tailscale) and 169.254/16. Replies to your incoming sessions still pass. The rules stay if it stops, and it re-adds them at each boot.
- Volumes: `home` (your work, Claude's login, the tools) and `hostkeys` (so the box keeps its SSH identity across rebuilds).

## Setup
Needs Docker with Compose on a Linux host using the iptables firewall backend (the default).

1. In Moshi, create a key and copy its public key.
2. On the host:
   ```sh
   git clone https://github.com/rbxnk/devbox && cd devbox
   echo 'ssh-ed25519 AAAA… moshi' > authorized_keys   # one public key per line
   docker compose up -d --build
   docker compose logs -f devbox                      # wait for "Server listening"
   ```
3. In Moshi, add a host: the home lab's Tailscale name or IP, port `2222`, user `dev`, your key, mosh on.
4. First login: run `claude` and sign in (open the link it prints on your phone). Then run `herdr`.

Check the isolation from inside the box, naming a couple of LAN IPs (your router, another machine):
```sh
check.sh 192.168.1.1 192.168.1.20
```
Every line should read `ok`.

## Notes
- Mosh uses UDP 60000–60010, one port per open session, so about 11 sessions at once. With herdr you rarely need more than one.
- SSH (2222) and mosh are published on all host interfaces. To allow only Tailscale, prefix the ports in `compose.yaml` with the host's Tailscale IP, e.g. `"100.x.y.z:2222:22"`.
- DNS goes to 1.1.1.1 and 9.9.9.9, because a resolver on your LAN or Tailscale would be blocked.
- Change the subnet with `DEVBOX_SUBNET` (in `.env`) if 172.30.99.0/24 clashes with something.
- CPU, memory and process limits are in `compose.yaml` (`cpus`, `mem_limit`, `pids_limit`).
- The box has no Docker socket and no git credentials. Add a GitHub token or deploy key yourself, scoped to what the agents need.
- After a host reboot Docker starts both containers at once, so the devbox can run for a few seconds before the rules are back. Only sshd is running then.
- To remove the rules from the host: `iptables -D DOCKER-USER -s 172.30.99.0/24 -j DEVBOX-FWD; iptables -D INPUT -s 172.30.99.0/24 -j DEVBOX-IN`.
