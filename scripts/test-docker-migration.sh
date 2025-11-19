#!/bin/bash

# Docker Migration Test Script
# Tests migration of workspace instances from systemd to Docker mode

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
DOCKER_IMAGE="${DOCKER_IMAGE:-code-server-proxy:latest}"
WORKSPACE_PATH="${1:-/home/shauncutts/src/factfiber.ai/crypto/atropos/atropos_a.code-workspace}"
REGISTRY_PATH="$HOME/.code-workspaces/port-registry.json"
PROXY_PORT=8083

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

# Step 1: Prerequisites check
print_header "Step 1: Checking Prerequisites"

# Check Docker
if ! command -v docker &> /dev/null; then
    print_error "Docker is not installed"
    exit 1
fi
print_success "Docker is installed: $(docker --version)"

# Check Docker daemon
if ! docker info &> /dev/null; then
    print_error "Docker daemon is not running"
    exit 1
fi
print_success "Docker daemon is running"

# Check Docker permissions
if ! docker ps &> /dev/null; then
    print_error "Current user cannot access Docker (try: sudo usermod -aG docker $USER)"
    exit 1
fi
print_success "Docker permissions OK"

# Check Node.js and npm
if ! command -v node &> /dev/null; then
    print_error "Node.js is not installed"
    exit 1
fi
print_success "Node.js is installed: $(node --version)"

# Check workspace exists
if [ ! -f "$WORKSPACE_PATH" ] && [ ! -d "$WORKSPACE_PATH" ]; then
    print_error "Workspace path does not exist: $WORKSPACE_PATH"
    exit 1
fi
print_success "Workspace path exists: $WORKSPACE_PATH"

# Step 2: Build Docker image
print_header "Step 2: Building Docker Image"

DOCKERFILE_PATH="docker/code-server/Dockerfile"
if [ ! -f "$DOCKERFILE_PATH" ]; then
    print_error "Dockerfile not found: $DOCKERFILE_PATH"
    exit 1
fi

print_info "Building image: $DOCKER_IMAGE"
print_info "This may take several minutes..."

if docker build -t "$DOCKER_IMAGE" -f "$DOCKERFILE_PATH" docker/code-server/; then
    print_success "Docker image built successfully"
else
    print_error "Failed to build Docker image"
    exit 1
fi

# Verify image
if docker images "$DOCKER_IMAGE" | grep -q "code-server-proxy"; then
    IMAGE_SIZE=$(docker images "$DOCKER_IMAGE" --format "{{.Size}}")
    print_success "Image verified: $DOCKER_IMAGE (size: $IMAGE_SIZE)"
else
    print_error "Image not found after build"
    exit 1
fi

# Step 3: Compute instance ID
print_header "Step 3: Computing Instance ID"

INSTANCE_ID=$(compute_instance_id "$WORKSPACE_PATH")
print_info "Workspace: $WORKSPACE_PATH"
print_success "Instance ID: $INSTANCE_ID"

# Step 4: Check systemd service
print_header "Step 4: Checking Systemd Service"

SERVICE_NAME="code-server-workspace@${INSTANCE_ID}.service"
if systemctl --user is-active --quiet "$SERVICE_NAME"; then
    print_warning "Systemd service is running: $SERVICE_NAME"
    print_info "Stopping systemd service..."
    if systemctl --user stop "$SERVICE_NAME"; then
        print_success "Systemd service stopped"
    else
        print_error "Failed to stop systemd service"
        exit 1
    fi
else
    print_info "Systemd service not running: $SERVICE_NAME"
fi

# Step 5: Create test container
print_header "Step 5: Creating Test Container"

# Get port from registry or use default
if [ -f "$REGISTRY_PATH" ]; then
    PORT=$(jq -r ".workspaces[\"$WORKSPACE_PATH\"].currentPort // \"8101\"" "$REGISTRY_PATH")
else
    PORT=8101
fi

print_info "Using port: $PORT"

CONTAINER_NAME="code-server-${INSTANCE_ID}"

# Remove existing container if present
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    print_warning "Removing existing container: $CONTAINER_NAME"
    docker rm -f "$CONTAINER_NAME" || true
fi

# Create volumes
print_info "Creating Docker volumes..."
docker volume create "code-server-${INSTANCE_ID}-config" || true
docker volume create "code-server-extensions" || true
print_success "Volumes created"

# Create container
print_info "Creating container: $CONTAINER_NAME"
if docker create \
    --name "$CONTAINER_NAME" \
    --label "app=code-server-proxy" \
    --label "instanceId=$INSTANCE_ID" \
    --label "workspace=$WORKSPACE_PATH" \
    -p "127.0.0.1:${PORT}:8443" \
    -v "${WORKSPACE_PATH}:/workspace:rw" \
    -v "code-server-${INSTANCE_ID}-config:/config" \
    -v "code-server-extensions:/config/extensions" \
    -e "PUID=1000" \
    -e "PGID=1000" \
    -e "TZ=America/New_York" \
    -e "DEFAULT_WORKSPACE=/workspace" \
    "$DOCKER_IMAGE" > /dev/null; then
    print_success "Container created successfully"
