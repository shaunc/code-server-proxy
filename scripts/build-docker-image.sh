#!/bin/bash
# Build code-server Docker image
set -e

echo "Building code-server-proxy:latest Docker image..."
docker build -t code-server-proxy:latest docker/code-server

echo ""
echo "✓ Build complete"
echo ""
echo "To rebuild containers with the new image:"
echo "  - Containers will automatically be recreated when accessed"
echo "  - Or manually remove containers: docker stop <container> && docker rm <container>"
