# Local State

Machine-specific state required for local OpenCode access from the deployed Worker.

## OpenCode Server

The deployed Worker reaches local OpenCode through Workers VPC at:

```text
http://127.0.0.1:4096
```

Run OpenCode on the normal loopback address:

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

Verify:

```bash
curl http://127.0.0.1:4096/project
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
Private route: 127.0.0.1/32 -> tunnel
```

Public tunnel ingress is intentionally `http_status:404`; OpenCode is not publicly exposed.

## Not In Repo

These are not managed by this repository:

- Running `cloudflared` process.
