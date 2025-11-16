#!/bin/bash
set -euo pipefail

INSTANCES_DIR="$HOME/.code-workspaces/instances"
ARCHIVES_DIR="$HOME/.code-workspaces/archives"
IDLE_THRESHOLD_DAYS=3
LOG_PREFIX="[workspace-idle-monitor]"

# Create archives directory if needed
mkdir -p "$ARCHIVES_DIR"

log() {
    echo "$LOG_PREFIX $(date -Iseconds): $*"
}

# Get current timestamp in seconds
NOW=$(date +%s)

log "Starting idle workspace monitor"

# Check if instances directory exists
if [ ! -d "$INSTANCES_DIR" ]; then
    log "Instances directory does not exist: $INSTANCES_DIR"
    exit 0
fi

# Iterate through instance directories
for instance_dir in "$INSTANCES_DIR"/*; do
    [ -d "$instance_dir" ] || continue
    
    instance_name=$(basename "$instance_dir")
    
    # Skip main instance
    if [ "$instance_name" = "main" ]; then
        log "Skipping main instance"
        continue
    fi
    
    # Check for last-access file
    last_access_file="$instance_dir/last-access"
    if [ ! -f "$last_access_file" ]; then
        log "Warning: No last-access file for $instance_name, using directory mtime"
        # Fall back to directory modification time if last-access file doesn't exist
        last_access_seconds=$(stat -c %Y "$instance_dir")
    else
        # Read last access timestamp
        last_access=$(cat "$last_access_file")
        last_access_seconds=$(date -d "$last_access" +%s 2>/dev/null || echo "0")
        
        if [ "$last_access_seconds" = "0" ]; then
            log "Warning: Invalid timestamp in last-access file for $instance_name, using directory mtime"
            last_access_seconds=$(stat -c %Y "$instance_dir")
        fi
    fi
    
    # Calculate idle days
    idle_seconds=$((NOW - last_access_seconds))
    idle_days=$((idle_seconds / 86400))
    
    log "$instance_name: idle for $idle_days days"
    
    if [ $idle_days -gt $IDLE_THRESHOLD_DAYS ]; then
        log "Stopping idle instance: $instance_name (idle: $idle_days days)"
        
        # Stop systemd service (ignore errors if already stopped)
        systemctl --user stop "code-server-workspace@$instance_name.service" 2>/dev/null || true
        
        # Create archive
        archive_name="${instance_name}-$(date +%Y%m%d-%H%M%S).tar.gz"
        archive_path="$ARCHIVES_DIR/$archive_name"
        
        log "Archiving $instance_name to $archive_path"
        tar -czf "$archive_path" -C "$INSTANCES_DIR" "$instance_name"
        
        # Remove instance directory
        log "Removing instance directory: $instance_dir"
        rm -rf "$instance_dir"
        
        log "Completed cleanup of $instance_name"
    fi
done

log "Idle workspace monitor completed"