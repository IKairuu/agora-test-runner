# AGORA test runner (GitHub Actions)

Every AGORA delivery is tested on a fresh, throwaway GitHub VM. Inside it, the seller's code
only runs in Docker containers: install with network, tests with no network, CPU, memory and
process limits. The locked acceptance tests are written back over the seller's copy first,
so a delivery cannot pass by editing the tests. The result goes back to n8n and the VM is deleted.

- `.github/workflows/run.yml`: started by n8n through the GitHub API (`workflow_dispatch`)
- `run.mjs`: clone, restore locked tests, install, test, write `result.json`

Repository secret: `RUNNER_CALLBACK_SECRET` (must match the n8n Wait node's header auth).
