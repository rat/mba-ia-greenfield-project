---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-18T13:38:53+00:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-18T13:44:23+00:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-07-18T13:38:53+00:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-07-18T13:38:53+00:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição de informações do vídeo, painel de canal, interface visual do frontend, likes/comentários.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — interface visual para vídeos será implementada na Fase 04/05.

**Sequencing notes:** Depends on Fase 01 — Configuração Base do Projeto, Fase 02 — Cadastro, Login e Gerenciamento de Conta.

**Neighbors (for boundary detection only):** Fase 02 (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Cross-layer | Serviço de processamento em segundo plano (filas) | decided | A (BullMQ + Redis) | @nestjs/bullmq@^11.0.0, bullmq@^5.0.0, ioredis@^5.0.0 |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | decided | B (Presigned URLs via MinIO/S3 - Upload Direto) | minio@^8.0.0 |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Processamento automático do vídeo após upload / Geração automática de thumbnail | decided | A (Serviço Node/NestJS Separado) | fluent-ffmpeg@^2.1.3, @ffmpeg-installer/ffmpeg |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Cross-layer | URL única por vídeo, sem conflito com outros vídeos | decided | B (Nanoid) | nanoid@^3.3.0 |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Reprodução via streaming / Download do vídeo pelo usuário | decided | B (Streaming Direto do Storage via Presigned URL de leitura) | minio@^8.0.0 |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Pré-cadastro automático do vídeo como rascunho / Ciclo de status | decided | A (Enum de Status Simples) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02, phase-03-videos/TD-05 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-06 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-03 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-04 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-05 |
| Download do vídeo pelo usuário | phase-03-videos/TD-05 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** Option A (BullMQ + Redis) — É a solução padrão-ouro no ecossistema NestJS para job queues, suportando acompanhamento de progresso, retries e rate limiting de forma nativa via decoradores. O custo de adicionar o container Redis ao Compose é trivial e isola a carga de mensageria do PostgreSQL.

**Libraries:** `@nestjs/bullmq@^11.0.0`, `bullmq@^5.0.0`, `ioredis@^5.0.0`

### phase-03-videos/TD-02

**Recommendation:** Option B (Presigned URLs) — Mantém a API escalável delegando o I/O pesado de 10GB diretamente para o Storage (MinIO). A API apenas atua como control plane (gerando credenciais temporárias e registrando a intenção). O fluxo será: 1. Cliente pede upload; 2. API cria rascunho no DB e retorna presigned URL(s); 3. Cliente faz upload direto; 4. Cliente notifica API da conclusão.

**Libraries:** `minio@^8.0.0`

### phase-03-videos/TD-03

**Recommendation:** Option A (Serviço Separado) — O diagrama arquitetural mostra "API" e "Video Worker" como containers distintos. Isso isola os recursos (CPU/Memória) de processamento de vídeo, garantindo que a API não trave. A implementação compartilhará o código NestJS, mas será iniciada via um entrypoint/script diferente ou app separado (Microservice/Standalone application do NestJS) dentro do compose.

**Libraries:** `fluent-ffmpeg@^2.1.3`, `@ffmpeg-installer/ffmpeg`

### phase-03-videos/TD-04

**Recommendation:** Option B (Nanoid) — Produz URLs limpas, URL-safe e compactas. Tamanho 11 com alfabeto alfanumérico oferece entropia suficiente para a escala do projeto. O ID gerado será a `videoUrlId` armazenada no DB, separada da PK (UUIDv4) interna.

**Libraries:** `nanoid@^3.3.0`

### phase-03-videos/TD-05

**Recommendation:** Option B (Streaming Direto) — Cumpre a restrição arquitetural do diagrama (conexão direta Frontend → Storage) e resolve os requisitos de streaming (progressivo via HTTP Range) e download delegando a carga ao MinIO. É a abordagem mais escalável e de menor atrito para o MVP, antes de evoluir para HLS.

**Libraries:** `minio@^8.0.0`

### phase-03-videos/TD-06

**Recommendation:** Option A (Enum Simples) — Um fluxo enxuto atende aos requisitos: 1. API cria `DRAFT` e retorna a presigned URL; 2. Cliente faz upload no storage e chama endpoint de "upload concluído", que muda para `PROCESSING` e envia para a fila; 3. Worker finaliza e atualiza para `READY` ou `ERROR`. (A publicação em si será tratada na Fase 04).

**Libraries:** —

## Inherited Decisions Detail

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`.
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`.
- Error format is `{ statusCode, error, message }` where `error` is a domain code string.
- JWT authentication uses custom guards.
- API is protected by default, endpoints must be explicitly decorated with `@Public()` if anonymous access is required.

## Inherited Deferred Capabilities

_No inherited deferred capabilities._

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| Edição de informações do vídeo, painel de canal, interface visual do frontend, likes/comentários | deferred | `next-frontend/` is not in scope for this phase; UI surfaces start in a later phase. | — |

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/`. Phase 03 introduces object storage, message queues, and a worker process. Unit tests must mock external services (MinIO, Redis). Integration tests must use the real services running in Docker Compose. Specific layer coverage by SI is recorded in `progress.md`.
