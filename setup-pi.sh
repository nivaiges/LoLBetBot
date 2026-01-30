#!/bin/bash
set -e

echo "=== Discord Bet Bot — Raspberry Pi Setup ==="

# Check for Node.js 20+
if ! command -v node &> /dev/null; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "Node.js 20+ required (found v$(node -v)). Upgrading..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "Node $(node -v) detected"

# Install build tools for better-sqlite3
echo "Installing build dependencies..."
sudo apt-get install -y build-essential python3

# Install npm dependencies
echo "Installing npm packages..."
npm install --production

# Create .env if missing
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo ">>> Created .env from template. Edit it with your tokens:"
  echo "    nano .env"
  echo ""
fi

# Install systemd service
APP_DIR=$(pwd)
SERVICE_USER=$(whoami)

echo "Setting up systemd service..."
sudo tee /etc/systemd/system/discord-bet-bot.service > /dev/null <<EOF
[Unit]
Description=Discord Bet Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10
EnvironmentFile=${APP_DIR}/.env

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${APP_DIR}

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable discord-bet-bot
sudo systemctl restart discord-bet-bot

echo ""
echo "=== Setup complete! ==="
echo "The bot is running and will auto-restart on crash or reboot."
echo ""
echo "Useful commands:"
echo "  sudo systemctl status discord-bet-bot   # Check status"
echo "  sudo journalctl -u discord-bet-bot -f   # View logs"
echo "  sudo systemctl restart discord-bet-bot   # Restart"
echo "  sudo systemctl stop discord-bet-bot      # Stop"
