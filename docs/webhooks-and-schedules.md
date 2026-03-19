# Webhooks e Agendamentos

## Visao geral

O sistema permite criar **webhooks** e **agendamentos** que disparam sub-agentes automaticamente, sem interacao humana. Cada webhook/agendamento tem um **usuario interno dedicado**, garantindo isolamento de contexto (memorias, historico, sessoes).

---

## Webhooks

### O que e

Um webhook gera uma URL unica + secret que pode ser chamada por sistemas externos (Datadog, GitHub, Jenkins, etc.). Quando chamado, o payload e processado por um template e delegado a um sub-agente.

### Criar um webhook

1. Acesse a pagina de webhooks:
   - Via sidebar do painel admin: clique em **Webhooks**
   - Via URL direta: `https://seu-dominio/webhooks?token=<senha_admin>`
   - Via chat: diga "quero ver os webhooks" e o agente envia o link

2. Clique em **+ Novo Webhook**

3. Preencha:
   - **Nome**: nome descritivo (ex: "Alerta Datadog P1")
   - **Template**: texto com placeholders `{{campo}}` (ex: `Alerta {{alertType}}: {{message}}`)
   - **Modo de execucao**: `Build` (executa) ou `Plan` (so planeja)

4. Apos criar, copie a **URL** e o **Secret** exibidos no card

### Template

O template usa `{{campo}}` para substituir valores do payload JSON:

```
Template: "Alerta {{severity}} no servico {{service}}: {{message}}"
Payload:  { "severity": "P1", "service": "api-vendas", "message": "CPU > 95%" }
Resultado: "Alerta P1 no servico api-vendas: CPU > 95%"
```

- Suporta campos aninhados: `{{alert.title}}`
- Se o template estiver vazio, o JSON inteiro e enviado como texto

### Disparar um webhook

```bash
curl -X POST https://seu-dominio/api/webhook/<ID> \
  -H "Authorization: Bearer <SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"severity": "P1", "service": "api-vendas", "message": "CPU > 95%"}'
```

**Resposta:**
```json
{ "ok": true, "sessionId": "abc123...", "text": "Alerta P1 no servico api-vendas: CPU > 95%" }
```

### Gerenciar webhooks

| Acao | Como |
|------|------|
| Listar | Pagina de webhooks ou `GET /api/webhooks` |
| Criar | Botao "+ Novo Webhook" ou `POST /api/webhooks` |
| Editar | Botao "Editar" no card ou `PUT /api/webhooks/:id` |
| Ativar/Desativar | Botao no card ou `PUT /api/webhooks/:id { active: true/false }` |
| Excluir | Botao "Excluir" ou `DELETE /api/webhooks/:id` |
| Audit log | `GET /api/webhooks/:id/audit` |

---

## Agendamentos

### O que e

Um agendamento executa uma tarefa automaticamente em horarios programados usando expressoes cron. Quando dispara, o texto da tarefa e delegado a um sub-agente.

### Criar um agendamento

1. Acesse a pagina de agendamentos:
   - Via sidebar: clique em **Agendamentos**
   - Via URL: `https://seu-dominio/schedules?token=<senha_admin>`
   - Via chat: diga "quero ver os agendamentos"

2. Clique em **+ Novo Agendamento**

3. Preencha:
   - **Nome**: nome descritivo (ex: "Migracao noturna de micros")
   - **Expressao Cron**: formato padrao de 5 campos
   - **Tarefa**: texto que sera enviado ao sub-agente
   - **Modo**: `Build` ou `Plan`
   - **Max sessoes simultaneas**: quantas sessoes podem rodar ao mesmo tempo (padrao: 1)

### Formato Cron

```
┌───────────── minuto (0-59)
│ ┌───────────── hora (0-23)
│ │ ┌───────────── dia do mes (1-31)
│ │ │ ┌───────────── mes (1-12)
│ │ │ │ ┌───────────── dia da semana (0-6, 0=domingo)
│ │ │ │ │
* * * * *
```

