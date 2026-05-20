# Local State

Machine-specific state required for local OpenCode access from the deployed Worker.

## OpenCode Private Address

The deployed Worker reaches local OpenCode through Workers VPC at:

```text
http://10.255.255.1:4096
```

This depends on a local loopback alias:

```bash
sudo ifconfig lo0 alias 10.255.255.1 255.255.255.255
```

Verify:

```bash
ifconfig lo0
curl http://10.255.255.1:4096/project
```

Remove if needed:

```bash
sudo ifconfig lo0 -alias 10.255.255.1
```

## OpenCode Server

OpenCode must bind to the private address:

```text
--hostname 10.255.255.1 --port 4096
```

Current local setup uses launchd service:

```text
com.jackblanc.opencode
```

The launchd config lives outside this repo in:

```text
/Users/jackblanc/projects/environment/modules/personal.nix
```

## Cloudflare Tunnel

The project tunnel must be running on this machine. The Worker VPC Service routes to the tunnel network, not to public tunnel ingress.

Run:

```bash
cloudflared tunnel run --token "$(pnpm exec alchemy state get OpenCodeEventBridge dev_$(whoami) OpenCodeTunnel | jq -r '.attr.token.__redacted__')"
```

Current tunnel/VPC details:

```text
Tunnel ID: 4d38d26d-64c2-4531-8212-722cde82da6a
VPC Service ID: 019e246b-bc1f-7453-a65e-152cf2da394d
Private route: 10.255.255.1/32 -> tunnel
```

Public tunnel ingress is intentionally `http_status:404`; OpenCode is not publicly exposed.

## macOS Firewall

macOS may prompt for inbound access when OpenCode first binds `10.255.255.1:4096`. Allow it, or Workers VPC may fail to connect.

## Not In Repo

These are not managed by this repository:

- `lo0` alias lifecycle.
- OpenCode launchd service.
- Running `cloudflared` process.
- macOS firewall permission.
