#!/bin/bash
set -e

WORKSPACES_DIR="$HOME/.code-workspaces"
INSTANCES_DIR="$WORKSPACES_DIR/instances"
REGISTRY_PATH="$WORKSPACES_DIR/port-registry.json"

echo "Code-Server Workspace Migration Script"
echo "======================================="
echo ""
echo "This script will:"
echo "1. Find all existing workspace instances"
echo "2. Rename instance directories from workspace-<prefix> to full hash"
echo "3. Create port registry entries for each instance"
echo ""

if [[ ! -d "$INSTANCES_DIR" ]]; then
    echo "Error: Instances directory not found at $INSTANCES_DIR"
    exit 1
fi

if [[ -f "$REGISTRY_PATH" ]]; then
    echo "Registry already exists at $REGISTRY_PATH"
    read -p "Overwrite? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Migration cancelled"
        exit 0
    fi
    mv "$REGISTRY_PATH" "$REGISTRY_PATH.backup.$(date +%s)"
    echo "Created backup of existing registry"
fi

echo '{"workspaces": {}, "ports": {}}' > "$REGISTRY_PATH"
echo "Initialized new registry"
echo ""

migrated=0
skipped=0

for instance_dir in "$INSTANCES_DIR"/*; do
    if [[ ! -d "$instance_dir" ]]; then
        continue
    fi
    
    instance_name=$(basename "$instance_dir")
    
    if [[ "$instance_name" == "main" ]]; then
        echo "Skipping main instance (no migration needed)"
        skipped=$((skipped + 1))
        continue
    fi
    
    metadata_file="$instance_dir/metadata.json"
    if [[ ! -f "$metadata_file" ]]; then
        echo "Warning: No metadata.json found for $instance_name, skipping"
        skipped=$((skipped + 1))
        continue
    fi
    
    if command -v jq &> /dev/null; then
        workspace_path=$(jq -r '.workspacePath' "$metadata_file")
        port=$(jq -r '.port' "$metadata_file")
    else
        workspace_path=$(grep -oP '"workspacePath":\s*"\K[^"]+' "$metadata_file")
        port=$(grep -oP '"port":\s*\K\d+' "$metadata_file")
    fi
    
    if [[ -z "$workspace_path" ]] || [[ "$workspace_path" == "null" ]]; then
        echo "Warning: No workspace path in metadata for $instance_name, skipping"
        skipped=$((skipped + 1))
        continue
    fi
    
    if [[ -z "$port" ]]; then
        echo "Warning: No port in metadata for $instance_name, skipping"
        skipped=$((skipped + 1))
        continue
    fi
    
    full_hash=$(echo -n "$workspace_path" | sha256sum | awk '{print $1}')
    
    if [[ "$instance_name" == "$full_hash" ]]; then
        echo "Instance $instance_name already using full hash, updating registry only"
    else
        new_dir="$INSTANCES_DIR/$full_hash"
        
        if [[ -d "$new_dir" ]]; then
            echo "Warning: Target directory $new_dir already exists, skipping $instance_name"
            skipped=$((skipped + 1))
            continue
        fi
        
        echo "Renaming: $instance_name -> $full_hash"
        mv "$instance_dir" "$new_dir"
        instance_dir="$new_dir"
        metadata_file="$instance_dir/metadata.json"
    fi
    
    if command -v jq &> /dev/null; then
        jq --arg id "$full_hash" '.instanceId = $id | del(.instanceName)' "$metadata_file" > "$metadata_file.tmp"
        mv "$metadata_file.tmp" "$metadata_file"
    else
        sed -i "s/\"instanceName\": \"[^\"]*\"/\"instanceId\": \"$full_hash\"/" "$metadata_file"
    fi
    
    allocated_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    
    if command -v jq &> /dev/null; then
        registry=$(cat "$REGISTRY_PATH")
        registry=$(echo "$registry" | jq \
            --arg path "$workspace_path" \
            --arg id "$full_hash" \
            --arg port "$port" \
            --arg time "$allocated_at" \
            '.workspaces[$path] = {
                "instanceId": $id,
                "currentPort": ($port | tonumber),
                "allocatedAt": $time
            }')
        registry=$(echo "$registry" | jq \
            --arg path "$workspace_path" \
            --arg id "$full_hash" \
            --arg port "$port" \
            '.ports[$port] = {
                "workspacePath": $path,
                "instanceId": $id
            }')
        echo "$registry" > "$REGISTRY_PATH"
    else
        echo "Error: jq is required for registry manipulation"
        exit 1
    fi
    
    echo "  Added to registry: $workspace_path -> $full_hash (port $port)"
    migrated=$((migrated + 1))
done

echo ""
echo "Migration complete!"
echo "==================="
echo "Migrated: $migrated instances"
echo "Skipped: $skipped instances"
echo "Registry: $REGISTRY_PATH"
echo ""
echo "Next steps:"
echo "1. Review the registry file to ensure correctness"
echo "2. Restart the code-server-proxy service: systemctl --user restart code-server-proxy.service"
echo "3. Stop any running workspace instances and let the proxy restart them with new names"
echo ""