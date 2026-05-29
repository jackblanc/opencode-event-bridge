# Run Observer for OpenCode Events

OpenCode events are processed by a Cloudflare Durable Object run observer, not an OpenCode plugin. This keeps V2 Cloudflare-native and gives each OpenCode run one serialized observer while avoiding V1's separate plugin runtime and duplicated state.
