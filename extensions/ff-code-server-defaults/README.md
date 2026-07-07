# FactFiber code-server Defaults

Single source of truth for shared code-server **default** settings and
keybindings across all hosts (silk, rayon, …).

## How it works

This is a **manifest-only** extension (no runtime code). It contributes:

- `contributes.configurationDefaults` — team default **settings**, applied at
  VS Code's **Default** layer (below User). So:
  - User settings override any default (personal/per-machine overrides win).
  - Deleting a key from the user `settings.json` **reverts to the team default**
    (VS Code's "Reset Setting" resets to *our* default, not vanilla).
- `contributes.keybindings` — team default **keybindings** (lower priority than
  the user `keybindings.json`).

Because defaults live here (tracked) and the live `settings.json`/
`keybindings.json` hold only user overrides (untracked), UI setting changes no
longer dirty the repo or block `git pull`.

## Changing a team default

1. Edit `contributes.configurationDefaults` / `contributes.keybindings` here.
2. Bump `version`.
3. Re-run `scripts/install-extension.sh` on each host (rebuilds + reinstalls
   into the shared extensions volume).
4. Reload the code-server window — users won't see the change until reload.

See `tmp/issues/settings-defaults/v2/plan.md` for the full design.
