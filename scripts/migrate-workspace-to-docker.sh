#!/bin/bash

# Single Workspace Migration Script
# Migrates a single workspace instance from systemd to Docker mode

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
REGISTRY_PATH="$HOME/.code-workspaces/port-registry.json"
INSTANCES_DIR="$HOME/.code-workspaces/instances"
DOCKER_IMAGE="${DOCKER_IMAGE:-code-server-proxy:latest}"
ROLLBACK_BACKUP=""

# Helper functions
print_header() {
    echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ $1${NC}"
}

compute_instance_id() {
    echo -n "$1" | sha256sum | awk '{print $1}'
}

cleanup_on_error() {
    if [ -n "$ROLLBACK_BACKUP" ] && [ -f "$ROLLBACK_BACKUP" ]; then
        print_warning "Error occurred, rolling back changes..."
        local metadata_file="$INSTANCES_DIR/$INSTANCE_ID/metadata.json"
        if [ -f "$ROLLBACK_BACKUP" ]; then
            cp "$ROLLBACK_BACKUP" "$metadata_file"
            print_success "Metadata restored from backup"
        fi
        rm -f "$ROLLBACK_BACKUP"
    fi
}

trap cleanup_on_error ERR

# Usage
usage() {
    echo "Usage: $0 <workspace-path>"
    echo ""
    echo "Migrates a single workspace instance from systemd to Docker mode."
    echo ""
    echo "Arguments:"
    echo "  workspace-path    Path to the .code-workspace file or directory"
    echo ""
    echo "Environment Variables:"
    echo "  DOCKER_IMAGE      Docker image to use (default: code-server-proxy:latest)"
    echo ""
    echo "Examples:"
    echo "  $0 /path/to/workspace.code-workspace"
    echo "  $0 /path/to/workspace/directory"
    echo ""
    exit 1
}

# Check arguments
if [ $# -ne 1 ]; then
    usage
fi

WORKSPACE_PATH="$1"

# Validate workspace path
if [ ! -e "$WORKSPACE_PATH" ]; then
    print_error "Workspace path does not exist: $WORKSPACE_PATH"
    exit 1
fi

# Get absolute path
WORKSPACE_PATH=$(realpath "$WORKSPACE_PATH")

print_header "Workspace Migration to Docker"

print_info "Workspace: $WORKSPACE_PATH"

# Step 1: Compute instance ID
print_header "Step 1: Computing Instance ID"

INSTANCE_ID=$(compute_instance_id "$WORKSPACE_PATH")
print_success "Instance ID: $INSTANCE_ID"

# Step 2: Check if instance exists in registry
print_header "Step 2: Checking Registry"

if [ ! -f "$REGISTRY_PATH" ]; then
    print_error "Port registry not found: $REGISTRY_PATH"
    exit 1
fi

# Check if workspace exists in registry
if ! jq -e ".workspaces[\"$WORKSPACE_PATH\"]" "$REGISTRY_PATH" > /dev/null 2>&1; then
    print_warning "Workspace not found in registry: $WORKSPACE_PATH"
    print_info "This workspace may not have been accessed before"
    
    # Create new registry entry
    PORT=8101
    print_info "Assigning new port: $PORT"
else
    # Get existing port
    PORT=$(jq -r ".workspaces[\"$WORKSPACE_PATH\"].currentPort" "$REGISTRY_PATH")
    print_success "Found existing port allocation: $PORT"
fi

# Step 3: Check metadata
print_header "Step 3: Checking Instance Metadata"

METADATA_FILE="$INSTANCES_DIR/$INSTANCE_ID/metadata.json"

if [ ! -f "$METADATA_FILE" ]; then
    print_warning "Metadata file not found, will be created by Docker container"
else
    BACKEND=$(jq -r '.backend // "systemd"' "$METADATA_FILE")
    print_info "Current backend: $BACKEND"
    
    if [ "$BACKEND" = "docker" ]; then
        print_warning "Instance already using Docker backend"
        print_info "Continuing anyway to verify container state..."
    fi
    
    # Backup metadata for rollback
    ROLLBACK_BACKUP=$(mktemp)
    cp "$METADATA_FILE" "$ROLLBACK_BACKUP"
    print_success "Metadata backed up to: $ROLLBACK_BACKUP"
fi

# Step 4: Check Docker availability
print_header "Step 4: Checking Docker"

if ! command -v docker &> /dev/null; then
    print_error "Docker is not installed"
    exit 1
fi
print_success "Docker is installed: $(docker --version)"

if ! docker info &> /dev/null; then
    print_error "Docker daemon is not running"
    exit 1
fi
print_success "Docker daemon is running"

# Check Docker image
if ! docker images "$DOCKER_IMAGE" | grep -q code-server-proxy; then
    print_warning "Docker image not found: $DOCKER_IMAGE"
    print_info "Please build the Docker image first:"
    print_info "  docker build -t $DOCKER_IMAGE -f docker/code-server/Dockerfile docker/code-server/"
    exit 1
fi
print_success "Docker image found: $DOCKER_IMAGE"

# Step 5: Stop systemd service
print_header "Step 5: Stopping Systemd Service"

SERVICE_NAME="code-server-workspace@${INSTANCE_ID}.service"

if systemctl --user is-active --quiet "$SERVICE_NAME"; then
    print_info "Stopping systemd service: $SERVICE_NAME"
    if systemctl --user stop "$SERVICE_NAME"; then
        print_success "Systemd service stopped"
    else
        print_error "Failed to stop systemd service"
        exit 1
    fi
else
    print_info "Systemd service not running: $SERVICE_NAME"
fi

# Disable systemd service
if systemctl --user is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
    print_info "Disabling systemd service..."
    systemctl --user disable "$SERVICE_NAME" || true
    print_success "Systemd service disabled"
fi

# Step 6: Migrate user-data-dir to Docker volume
print_header "Step 6: Migrating User Data to Docker Volume"

SYSTEMD_DATA_DIR="$INSTANCES_DIR/$INSTANCE_ID/user-data-dir"

if [ -d "$SYSTEMD_DATA_DIR" ]; then
    print_info "Found systemd user-data-dir: $SYSTEMD_DATA_DIR"
    print_info "Migrating to Docker volume..."
    
    # Use Node.js container-manager to migrate
    node -e "
        const cm = require('./src/container-manager');
        cm.migrateToVolume('$INSTANCE_ID', '$SYSTEMD_DATA_DIR')
            .then(() => {
                console.log('✓ Migration complete');
                process.exit(0);
            })
            .catch(err => {
                console.error('✗ Migration failed:', err.message);
                process.exit(1);
            });
    "
    
    if [ $? -eq 0 ]; then
        print_success "User data migrated to Docker volume"
        
        # Archive old directory
        ARCHIVE_DIR="$INSTANCES_DIR/$INSTANCE_ID/systemd-backup-$(date +%Y%m%d-%H%M%S)"
        mkdir -p "$ARCHIVE_DIR"
        mv "$SYSTEMD_DATA_DIR" "$ARCHIVE_DIR/"
        print_success "Old user-data-dir archived to: $ARCHIVE_DIR"
    else
        print_error "Failed to migrate user data"
        exit 1
    fi
else
    print_info "No systemd user-data-dir found, will start fresh"
fi

# Step 7: Create Docker container
print_header "Step 7: Creating Docker Container"

CONTAINER_NAME="code-server-${INSTANCE_ID}"

# Check if container already exists
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    print_warning "Container already exists: $CONTAINER_NAME"
    print_info "Removing existing container..."
    docker rm -f "$CONTAINER_NAME" || true
fi

# Create and start container using Node.js
print_info "Creating Docker container: $CONTAINER_NAME"
print_info "Port mapping: $PORT -> 8443"

node -e "
    const cm = require('./src/container-manager');
    
    async function main() {
        // Create container
        await cm.createContainer('$INSTANCE_ID', '$WORKSPACE_PATH', $PORT);
        console.log('✓ Container created');
        
        // Start container
        await cm.startContainer('$INSTANCE_ID');
        console.log('✓ Container started');
        
        // Wait for ready
        const ready = await cm.waitForContainerReady('$INSTANCE_ID', 30000);
        if (ready) {
            console.log('✓ Container is ready');
        } else {
            throw new Error('Container did not become ready in time');
        }
    }
    
    main()
        .then(() => process.exit(0))
        .catch(err => {
            console.error('✗ Container setup failed:', err.message);
            process.exit(1);
        });
"

if [ $? -ne 0 ]; then
    print_error "Failed to create or start Docker container"
    exit 1
fi

print_success "Docker container created and started"

# Step 8: Update metadata
print_header "Step 8: Updating Metadata"

if [ ! -d "$INSTANCES_DIR/$INSTANCE_ID" ]; then
    mkdir -p "$INSTANCES_DIR/$INSTANCE_ID"
fi

# Create or update metadata.json
cat > "$METADATA_FILE" <<EOF
{
  "workspacePath": "$WORKSPACE_PATH",
  "port": $PORT,
  "instanceId": "$INSTANCE_ID",
  "created": "$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")",
  "backend": "docker",
  "containerName": "$CONTAINER_NAME"
}
EOF