else
    print_error "Failed to create container"
    exit 1
fi

# Step 6: Start container
print_header "Step 6: Starting Container"

print_info "Starting container: $CONTAINER_NAME"
if docker start "$CONTAINER_NAME" > /dev/null; then
    print_success "Container started"
else
    print_error "Failed to start container"
    exit 1
fi

# Wait for container to be ready
print_info "Waiting for container to be ready (max 30s)..."
RETRY_COUNT=0
MAX_RETRIES=30

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if docker exec "$CONTAINER_NAME" pgrep -f code-server > /dev/null 2>&1; then
        print_success "Code-server is running in container"
        break
    fi
    sleep 1
    RETRY_COUNT=$((RETRY_COUNT + 1))
    echo -n "."
done
echo ""

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
    print_error "Container did not become ready in time"
    print_info "Container logs:"
    docker logs "$CONTAINER_NAME" --tail 50
    exit 1
fi

# Step 7: Verify gnome-keyring
print_header "Step 7: Verifying gnome-keyring"

print_info "Checking if gnome-keyring is running..."
if docker exec "$CONTAINER_NAME" pgrep -f gnome-keyring-daemon > /dev/null 2>&1; then
    KEYRING_PID=$(docker exec "$CONTAINER_NAME" pgrep -f gnome-keyring-daemon)
    print_success "gnome-keyring is running (PID: $KEYRING_PID)"
else
    print_warning "gnome-keyring is not running"
fi

# Check keyring directory
print_info "Checking keyring directory structure..."
if docker exec "$CONTAINER_NAME" test -d /config/.local/share/keyrings; then
    print_success "Keyring directory exists"
else
    print_warning "Keyring directory not found"
fi

# Step 8: Test container health
print_header "Step 8: Testing Container Health"

# Check container status
CONTAINER_STATUS=$(docker inspect "$CONTAINER_NAME" --format '{{.State.Status}}')
print_info "Container status: $CONTAINER_STATUS"

if [ "$CONTAINER_STATUS" != "running" ]; then
    print_error "Container is not running"
    exit 1
fi
print_success "Container is running"

# Check port binding
print_info "Checking port binding..."
if docker port "$CONTAINER_NAME" 8443/tcp | grep -q "$PORT"; then
    print_success "Port $PORT is correctly bound"
else
    print_error "Port $PORT is not bound correctly"
    exit 1
fi

# Test HTTP connectivity
print_info "Testing HTTP connectivity on port $PORT..."
if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/healthz" | grep -q "200\|302"; then
    print_success "HTTP endpoint is accessible"
else
    print_warning "HTTP endpoint returned unexpected status"
fi

# Step 9: Inspect container details
print_header "Step 9: Container Details"

print_info "Container ID: $(docker inspect "$CONTAINER_NAME" --format '{{.Id}}')"
print_info "Image: $(docker inspect "$CONTAINER_NAME" --format '{{.Config.Image}}')"
print_info "Created: $(docker inspect "$CONTAINER_NAME" --format '{{.Created}}')"

echo ""
print_info "Mounted volumes:"
docker inspect "$CONTAINER_NAME" --format '{{range .Mounts}}  {{.Type}}: {{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'

echo ""
print_info "Port mappings:"
docker port "$CONTAINER_NAME"

echo ""
print_info "Resource limits:"
MEMORY_LIMIT=$(docker inspect "$CONTAINER_NAME" --format '{{.HostConfig.Memory}}')
CPU_LIMIT=$(docker inspect "$CONTAINER_NAME" --format '{{.HostConfig.NanoCpus}}')
echo "  Memory: ${MEMORY_LIMIT:-unlimited}"
echo "  CPU: ${CPU_LIMIT:-unlimited} nano CPUs"

# Step 10: Show logs
print_header "Step 10: Recent Container Logs"

docker logs "$CONTAINER_NAME" --tail 30

# Step 11: Summary
print_header "Migration Test Summary"

print_success "Docker image: $DOCKER_IMAGE"
print_success "Container: $CONTAINER_NAME"
print_success "Instance ID: $INSTANCE_ID"
print_success "Workspace: $WORKSPACE_PATH"
print_success "Port: $PORT"
print_success "Container status: Running"

echo ""
print_info "Access workspace via proxy:"
echo "  http://localhost:${PROXY_PORT}/?workspace=${WORKSPACE_PATH}"

echo ""
print_info "Useful commands:"
echo "  View logs:       docker logs $CONTAINER_NAME -f"
echo "  Stop container:  docker stop $CONTAINER_NAME"
echo "  Start container: docker start $CONTAINER_NAME"
echo "  Remove container: docker rm -f $CONTAINER_NAME"
echo "  Shell access:    docker exec -it $CONTAINER_NAME bash"
echo "  Check keyring:   docker exec $CONTAINER_NAME pgrep -f gnome-keyring"

echo ""
print_header "✓ Migration Test Complete"