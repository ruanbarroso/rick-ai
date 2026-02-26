#!/bin/bash
# ============================================
# Setup script for Oracle Cloud Always Free VM
# Run this on your Oracle ARM instance
# ============================================

set -e

echo "=== Atualizando sistema ==="
sudo apt update && sudo apt upgrade -y

echo "=== Instalando Docker ==="
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

echo "=== Instalando Docker Compose ==="
sudo apt install -y docker-compose-plugin

echo "=== Configurando firewall ==="
# Oracle Cloud uses iptables
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 5432 -j ACCEPT
sudo netfilter-persistent save

echo "=== Criando diretorio do projeto ==="
mkdir -p ~/rick-ai
cd ~/rick-ai

echo ""
echo "============================================"
echo "  Setup concluido!"
echo ""
echo "  Proximos passos:"
echo "  1. Copie os arquivos do projeto para ~/rick-ai/"
echo "     scp -r ./* usuario@ip_oracle:~/rick-ai/"
echo ""
echo "  2. Crie o arquivo .env:"
echo "     cp .env.example .env"
echo "     nano .env"
echo ""
echo "  3. Suba os containers:"
echo "     docker compose up -d"
echo ""
echo "  4. Para o primeiro login (escanear QR code):"
echo "     docker compose run --rm agent"
echo ""
echo "  5. Depois de escanear, Ctrl+C e suba normal:"
echo "     docker compose up -d"
echo "============================================"
