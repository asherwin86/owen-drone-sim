# Drone Sim multiplayer relay

A tiny WebSocket server. It shows every player where the other drones are, what
delivery they are on, and carries the chat. Each player's game still runs on their
own computer, so the server needs very little power (any old PC is fine).

## Get the image from GitHub

Every push builds and publishes the image to GitHub Container Registry:

```bash
docker pull ghcr.io/asherwin86/drone-sim-relay:latest
docker run -d --restart unless-stopped -p 47832:47832 --name drone-sim-relay ghcr.io/asherwin86/drone-sim-relay:latest
```

(`:latest` is the master branch; `:multiplayer` is the in-progress branch.) If the pull says
"denied", the package is still private: on GitHub open your profile -> Packages ->
`drone-sim-relay` -> Package settings -> Change visibility -> Public, or `docker login ghcr.io`
with a GitHub token that has `read:packages`.

## Run it (Docker, from source)

From this `relay` folder, on the computer that will host:

```bash
docker compose up -d --build
```

It listens on port **47832**. Check it: open `http://localhost:47832/health`.

Without Compose: `docker build -t drone-sim-relay .` then
`docker run -d --restart unless-stopped -p 47832:47832 --name drone-sim-relay drone-sim-relay`.

## Let people connect from other networks

Pick ONE:

### A) Cloudflare Tunnel (easiest, free, no router changes)

```bash
docker compose --profile tunnel up -d --build
docker compose logs tunnel
```

Find the line with `https://<random-words>.trycloudflare.com`. Players open
**Settings** in the game and set **Multiplayer server** to
`wss://<random-words>.trycloudflare.com` (note `wss://`, no port).

The address changes whenever the tunnel container restarts. For a permanent
address, use a free Cloudflare account + a domain and a named tunnel
(`cloudflared tunnel run`), or option B/C.

### A2) Permanent address: port forward + DuckDNS (free)

1. Sign in at https://www.duckdns.org (Google/GitHub login), type a name, press **add domain**
   (say `owendrones` -> `owendrones.duckdns.org`) and copy your **token**.
2. On the host, in this `relay` folder: copy `.env.example` to `.env` and fill in the name and token.
3. `docker compose --profile duckdns up -d` (starts the relay AND the DuckDNS updater).
4. Windows firewall (admin PowerShell):
   `New-NetFirewallRule -DisplayName "Drone Sim relay" -Direction Inbound -Protocol TCP -LocalPort 47832 -Action Allow`
5. Router: give the host a fixed LAN IP (DHCP reservation), then forward **TCP 47832 -> that IP:47832**.
6. Test from another network (phone on mobile data): `http://owendrones.duckdns.org:47832/health`.
7. Players use `ws://owendrones.duckdns.org:47832` (plain ws, no TLS; the game only sends positions and chat).

If step 6 fails: your router's WAN IP may differ from your public IP (carrier-grade NAT). Then port
forwarding cannot work; use Tailscale Funnel or a Cloudflare named tunnel instead.

### B) Tailscale (free, private, great for friends)

Install Tailscale on the host and on each player's computer (same Tailnet, or share
the host machine with them). Players use `ws://<host-tailscale-name-or-100.x.x.x>:47832`.

### C) Port forwarding (classic)

In your router forward TCP **47832** to the host computer, allow it in the Windows
firewall, and give players `ws://<your-public-IP>:47832` (use a dynamic-DNS name if your
IP changes). Anyone on the internet can then reach the port, so only do this if you are happy
with that. A and B are safer.

## In the game

Settings -> **Pilot name** and **Multiplayer server**, then Save. The **Online** tab
lists pilots; press **Enter** while flying to chat.

## Settings (environment variables)

| Name | Default | Meaning |
| --- | --- | --- |
| `PORT` | 47832 | port to listen on |
| `MAX_PLAYERS` | 100 | extra players are turned away |

The server keeps nothing on disk: no accounts, no saves, just the last 40 chat lines in memory.
