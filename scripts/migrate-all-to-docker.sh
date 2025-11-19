#!/bin/bash

# Batch Workspace Migration Script
# Migrates all workspace instances from systemd to Docker mode

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
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATION_SCRIPT="$SCRIPT_DIR/migrate-workspace-to-docker.sh"
REPORT_FILE="$HOME/.code-workspaces/migration-report-$(date +%Y%m%d-%H%M%S).json"

# Migration tracking
TOTAL_WORKSPACES=0
SUCCESSFUL_MIGRATIONS=0
FAILED_MIGRATIONS=0
SKIPPED_MIGRATIONS=0

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

# Usage
usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Migrates all workspace instances from systemd to Docker mode."
    echo ""
    echo "Options:"
    echo "  --dry-run         Show what would be migrated without making changes"
    echo "  --continue-on-error  Continue migration even if individual workspaces fail"
    echo "  --help            Show this help message"
    echo ""
    echo "Environment Variables:"
    echo "  DOCKER_IMAGE      Docker image to use (default: code-server-proxy:latest)"
    echo ""
    echo "Examples:"
    echo "  $0                      # Migrate all workspaces"
    echo "  $0 --dry-run            # Preview migration"
    echo "  $0 --continue-on-error  # Continue on individual failures"
    echo ""
    exit 1
}

# Parse arguments
DRY_RUN=false
CONTINUE_ON_ERROR=false

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --continue-on-error)
            CONTINUE_ON_ERROR=true
            shift
            ;;
        --help)
            usage
            ;;
        *)
            echo "Unknown option: $1"
            usage
            ;;
    esac
done

print_header "Batch Workspace Migration to Docker"

# Step 1: Prerequisites check
print_header "Step 1: Checking Prerequisites"

# Check Docker
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
    print_error "Docker image not found: $DOCKER_IMAGE"
    print_info "Please build the Docker image first:"
    print_info "  docker build -t $DOCKER_IMAGE -f docker/code-server/Dockerfile docker/code-server/"
    exit 1
fi
print_success "Docker image found: $DOCKER_IMAGE"

# Check migration script exists
if [ ! -f "$MIGRATION_SCRIPT" ]; then
    print_error "Migration script not found: $MIGRATION_SCRIPT"
    exit 1
fi
print_success "Migration script found: $MIGRATION_SCRIPT"

# Check registry exists
if [ ! -f "$REGISTRY_PATH" ]; then
    print_error "Port registry not found: $REGISTRY_PATH"
    exit 1
fi
print_success "Port registry found: $REGISTRY_PATH"

# Step 2: Discover workspaces
print_header "Step 2: Discovering Workspaces"

# Get all workspaces from registry
WORKSPACES=$(jq -r '.workspaces | keys[]' "$REGISTRY_PATH" 2>/dev/null || echo "")

if [ -z "$WORKSPACES" ]; then
    print_warning "No workspaces found in registry"
    exit 0
fi

# Count workspaces
TOTAL_WORKSPACES=$(echo "$WORKSPACES" | wc -l)
print_success "Found $TOTAL_WORKSPACES workspace(s) to migrate"

# Show workspace list
echo ""
print_info "Workspaces to migrate:"
echo "$WORKSPACES" | while read -r workspace; do
    INSTANCE_ID=$(echo -n "$workspace" | sha256sum | awk '{print $1}')
    PORT=$(jq -r ".workspaces[\"$workspace\"].currentPort" "$REGISTRY_PATH")
    BACKEND="systemd"
    
    # Check if already migrated
    METADATA_FILE="$INSTANCES_DIR/$INSTANCE_ID/metadata.json"
    if [ -f "$METADATA_FILE" ]; then
        BACKEND=$(jq -r '.backend // "systemd"' "$METADATA_FILE")
    fi
    
    if [ "$BACKEND" = "docker" ]; then
        echo -e "  ${YELLOW}[DOCKER]${NC} $workspace (port: $PORT)"
    else
        echo -e "  ${BLUE}[SYSTEMD]${NC} $workspace (port: $PORT)"
    fi
done

# Dry run exit
if [ "$DRY_RUN" = true ]; then
    echo ""
    print_info "Dry run mode - no changes made"
    exit 0
fi

# Step 3: Confirm migration
print_header "Step 3: Confirmation"

echo -e "${YELLOW}WARNING: This will migrate all workspaces from systemd to Docker.${NC}"
echo -e "${YELLOW}Systemd services will be stopped and disabled.${NC}"
echo ""
read -p "Continue with migration? (yes/no): " -r
echo ""

if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    print_info "Migration cancelled"
    exit 0
fi

# Step 4: Backup registry
print_header "Step 4: Backing Up Registry"

BACKUP_FILE="${REGISTRY_PATH}.backup-$(date +%Y%m%d-%H%M%S)"
cp "$REGISTRY_PATH" "$BACKUP_FILE"
print_success "Registry backed up to: $BACKUP_FILE"

# Step 5: Migrate workspaces
print_header "Step 5: Migrating Workspaces"

# Initialize report
cat > "$REPORT_FILE" <<EOF
{
  "migrationDate": "$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")",
  "totalWorkspaces": $TOTAL_WORKSPACES,
  "successful": [],
  "failed": [],
  "skipped": []
}
EOF

