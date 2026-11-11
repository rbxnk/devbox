# herdr PWA: plan

A phone-first PWA for the `herdr-core` (`hc`) server in this box: a spaces sidebar, a Claude-mobile-style chat for agent sessions, a real terminal, diffs and worktrees. It lives in `pwa/` in this repo and ships in the devbox image.

## Decisions

| Topic | Decision |
|---|---|
| Target | `herdr-core` only. The `herdr` TUI server is out of scope. |
| Network | The host's existing reverse proxy terminates TLS and forwards to the bridge. Proxy setup is out of scope. |
| Auth | The bridge's own token, entered once in the PWA, required on every request and WebSocket. |
| Chat source | Each agent's own transcript files, behind a per-agent adapter. Claude Code first. |
| Prompts | Native Allow/Deny buttons and option lists; fall back to a live terminal card when the prompt can't be understood. |
| Suggested next prompt | A chip above the composer when the agent is idle. Tap fills the composer; it never sends by itself. |
| Push | Web Push when a session becomes blocked or done. In v1. |
| Spaces | Shared with the herdr apps: read and write the `herdr-app` hc document. |
| Worktrees | Same as the desktop app: a worktree is an ordinary space at `~/.herdr/worktrees/<repo>/<branch>`, named after its branch, nested under its main checkout's space (nesting comes from `git worktree list`, nothing is stored). Offered only when the space's folder is in a git repo. |
| Devices | Phone first. Wide screens get a sidebar but still one pane at a time. Split layouts in the document are kept intact, never flattened. |
| Front end | Vite + Preact + TypeScript. |
| Terminal | Ghostty, through `ghostty-web` (WASM). |
| Bridge | One Node TypeScript server: serves the built PWA, proxies hc, reads transcripts, sends push. |

## Features

- **Spaces sidebar**: spaces, tabs, worktree nesting, live status per session (working, idle, blocked, done, finished), unseen markers.
- **Chat view** (default for Claude Code sessions): messages with markdown, tool cards, inline diffs, composer, image attach, tap a file path to view the file read-only.
- **Terminal view** (every session; the only view for non-agent sessions): Ghostty on the raw stream, quick-key bar (esc, tab, arrows, ctrl+c, enter), resize to the phone.
- **Diff viewer** per space: uncommitted changes, and branch against its base, with a toggle.
- **New session**: Claude Code or a shell in a space, as a new tab.
- **Worktrees**: new, open existing, remove (linked ones only, asks once).
- **Other machines**: spaces and sessions on machines this core has added, through hc's `on` routing.
- **Push notifications**: blocked and done; tapping one opens that session.

Not in v1: real split panes on wide screens, file editing, managing machines (add/remove/login), templates, agents other than Claude Code in chat view.

## Architecture

```
phone ──HTTPS──▶ host reverse proxy ──HTTP/WS :8787──▶ bridge (Node, as dev) ──▶ hc unix socket
                                                              ├─▶ ~/.claude transcripts
                                                              └─▶ push services (outbound)
```

**Bridge endpoints** (all need the token, except the hook):

- `WS /ws`: the token in the first message, then hc's own framed protocol, one `hc connect` per socket. The browser speaks hc directly: RPC, events and attach streams all go through it. The bridge only checks which methods are called. Not allowed: `hello`, `server.stop`, `server.restart`, `machine.add`, `machine.rm`, `machine.rename`, `machine.exec`, `file.write`, `file.edit`.
- `GET /api/chat?pid=`: a stream of chat items from the Claude Code transcript of that process, plus what it is asking right now.
- `POST /api/answer`: answers a waiting permission request or question.
- `POST /api/git`: `repo`, `checkouts`, `changes`, `worktree-add`, `dirty`, `worktree-remove`. Fixed git argv built by the bridge (the same commands the desktop app runs), on the space's machine.
- `GET`/`POST /api/push`: the public key; subscribe and unsubscribe.
- `POST /hook/ask`: Claude Code's `PermissionRequest` hook. Loopback only, no token.
- Files are read with hc's `file.read` and images sent with `terminal.put`, both through `/ws`.

**State**, in `~/.config/herdr-pwa/` (mode 600): `token` (made on first start), VAPID keys, push subscriptions. The bridge watches hc events itself, so push works with no client open.

**Chat data for Claude Code**: hc gives the terminal's foreground pid; `~/.claude/sessions/<pid>.json` names the session; the transcript is `~/.claude/projects/<cwd-slug>/<session>.jsonl`, tailed. Other machines need the same files read through `file.read` with `on`.

