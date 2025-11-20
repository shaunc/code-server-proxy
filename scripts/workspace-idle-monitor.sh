#!/bin/bash
set -euo pipefail

# Configuration
INSTANCES_DIR="$HOME/.code-workspaces/instances"
ARCHIVES_DIR="$HOME/.code-workspaces/archives"
VOLUMES_DIR="$HOME/.code-workspaces/volumes"
IDLE_THRESHOLD_DAYS="${IDLE_THRESHOLD_DAYS:-3}"
IDLE_GRACE_PERIOD_DAYS="${IDLE_GRACE_PERIOD_DAYS:-7}"
IDLE_WHITELIST="${IDLE_WHITELIST:-}"
LOG_PREFIX="[workspace-idle-monitor]"
PROXY_URL="${PROXY_URL:-http://localhost:8083}"
IDLE_THRESHOLD_SECONDS=$((IDLE_THRESHOLD_DAYS * 86400))

# Create directories if needed
mkdir -p "$ARCHIVES_DIR"
mkdir -p "$VOLUMES_DIR"

log() {
    echo "$LOG_PREFIX $(date -Iseconds): $*"
}

# Detect runtime mode (Docker or systemd)
detect_mode() {
    # Check if Docker is available and we have containers
    if command -v docker &> /dev/null; then
        if docker ps -a --filter "label=app=code-server-proxy" --format "{{.Names}}" 2>/dev/null | grep -q "code-server-"; then
            echo "docker"
            return
        fi
    fi
    
    # Fall back to systemd mode
    echo "systemd"
}

# Check if instance is whitelisted
is_whitelisted() {
    local instance_id="$1"
    
    if [ -z "$IDLE_WHITELIST" ]; then
        return 1
    fi
    
    IFS=',' read -ra WHITELIST_ARRAY <<< "$IDLE_WHITELIST"
    for whitelisted in "${WHITELIST_ARRAY[@]}"; do
        if [ "$instance_id" = "$whitelisted" ]; then
            return 0
        fi
    done
    
    return 1
}

# Get workspace idle time from activity tracker
# Returns idle time in seconds, or empty string if not tracked
get_workspace_idle_time() {
    local workspace_id="$1"
    
    # Query the activity tracker API
    local response
    response=$(curl -s "${PROXY_URL}/api/activity/${workspace_id}" 2>/dev/null || echo "")
    
    if [ -z "$response" ]; then
        return 1
    fi
    
    # Parse JSON response for idleSeconds field
    local idle_seconds
    idle_seconds=$(echo "$response" | grep -o '"idleSeconds":[0-9]*' | cut -d':' -f2)
    
    if [ -n "$idle_seconds" ]; then
        echo "$idle_seconds"
        return 0
    fi
    
    return 1
}

# Docker mode: Monitor and cleanup containers
monitor_docker() {
    log "Running in Docker mode"
    
    # Get all code-server containers
    local containers
    containers=$(docker ps -a --filter "label=app=code-server-proxy" --format "{{.Names}}" 2>/dev/null || echo "")
    
    if [ -z "$containers" ]; then
        log "No Docker containers found"
        return
    fi
    
    local NOW=$(date +%s)
    
    while IFS= read -r container_name; do
        [ -z "$container_name" ] && continue
        
        # Extract instance ID from container name (code-server-<instanceId>)
        local instance_id="${container_name#code-server-}"
        
        # Check whitelist
        if is_whitelisted "$instance_id"; then
            log "Skipping whitelisted container: $instance_id"
            continue
        fi
        
        # Get container state and timestamps
        local container_info
        container_info=$(docker inspect "$container_name" 2>/dev/null || echo "")
        
        if [ -z "$container_info" ]; then
            log "Warning: Could not inspect container $container_name"
            continue
        fi
        
        # Extract state and timestamps
        local state=$(echo "$container_info" | grep -o '"Running": [^,]*' | head -1 | awk '{print $2}')
        
        # For running containers, try to get idle time from activity tracker
        local idle_seconds=0
        local idle_days=0
        
        if [ "$state" = "true" ]; then
            # Running container - use activity tracker if available
            local tracked_idle
            tracked_idle=$(get_workspace_idle_time "$instance_id" 2>/dev/null || echo "")
            
            if [ -n "$tracked_idle" ]; then
                # Activity tracker has data - use it
                idle_seconds=$tracked_idle
                idle_days=$((idle_seconds / 86400))
                log "$instance_id: Using activity tracker - idle for $idle_days days (${idle_seconds}s)"
            else
                # Fall back to container start time
                local started_at=$(echo "$container_info" | grep -o '"StartedAt": "[^"]*"' | head -1 | cut -d'"' -f4)
                local last_activity_seconds=$(date -d "$started_at" +%s 2>/dev/null || echo "0")
                idle_seconds=$((NOW - last_activity_seconds))
                idle_days=$((idle_seconds / 86400))
                log "$instance_id: No activity tracker data, using container start time - idle for $idle_days days"
            fi
        else
            # Stopped container - use FinishedAt timestamp
            local finished_at=$(echo "$container_info" | grep -o '"FinishedAt": "[^"]*"' | head -1 | cut -d'"' -f4)
            
            if [ -n "$finished_at" ] && [ "$finished_at" != "0001-01-01T00:00:00Z" ]; then
                local last_activity_seconds=$(date -d "$finished_at" +%s 2>/dev/null || echo "0")
                idle_seconds=$((NOW - last_activity_seconds))
                idle_days=$((idle_seconds / 86400))
            else
                log "Warning: Could not determine last activity for $instance_id"
                continue
            fi
        fi
        
        # Stop running containers that exceed threshold
        if [ "$state" = "true" ] && [ $idle_days -gt $IDLE_THRESHOLD_DAYS ]; then
            log "Stopping idle container: $instance_id (idle: $idle_days days)"
            docker stop "$container_name" 2>/dev/null || true
        fi
        
        # Cleanup stopped containers that exceed grace period
        if [ "$state" = "false" ] && [ $idle_days -gt $IDLE_GRACE_PERIOD_DAYS ]; then
            log "Cleaning up idle container: $instance_id (idle: $idle_days days)"
            
            # Backup volume before removal
            local volume_name="code-server-${instance_id}-config"
            local backup_path="$VOLUMES_DIR/${instance_id}-$(date +%Y%m%d-%H%M%S).tar.gz"
            
            if docker volume inspect "$volume_name" &>/dev/null; then
                log "Backing up volume $volume_name to $backup_path"
                docker run --rm \
                    -v "$volume_name:/data:ro" \
                    -v "$VOLUMES_DIR:/backup" \
                    alpine:latest \
                    tar czf "/backup/$(basename "$backup_path")" -C /data . 2>/dev/null || \
                    log "Warning: Failed to backup volume $volume_name"
            fi
            
            # Remove container and volume
            docker rm -f "$container_name" 2>/dev/null || true
            docker volume rm "$volume_name" 2>/dev/null || \
                log "Warning: Failed to remove volume $volume_name"
            
            log "Completed cleanup of $instance_id"
        fi
    done <<< "$containers"
}

