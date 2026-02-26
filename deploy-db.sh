#!/bin/bash
# ============================================
# Deploy PostgreSQL na VM docker-1g
# IP: 137.131.241.200
# ============================================
set -e

DB_HOST="137.131.241.200"
DB_USER="ubuntu"
SSH_KEY="~/.ssh/id_rsa"  # <-- ajuste para o caminho da sua chave
DB_PASSWORD="$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 20)"

echo "============================================"
echo "  Deploy PostgreSQL em $DB_HOST"
echo "  Senha gerada: $DB_PASSWORD"
echo "  GUARDE ESSA SENHA!"
echo "============================================"
echo ""

ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$DB_USER@$DB_HOST" bash <<REMOTE
set -e

echo ">>> Instalando Docker..."
if ! command -v docker &> /dev/null; then
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker \$USER
fi

echo ">>> Criando diretorio..."
mkdir -p ~/postgres

cat > ~/postgres/docker-compose.yml <<'COMPOSE'
services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: rick_ai
      POSTGRES_USER: zap
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "0.0.0.0:5432:5432"
    command: >
      postgres
        -c shared_buffers=128MB
        -c effective_cache_size=256MB
        -c work_mem=4MB
        -c max_connections=20
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U zap -d rick_ai"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
COMPOSE

# Substituir senha no compose
sed -i "s/\${DB_PASSWORD}/${DB_PASSWORD}/g" ~/postgres/docker-compose.yml

echo ">>> Subindo PostgreSQL..."
cd ~/postgres
sudo docker compose up -d

echo ">>> Aguardando PostgreSQL ficar saudavel..."
sleep 5
sudo docker compose ps

echo ""
echo ">>> PostgreSQL rodando!"
echo ">>> Connection string: postgresql://zap:${DB_PASSWORD}@${DB_HOST}:5432/rick_ai"
REMOTE

echo ""
echo "============================================"
echo "  PostgreSQL deployado com sucesso!"
echo ""
echo "  DATABASE_URL=postgresql://zap:${DB_PASSWORD}@${DB_HOST}:5432/rick_ai"
echo ""
echo "  Use essa URL no .env do agente"
echo "============================================"