**Prompts**: Claude Code POSTs each permission request, question and plan approval to `/hook/ask` (an http `PermissionRequest` hook the bridge adds to `~/.claude/settings.json`) and waits, with its own dialog on screen meanwhile. The chat shows it as native buttons; the answer goes back as the hook's decision. Claude Code leaves the request open when the dialog is answered in the terminal, so the bridge watches the transcript and drops a request once its tool call has a result. A blocked session with no request (a dialog the hook doesn't cover) gets a button to the terminal.

**Suggested next prompt**: read off the screen with `terminal.read` a moment after a turn ends: the text in Claude Code's input box.

**Auth details**: token compared in constant time; sent as a bearer header for HTTP and in the first WebSocket message, never in a URL. The PWA keeps it in `localStorage`. Agents in the box already run as `dev` and can read it; the token protects against the network, not against them.

## Image changes

- `Dockerfile`: a build stage runs `npm ci && npm run build` in `pwa/`; the result is copied to `/opt/herdr-pwa`. `EXPOSE 8787`.
- `entrypoint.sh`: a third keep-alive loop as `dev`, next to `herdr-core serve`: `node /opt/herdr-pwa/server.js`.
- `compose.yaml`: publish `${PWA_PORT:-8787}:8787`.
- `README.md`: how to point the proxy at it (WebSocket upgrade needed), where to read the token, install to home screen for push on iOS.
- `lanblock.sh` needs no change: replies to incoming connections pass, and push services are on the internet.

## Build order

Each step ends with something usable.

1. **Bridge and terminal.** Token auth, `/rpc`, `/events`, `/attach`; a bare page with a session list and a Ghostty terminal. Proves `ghostty-web` and hc's framed attach protocol, the two biggest unknowns.
2. **Spaces sidebar.** Read and write the `herdr-app` document with version checks (`doc.set` refuses stale versions); live status; unseen markers. PWA manifest and service worker.
3. **Chat view.** Claude Code adapter, message and tool rendering, composer through `terminal.send`.
4. **Prompts and suggestion chip.** Hook route first, screen parser as fallback, terminal card as last resort.
5. **New session, worktrees, diff viewer, file viewer, image attach.**
6. **Push.**
7. **Other machines.**
8. **Image changes and README.**

## Testing

- Bridge: `node --test` against the real hc socket in this box (start a shell terminal, attach, send, read, kill), plus unit tests for the transcript adapter and prompt parser using recorded transcripts and screens as fixtures.
- Front end: component tests for chat rendering from the same fixtures.
- On a phone: needs the port published and the proxy pointed at it, which means a redeploy from the host. Until then only the bridge and a local build can be checked from inside the box.

## Risks

- **Undocumented formats.** The `herdr-app` document, Claude Code's transcripts and `~/.claude/sessions` can change with any update. Each is read in one module, tolerates unknown fields, and writes back everything it didn't understand.
- **Writing a shared document.** Two apps editing spaces at once: always write with the version read, retry on conflict, never write a document that failed to parse.
- **Prompt parsing.** The most fragile piece; a Claude Code restyle can break buttons or hide the suggestion. The terminal card fallback keeps the session answerable.
- **`ghostty-web` maturity.** If it can't handle the stream or mobile input well, step 1 finds out before anything depends on it.
- **Exposure.** The bridge is a shell-equivalent door into the box. Token only, no cookie, method allowlist, fixed git argv.

## Status

Built and checked in a headless browser against the live hc: steps 1 to 6 and 8. What was not possible to check from inside the box:

- **On a real phone**: touch, the on-screen keyboard in the terminal, install to the home screen.
- **Push delivery**: the rules, keys and subscriptions are tested; an actual push needs HTTPS and a real browser subscription.
- **Other machines** (step 7): spaces, terminals, git and files are routed with hc's `on` throughout, but this core has no machines added, so none of it has run. Chat and prompts are for sessions on this machine only.
- **The image build**: the build stage's commands were run by hand in a clean copy; `docker build` was not.
- **ExitPlanMode** and multi-select questions: built from the documented hook format, not exercised.

Learned on the way:

- `PermissionRequest` fires for tool permissions and for `AskUserQuestion` alike, with the dialog already on screen. A held `PreToolUse` hook, by contrast, keeps the dialog from appearing, so it is not used.
- hc's framed protocol is documented in herdr-core's `schema/README.md`; the spaces document and the `herdr.seen` label in herdr-app's `src/mirror.rs` and `docs/labels.md`.
- Attaching makes the phone the terminal's size for every viewer, as with the herdr apps. The chat view does not attach.
