#!/bin/bash
set -euo pipefail

APP_DIR="/opt/bulletflowy"
cd "$APP_DIR"

echo "Pulling latest..."
git pull origin main

echo "Installing dependencies..."
npm ci --omit=dev

echo "Building..."
npm run build

echo "Restarting service..."
sudo systemctl restart bulletflowy

echo "Deploy complete."
