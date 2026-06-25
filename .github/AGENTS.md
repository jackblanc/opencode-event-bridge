# CI Safety

Never use `pull_request_target` for CI or tests.

This repo uses deployment secrets. `pull_request_target` can expose those secrets to code from public forks. Use `pull_request` for untrusted PRs and keep fork PR workflows secret-free.