echo "$WORKSPACES" | while read -r workspace; do
    INSTANCE_ID=$(echo -n "$workspace" | sha256sum | awk '{print $1}')
    
    echo ""
    print_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    print_info "Migrating: $workspace"
    print_info "Instance ID: $INSTANCE_ID"
    print_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    # Check if already migrated
    METADATA_FILE="$INSTANCES_DIR/$INSTANCE_ID/metadata.json"
    if [ -f "$METADATA_FILE" ]; then
        BACKEND=$(jq -r '.backend // "systemd"' "$METADATA_FILE")
        if [ "$BACKEND" = "docker" ]; then
            print_warning "Already using Docker backend, skipping"
            SKIPPED_MIGRATIONS=$((SKIPPED_MIGRATIONS + 1))
            
            # Add to report
            jq ".skipped += [{\"workspace\": \"$workspace\", \"instanceId\": \"$INSTANCE_ID\", \"reason\": \"Already using Docker\"}]" "$REPORT_FILE" > "$REPORT_FILE.tmp"
            mv "$REPORT_FILE.tmp" "$REPORT_FILE"
            continue
        fi
    fi
    
    # Run migration
    if bash "$MIGRATION_SCRIPT" "$workspace"; then
        print_success "Migration successful: $workspace"
        SUCCESSFUL_MIGRATIONS=$((SUCCESSFUL_MIGRATIONS + 1))
        
        # Add to report
        jq ".successful += [{\"workspace\": \"$workspace\", \"instanceId\": \"$INSTANCE_ID\", \"timestamp\": \"$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")\"}]" "$REPORT_FILE" > "$REPORT_FILE.tmp"
        mv "$REPORT_FILE.tmp" "$REPORT_FILE"
    else
        print_error "Migration failed: $workspace"
        FAILED_MIGRATIONS=$((FAILED_MIGRATIONS + 1))
        
        # Add to report
        jq ".failed += [{\"workspace\": \"$workspace\", \"instanceId\": \"$INSTANCE_ID\", \"timestamp\": \"$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")\"}]" "$REPORT_FILE" > "$REPORT_FILE.tmp"
        mv "$REPORT_FILE.tmp" "$REPORT_FILE"
        
        if [ "$CONTINUE_ON_ERROR" = false ]; then
            print_error "Stopping migration due to error"
            break
        else
            print_warning "Continuing with next workspace..."
        fi
    fi
done

# Step 6: Generate final report
print_header "Step 6: Migration Summary"

print_info "Total workspaces: $TOTAL_WORKSPACES"
print_success "Successful migrations: $SUCCESSFUL_MIGRATIONS"
print_error "Failed migrations: $FAILED_MIGRATIONS"
print_warning "Skipped migrations: $SKIPPED_MIGRATIONS"

# Update report with final counts
jq ".summary = {
    \"total\": $TOTAL_WORKSPACES,
    \"successful\": $SUCCESSFUL_MIGRATIONS,
    \"failed\": $FAILED_MIGRATIONS,
    \"skipped\": $SKIPPED_MIGRATIONS
}" "$REPORT_FILE" > "$REPORT_FILE.tmp"
mv "$REPORT_FILE.tmp" "$REPORT_FILE"

echo ""
print_info "Detailed report saved to: $REPORT_FILE"

# Show failed workspaces
if [ $FAILED_MIGRATIONS -gt 0 ]; then
    echo ""
    print_error "Failed workspaces:"
    jq -r '.failed[] | "  - \(.workspace)"' "$REPORT_FILE"
fi

# Step 7: Post-migration instructions
print_header "Step 7: Post-Migration Instructions"

if [ $SUCCESSFUL_MIGRATIONS -gt 0 ]; then
    print_success "Migration completed successfully for $SUCCESSFUL_MIGRATIONS workspace(s)"
    echo ""
    print_info "Next steps:"
    echo "  1. Start proxy in Docker mode:"
    echo "     export USE_DOCKER=true"
    echo "     systemctl --user restart code-server-proxy.service"
    echo ""
    echo "  2. Verify containers are running:"
    echo "     docker ps --filter label=app=code-server-proxy"
    echo ""
    echo "  3. Test workspace access:"
    echo "     http://localhost:8083/?workspace=<workspace-path>"
    echo ""
    echo "  4. If all is working, optionally remove systemd service files:"
    echo "     find ~/.config/systemd/user -name 'code-server-workspace@*.service' -delete"
    echo "     systemctl --user daemon-reload"
fi

if [ $FAILED_MIGRATIONS -gt 0 ]; then
    echo ""
    print_warning "Some migrations failed. Review the report for details:"
    echo "  cat $REPORT_FILE"
    echo ""
    print_info "To retry failed workspaces:"
    echo "  jq -r '.failed[] | .workspace' $REPORT_FILE | while read ws; do"
    echo "    $MIGRATION_SCRIPT \"\$ws\""
    echo "  done"
fi

# Exit with appropriate code
if [ $FAILED_MIGRATIONS -gt 0 ] && [ "$CONTINUE_ON_ERROR" = false ]; then
    exit 1
elif [ $FAILED_MIGRATIONS -eq $TOTAL_WORKSPACES ]; then
    exit 1
else
    print_header "✓ Batch Migration Complete"
    exit 0
fi