**Exemplos:**

| Expressao | Significado |
|-----------|------------|
| `0 2 * * *` | Diariamente as 2:00 |
| `30 8 * * 1-5` | Seg-Sex as 8:30 |
| `0 22 * * 0` | Domingos as 22:00 |
| `*/15 * * * *` | A cada 15 minutos |
| `0 */2 * * *` | A cada 2 horas |
| `0 3 1 * *` | Dia 1 de cada mes as 3:00 |

### Executar manualmente

Clique em **Executar agora** no card do agendamento. Isso dispara imediatamente sem alterar o proximo horario programado.

### Gerenciar agendamentos

| Acao | Como |
|------|------|
| Listar | Pagina ou `GET /api/schedules` |
| Criar | `POST /api/schedules` |
| Editar | `PUT /api/schedules/:id` |
| Ativar/Desativar | `PUT /api/schedules/:id { active: true/false }` |
| Executar agora | Botao ou `POST /api/schedules/:id/trigger` |
| Excluir | `DELETE /api/schedules/:id` |
| Audit log | `GET /api/schedules/:id/audit` |

---

## Autenticacao

### Paginas de gerenciamento

Duas formas de autenticar nas paginas e APIs:

1. **Senha do admin**: `?token=<senha>` na URL
2. **Token de sessoes**: `?t=<sessionsToken>` na URL (para usuarios dev)

### Endpoint de trigger do webhook

Autenticacao independente via header:
```
Authorization: Bearer <secret_do_webhook>
```

---

## Permissoes (RBAC)

| Acao | Admin | Dev | Business |
|------|-------|-----|----------|
| Criar webhook/agendamento | Sim | Sim | Nao |
| Editar/excluir proprio | Sim | Sim | Nao |
| Editar/excluir de outro dev | Sim | Sim | Nao |
| Editar/excluir criado por admin | Sim | **Nao** | Nao |
| Disparar webhook (via API) | Qualquer um com o secret | | |

---

## Auditoria

Toda criacao, edicao, exclusao e disparo manual e registrado na tabela `automation_audit_log` com:

- **Quem** fez (usuario)
- **Quando** fez
- **O que** mudou (campo, valor anterior, valor novo)

Acessivel via API: `GET /api/webhooks/:id/audit` e `GET /api/schedules/:id/audit`

---

## Usuario interno

Cada webhook e agendamento cria automaticamente um **usuario interno** (`role: internal`) que:

- E usado como "dono" das sessoes de sub-agente disparadas
- Tem memorias e historico isolados dos demais usuarios
- Nao aparece na lista de usuarios do admin
- Nao tem acesso a interface web
- Usa OAuth compartilhado (ou o padrao configurado)

Isso garante que automacoes diferentes nao compartilhem contexto entre si nem com usuarios humanos.

---

## APIs completas

### Webhooks

```
GET    /api/webhooks                    # Listar todos
POST   /api/webhooks                    # Criar (body: { name, template?, executionMode? })
PUT    /api/webhooks/:id                # Atualizar (body: { name?, template?, executionMode?, active? })
DELETE /api/webhooks/:id                # Excluir
GET    /api/webhooks/:id/audit          # Log de auditoria
POST   /api/webhook/:id                 # DISPARAR (header: Authorization: Bearer <secret>, body: JSON payload)
```

### Agendamentos

```
GET    /api/schedules                   # Listar todos
POST   /api/schedules                   # Criar (body: { name, cron, taskText, executionMode?, maxConcurrent? })
PUT    /api/schedules/:id               # Atualizar (body: { name?, cron?, taskText?, executionMode?, active?, maxConcurrent? })
DELETE /api/schedules/:id               # Excluir
GET    /api/schedules/:id/audit         # Log de auditoria
POST   /api/schedules/:id/trigger       # Disparo manual
```

Todas as APIs de gerenciamento requerem `?token=<senha>` ou `?t=<sessionsToken>` na query string.
