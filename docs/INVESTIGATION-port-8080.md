# Investigation: Persistent code-server on Port 8080

## Problem Statement

A `code-server-with-keyring` process keeps spawning on port 8080 (127.0.0.1:8080) on the host system. When killed, it respawns within seconds. This conflicts with workspace shells trying to run `code-server` commands directly.

## Timeline

- **Nov 17**: Original orphaned process (PID 1994, 2204) started - ran for 7 days
- **Nov 24 09:15**: User killed old process; new process spawned immediately (PID 1826427, 1826452)
- **Nov 24 09:21**: Killed second process; third process spawned within seconds (PID 1841762, 1841787)

## Process Characteristics

```
UID          PID    PPID  C STIME TTY          TIME CMD
shauncu+ 1841762       1  0 09:21 ?        00:00:00 /usr/lib/code-server/lib/node /usr/lib/code-server
shauncu+ 1841787 1841762  1 09:21 ?        00:00:00 /usr/lib/code-server/lib/node /usr/lib/code-server/out/node/entry
```

- **Parent process**: PID 1 (systemd) - indicates launcher process exited
- **Binary**: `/usr/lib/code-server/lib/node`
- **Journal name**: `code-server-with-keyring`
- **Port binding**: 127.0.0.1:8080
- **Config**: `/home/shauncutts/.config/code-server/config.yaml`
- **Respawn time**: <10 seconds after kill

## Investigations Completed

### ✓ Ruled Out

1. **systemd User Services**
   - `code-server.service`: disabled, inactive (dead)
   - `code-server-proxy.service`: enabled, running (different port)
   - No socket/path activation units found
   - No other code-server-related services

2. **Cron Jobs**

   ```bash
   crontab -l | grep code-server  # No matches
   ```

3. **systemd Timers**
   - Only `workspace-idle-monitor.timer` active (unrelated)

4. **Autostart Desktop Files**
   - No code-server entries in:
     - `~/.config/autostart/`
     - `/etc/xdg/autostart/`
     - `~/.local/share/applications/`

5. **Shell Profile Auto-execution**
   - Checked `.bashrc`, `.bash_profile`, `.profile`, `.zshrc`
   - Found aliases but no auto-start commands

6. **Screen/tmux Sessions**
   - No persistent sessions found

7. **Process Monitoring Tools**
   - No supervisor, monit, or similar tools detected

8. **Mutagen**
   - Running but only as forwarder (not spawning code-server)

### ⚠️ Suspicious Findings

1. **code-server-with-keyring wrapper** (`~/.local/bin/code-server-with-keyring`)
   - Loads D-Bus session
   - Auto-unlocks keyring
   - Execs `/usr/bin/code-server`
   - **Question**: What calls this wrapper?

2. **System State**
   - 23 active login sessions
   - 53 terminal sessions (w command)
   - Multiple Docker containers with code-server instances
   - High number of background processes

3. **Respawn Pattern**
   - Immediate respawn after kill suggests active monitoring/restart mechanism
   - Parent exits immediately (PPID=1) suggests launcher script

## Not Yet Investigated

1. **Active Terminal Sessions**
   - 23 login sessions, 53 terminals active
   - Could be a watch loop or monitoring script in one of them
   - Need to check: `ps auxf | grep -A10 -B10 code-server` for full process tree

2. **inotify/File Watchers**
   - Could be monitoring `/proc`, port availability, or socket file
   - Check: `lsof | grep inotify`

3. **systemd User Manager Environment**
   - Something setting PATH to include `~/.local/bin` first
   - Check: `systemctl --user show-environment`

4. **Desktop Environment Integration**
   - GNOME Shell extensions or session management
   - Check: `gnome-extensions list`

5. **Login Manager Hooks**
   - GDM/LightDM session scripts
   - Check: `/etc/gdm3/`, `~/.xsessionrc`

6. **Keyring/Secret Service Integration**
   - `gnome-keyring-daemon` override may trigger code-server
   - Check: `~/.config/systemd/user/gnome-keyring.service.d/override.conf`

7. **Init System Lingering**
   - User services can run without login
   - Check: `loginctl show-user shauncutts`

8. **Package Post-Install Hooks**
   - Code-server package may have enabled auto-start
   - Check: `/var/lib/dpkg/info/code-server.*`

## Potential Root Causes

### Theory 1: Hidden Session Script

- One of 23 sessions running a monitoring loop
- Checking if port 8080 is available and starting code-server
- **Test**: Kill all terminal sessions and observe

### Theory 2: Desktop Environment Integration

- GNOME session manager or extension auto-starting code-server
- **Test**: Check GNOME Shell extensions and session files

### Theory 3: Keyring Service Dependency

- `gnome-keyring.service` override may trigger code-server
- Restart mechanism tied to keyring availability
- **Test**: Disable keyring override and observe

### Theory 4: Package Configuration

- Code-server package has auto-start enabled at user level
- Not visible in standard systemd unit files
- **Test**: Check package-specific configuration

## Workarounds

### Temporary Solution

```bash
# Change binding address in config to avoid conflict
sed -i 's/bind-addr: 127.0.0.1:8080/bind-addr: 127.0.0.1:18080/' ~/.config/code-server/config.yaml
killall -u shauncutts node  # Kill existing code-server
```

### IDE File Opener (Separate Solution)

Create a workspace command that opens files in browser IDE without spawning new server.
See implementation in next section.

## Next Steps

1. Implement IDE file opener command (independent of this issue)
2. Monitor all active terminal sessions for code-server spawns
3. Check GNOME session integration
4. Review keyring service integration
5. Consider changing port in config as workaround

## Related Files

- `/home/shauncutts/.local/bin/code-server-with-keyring` - Wrapper script
- `/home/shauncutts/.config/code-server/config.yaml` - Config file
- `/usr/lib/systemd/user/code-server.service` - Disabled service
- `/home/shauncutts/.config/systemd/user/gnome-keyring.service.d/override.conf` - Keyring override

## Commands for Further Investigation

```bash
# Check all terminal session processes
for session in $(loginctl list-sessions --no-legend | awk '{print $1}'); do
  echo "=== Session $session ==="
  loginctl show-session $session
done

# Find all processes with code-server in command line
ps auxf | grep -E '[c]ode-server|[g]nome-keyring'

# Check inotify watchers
find /proc/*/fd -lname 'anon_inode:inotify' 2>/dev/null | wc -l

# Monitor for new code-server spawns
while true; do
  ps aux | grep '[c]ode-server-with-keyring'
  sleep 1
done
```

---

**Investigation Date**: 2025-11-24
**Status**: Ongoing - root cause not identified
**Priority**: Medium (workaround available)
