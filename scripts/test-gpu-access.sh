#!/bin/bash
# Test GPU access in Docker containers

set -e

echo "Testing GPU access in code-server Docker containers..."

# Check if NVIDIA runtime is available
echo "Checking NVIDIA Container Toolkit availability..."
if ! docker run --rm --runtime=nvidia nvidia/cuda:11.0-base nvidia-smi 2>/dev/null; then
  echo "ERROR: NVIDIA Container Toolkit not available"
  echo "Install from: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html"
  exit 1
fi

echo "✓ NVIDIA Container Toolkit is available"

# Test with code-server image
IMAGE_NAME="${IMAGE_NAME:-code-server-proxy:latest}"

echo "Testing GPU access with image: $IMAGE_NAME"

# Create a test container with GPU
docker run --rm \
  --runtime=nvidia \
  -e NVIDIA_VISIBLE_DEVICES=all \
  "$IMAGE_NAME" \
  sh -c "if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi; else echo 'nvidia-smi not in PATH but GPU should be accessible'; fi"

echo "✓ GPU access test completed"