# Systemd mode: Monitor and cleanup instance directories
monitor_systemd() {
    log "Running in systemd mode"
    
    # Check if instances directory exists
    if [ ! -d "$INSTANCES_DIR" ]; then
        log "Instances directory does not exist: $INSTANCES_DIR"
        return
    fi
    
    local NOW=$(date +%s)
    
    # Iterate through instance directories
    for instance_dir in "$INSTANCES_DIR"/*; do
        [ -d "$instance_dir" ] || continue
        
        local instance_name=$(basename "$instance_dir")
        
        # Skip main instance
        if [ "$instance_name" = "main" ]; then
            log "Skipping main instance"
            continue
        fi
        
        # Check whitelist
        if is_whitelisted "$instance_name"; then
            log "Skipping whitelisted instance: $instance_name"
            continue
        fi
        
        # Check for last-access file
        local last_access_file="$instance_dir/last-access"
        local last_access_seconds
        
        if [ ! -f "$last_access_file" ]; then
            log "Warning: No last-access file for $instance_name, using directory mtime"
            last_access_seconds=$(stat -c %Y "$instance_dir")
        else
            # Read last access timestamp
            local last_access=$(cat "$last_access_file")
            last_access_seconds=$(date -d "$last_access" +%s 2>/dev/null || echo "0")
            
            if [ "$last_access_seconds" = "0" ]; then
                log "Warning: Invalid timestamp in last-access file for $instance_name, using directory mtime"
                last_access_seconds=$(stat -c %Y "$instance_dir")
            fi
        fi
        
        # Calculate idle days
        local idle_seconds=$((NOW - last_access_seconds))
        local idle_days=$((idle_seconds / 86400))
        
        log "$instance_name: idle for $idle_days days"
        
        if [ $idle_days -gt $IDLE_THRESHOLD_DAYS ]; then
            log "Stopping idle instance: $instance_name (idle: $idle_days days)"
            
            # Stop systemd service (ignore errors if already stopped)
            systemctl --user stop "code-server-workspace@$instance_name.service" 2>/dev/null || true
            
            # Create archive
            local archive_name="${instance_name}-$(date +%Y%m%d-%H%M%S).tar.gz"
            local archive_path="$ARCHIVES_DIR/$archive_name"
            
            log "Archiving $instance_name to $archive_path"
            tar -czf "$archive_path" -C "$INSTANCES_DIR" "$instance_name"
            
            # Remove instance directory
            log "Removing instance directory: $instance_dir"
            rm -rf "$instance_dir"
            
            log "Completed cleanup of $instance_name"
        fi
    done
}

# Main execution
log "Starting idle workspace monitor"

MODE=$(detect_mode)
log "Detected mode: $MODE"

case "$MODE" in
    docker)
        monitor_docker
        ;;
    systemd)
        monitor_systemd
        ;;
    *)
        log "Error: Unknown mode: $MODE"
        exit 1
        ;;
esac

log "Idle workspace monitor completed"