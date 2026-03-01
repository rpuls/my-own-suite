#!/bin/bash

# My-Own-Suite VPS Installation Script
# This script sets up the self-hosted services suite on a VPS

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
echo "========================================"
echo "   My-Own-Suite VPS Installation       "
echo "========================================"
echo -e "${NC}"

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    echo -e "${YELLOW}Warning: Running as root is not recommended.${NC}"
fi

# Check for Docker
echo -e "${BLUE}Checking for Docker...${NC}"
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Error: Docker is not installed.${NC}"
    echo "Please install Docker first: https://docs.docker.com/get-docker/"
    exit 1
fi
echo -e "${GREEN}Docker is installed.${NC}"

# Check for Docker Compose
echo -e "${BLUE}Checking for Docker Compose...${NC}"
if ! docker compose version &> /dev/null; then
    if ! command -v docker-compose &> /dev/null; then
        echo -e "${RED}Error: Docker Compose is not installed.${NC}"
        echo "Please install Docker Compose first: https://docs.docker.com/compose/install/"
        exit 1
    fi
    COMPOSE_CMD="docker-compose"
else
    COMPOSE_CMD="docker compose"
fi
echo -e "${GREEN}Docker Compose is available ($COMPOSE_CMD).${NC}"

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VPS_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(dirname "$VPS_DIR")"

cd "$VPS_DIR"

# Check for .env file in VPS directory
if [ ! -f .env ]; then
    echo -e "${BLUE}Creating .env file from .env.example...${NC}"
    if [ -f "$PROJECT_DIR/.env.example" ]; then
        cp "$PROJECT_DIR/.env.example" .env
        echo -e "${GREEN}.env file created.${NC}"
    else
        echo -e "${RED}Error: .env.example not found in project root.${NC}"
        exit 1
    fi
else
    echo -e "${YELLOW}.env file already exists, skipping copy.${NC}"
fi

# Prompt for configuration
echo -e "${BLUE}"
echo "Configuration Setup"
echo "===================="
echo -e "${NC}"

read -p "Enter your domain (e.g., https://myserver.com) [default: http://localhost]: " DOMAIN
DOMAIN=${DOMAIN:-http://localhost}

read -p "Enter your email for SSL certificates (optional): " EMAIL

# Update .env file
if [ -n "$DOMAIN" ]; then
    sed -i "s|^DOMAIN=.*|DOMAIN=$DOMAIN|" .env 2>/dev/null || sed -i '' "s|^DOMAIN=.*|DOMAIN=$DOMAIN|" .env
fi

if [ -n "$EMAIL" ]; then
    sed -i "s|^EMAIL=.*|EMAIL=$EMAIL|" .env 2>/dev/null || sed -i '' "s|^EMAIL=.*|EMAIL=$EMAIL|" .env
fi

# Create necessary directories
echo -e "${BLUE}Creating data directories...${NC}"
mkdir -p services/vaultwarden/data

echo -e "${GREEN}Directories created.${NC}"

# Pull images
echo -e "${BLUE}Pulling Docker images...${NC}"
$COMPOSE_CMD pull

# Start services
echo -e "${BLUE}Starting services...${NC}"
$COMPOSE_CMD up -d

# Wait for services to start
echo -e "${BLUE}Waiting for services to start...${NC}"
sleep 5

# Check status
echo -e "${BLUE}Checking service status...${NC}"
$COMPOSE_CMD ps

echo -e "${GREEN}"
echo "========================================"
echo "  Installation Complete!                "
echo "========================================"
echo -e "${NC}"
echo -e "${BLUE}Next Steps:${NC}"
echo ""
echo "1. Access your dashboard at: ${GREEN}${DOMAIN}${NC}"
echo ""
echo "2. Vaultwarden (Password Manager):"
echo "   - URL: ${DOMAIN}/vaultwarden/"
echo "   - Create your first account to get started"
echo ""
echo "3. Configuration:"
echo "   - Edit .env in the vps/ directory to customize settings"
echo "   - Restart with: $COMPOSE_CMD restart"
echo ""
echo "4. To add more services:"
echo "   - Add to vps/docker-compose.yml"
echo "   - Update vps/Caddyfile routes"
echo "   - Add to shared/configs/homepage/services.yaml"
echo ""
echo -e "${YELLOW}Important:${NC}"
echo "- Your data is stored in vps/apps/*/data directories"
echo "- Back up these directories regularly"
echo "- Review .gitignore to ensure data is not committed"
echo ""