print_success "Metadata updated with Docker backend"

# Step 9: Verify migration
print_header "Step 9: Verifying Migration"

# Check container is running
if docker ps --filter "name=$CONTAINER_NAME" --format '{{.Names}}' | grep -q "$CONTAINER_NAME"; then
    print_success "Container is running"
else
    print_error "Container is not running"
    exit 1
fi

# Check port is listening
if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
    print_success "Port $PORT is listening"
else
    print_warning "Port $PORT is not yet accessible (may need a few more seconds)"
fi

# Check gnome-keyring is running
if docker exec "$CONTAINER_NAME" pgrep -f gnome-keyring-daemon > /dev/null 2>&1; then
    KEYRING_PID=$(docker exec "$CONTAINER_NAME" pgrep -f gnome-keyring-daemon)
    print_success "gnome-keyring is running (PID: $KEYRING_PID)"
else
    print_warning "gnome-keyring is not running (check container logs)"
fi

# Step 10: Cleanup
print_header "Step 10: Cleanup"

if [ -n "$ROLLBACK_BACKUP" ] && [ -f "$ROLLBACK_BACKUP" ]; then
    rm -f "$ROLLBACK_BACKUP"
    print_success "Removed rollback backup"
fi

# Summary
print_header "Migration Complete"

print_success "Workspace: $WORKSPACE_PATH"
print_success "Instance ID: $INSTANCE_ID"
print_success "Container: $CONTAINER_NAME"
print_success "Port: $PORT"
print_success "Backend: docker"

echo ""
print_info "Access workspace via proxy:"
echo "  http://localhost:8083/?workspace=$WORKSPACE_PATH"

echo ""
print_info "Useful commands:"
echo "  View logs:        docker logs $CONTAINER_NAME -f"
echo "  Stop container:   docker stop $CONTAINER_NAME"
echo "  Start container:  docker start $CONTAINER_NAME"
echo "  Shell access:     docker exec -it $CONTAINER_NAME bash"
echo "  Check keyring:    docker exec $CONTAINER_NAME pgrep -f gnome-keyring"

echo ""
print_header "✓ Migration Successful"