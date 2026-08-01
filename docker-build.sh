#!/bin/bash

# ==============================================================================
# Docker Build and Push Script - PM Synapse
# ==============================================================================
# Builds and pushes the Synapse image to Docker Hub.
# Usage: ./docker-build.sh [version]
# Example: ./docker-build.sh 0.1.0
# Linux tip if docker group is missing from this shell:
#   sg docker -c "./docker-build.sh"
# ==============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${GREEN}PM Synapse — Docker Build and Push${NC}"
echo "======================================"

if ! docker info >/dev/null 2>&1; then
    echo -e "${RED}ERROR: Cannot connect to the Docker daemon${NC}"
    echo ""
    if getent group docker >/dev/null 2>&1 && id -nG "$USER" 2>/dev/null | grep -qw docker; then
        echo -e "${YELLOW}You are in the docker group but this shell session does not have it yet.${NC}"
        echo "Run one of:"
        echo "  newgrp docker"
        echo "  sg docker -c \"./docker-build.sh${1:+ $1}\""
    else
        echo "On Linux, try:"
        echo "  sudo systemctl start docker"
        echo "  sudo usermod -aG docker \$USER   # then open a new terminal"
    fi
    if ! systemctl is-active --quiet docker 2>/dev/null; then
        echo ""
        echo -e "${YELLOW}Docker service is not running. Start it with:${NC}"
        echo "  sudo systemctl start docker"
    fi
    exit 1
fi

FS_TYPE="$(df -T . 2>/dev/null | awk 'NR==2 {print $2}')"
if [[ "$(pwd)" == /run/media/* ]] || [[ "$FS_TYPE" == ntfs* ]] || [[ "$FS_TYPE" == fuse* ]]; then
    echo -e "${YELLOW}[WARN] Building from $FS_TYPE at $(pwd)${NC}"
    echo -e "${YELLOW}       If the build fails with tar/pipe errors, copy the project to an ext4 path first.${NC}"
    echo ""
fi

if [ -z "$DOCKER_USERNAME" ]; then
    read -p "Enter your Docker Hub username: " DOCKER_USERNAME
fi

if [ -z "$DOCKER_USERNAME" ]; then
    echo -e "${RED}ERROR: Docker Hub username is required${NC}"
    exit 1
fi

VERSION=${1:-latest}
IMAGE_NAME="${DOCKER_USERNAME}/pm-synapse"
IMAGE_TAG="${IMAGE_NAME}:${VERSION}"

echo ""
echo "Configuration:"
echo "  Docker Hub User: $DOCKER_USERNAME"
echo "  Image Name: $IMAGE_NAME"
echo "  Version: $VERSION"
echo ""

echo -e "${BLUE}Logging in to Docker Hub...${NC}"
if ! docker login; then
    echo -e "${RED}ERROR: Docker login failed${NC}"
    exit 1
fi

echo ""
echo -e "${BLUE}Building and pushing Docker image...${NC}"

build_with_buildx() {
    local -a tags=(-t "$IMAGE_TAG")
    if [ "$VERSION" != "latest" ]; then
        tags+=(-t "${IMAGE_NAME}:latest")
    fi

    if ! docker buildx inspect --bootstrap >/dev/null 2>&1; then
        echo -e "${BLUE}Creating buildx builder...${NC}"
        docker buildx create --name pm-synapse-builder --use --bootstrap >/dev/null
    fi

    docker buildx build \
        "${tags[@]}" \
        --push \
        --provenance=true \
        .
}

if docker buildx version >/dev/null 2>&1; then
    if ! build_with_buildx; then
        echo -e "${RED}ERROR: Docker build/push failed${NC}"
        exit 1
    fi
else
    echo -e "${YELLOW}[WARN] docker buildx not installed — using classic docker build${NC}"
    DOCKER_BUILDKIT=1 docker build -t "$IMAGE_TAG" .

    if [ "$VERSION" != "latest" ]; then
        echo -e "${BLUE}Tagging as latest...${NC}"
        docker tag "$IMAGE_TAG" "${IMAGE_NAME}:latest"
    fi

    echo -e "${GREEN}[OK] Image built successfully${NC}"
    docker images "$IMAGE_NAME"

    echo ""
    echo -e "${BLUE}Pushing to Docker Hub...${NC}"
    if ! docker push "$IMAGE_TAG"; then
        echo -e "${RED}ERROR: Docker push failed${NC}"
        exit 1
    fi

    if [ "$VERSION" != "latest" ]; then
        docker push "${IMAGE_NAME}:latest"
    fi
fi

echo -e "${GREEN}[OK] Image built and pushed successfully${NC}"

if docker buildx version >/dev/null 2>&1; then
    echo ""
    echo "Registry tags pushed:"
    echo "  $IMAGE_TAG"
    if [ "$VERSION" != "latest" ]; then
        echo "  ${IMAGE_NAME}:latest"
    fi
else
    echo ""
    echo "Image details:"
    docker images "$IMAGE_NAME"
fi

echo ""
echo "======================================"
echo -e "${GREEN}Build and Push Completed!${NC}"
echo "======================================"
echo ""
echo "Your image is now available on Docker Hub:"
echo "  $IMAGE_TAG"
if [ "$VERSION" != "latest" ]; then
    echo "  ${IMAGE_NAME}:latest"
fi
echo ""
echo "To run with Docker:"
echo "  docker run -d -p 3010:3010 --env-file .env.docker $IMAGE_TAG"
echo ""
echo "To run with docker compose:"
echo "  cp .env.docker.example .env.docker   # if needed"
echo "  DOCKER_USERNAME=$DOCKER_USERNAME docker compose up -d"
echo ""
echo "To pull on another machine:"
echo "  docker pull $IMAGE_TAG"
echo ""
echo "Health check:"
echo "  curl -s http://localhost:3010/health"
echo ""
