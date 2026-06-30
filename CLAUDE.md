# Active Issues and Projects - code-server-proxy

## Current Sprint Status

**Project**: {{PROJECT_NAME}}
**Status**: Development

## Deployment Scope

**All fixes must work on, and be deployed to, every installation
(currently `silk` and `rayon`) unless explicitly scoped otherwise.**
The installations are kept in sync so they behave identically.

What this means in practice:

- Code must stay **host-agnostic** — no host-specific paths, tailnet
  IPs, or hostnames baked into source. Use `localhost` /
  `host.docker.internal` and config, never a single host's address.
- Git-tracked changes propagate by `git pull` on each host, but
  **side effects do not**: Docker images (rebuild per host),
  marketplace/custom extensions installed into the host-local
  `code-server-extensions` volume (re-run the install scripts per
  host), and running instances (restart per host). Docker volumes are
  per-daemon, so a volume install on one host never reaches another.
- A fix is not "deployed" until it is live on **both** hosts. When a
  change is intentionally host-scoped, say so explicitly and record
  why on the bead.

### How to deploy

After pushing a change to `main`, deploy it everywhere with:

```bash
scripts/deploy-all.sh            # deploy to all hosts (no restart)
scripts/deploy-all.sh --restart  # also restart proxy + instances
```

`deploy-all.sh` runs `scripts/deploy.sh` on each host (locally for the
current host, over SSH for the rest). `deploy.sh` is the idempotent
per-host unit: it pulls, rebuilds the image if `docker/` changed,
reinstalls the custom extension if `extensions/` changed, and installs
the marketplace extensions from `scripts/install-marketplace-extensions.sh`.
Restart is opt-in (`--restart`) because it interrupts active sessions;
without it, reload code-server windows to pick up new extensions. To add
a marketplace extension to every install, add its Open VSX id to the
`EXTENSIONS` list in `install-marketplace-extensions.sh`, then deploy.

## Active Tasks

Track current work using beads (`bd list --status=in_progress`).

## Issue Tracking Guidelines

**tmp/issues is for local planning and investigation.** Use beads for
task tracking.

### Local Planning (tmp/issues/)

1. **Feature Planning**: Create subdirectories for complex features
2. **Investigation**: Document problem analysis in feature subdirectories
3. **Quick Notes**: Use this file for session context

### Beads Integration

- Use `bd create` to track actionable work
- Reference planning docs in issue descriptions
- Use `bd close --reason="..."` to document completion
