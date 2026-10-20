---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-18
scope_description: "Fase 03 — Upload e Processamento de Vídeos. Inclui decisões técnicas de arquitetura para a fila de mensageria, upload assíncrono (10GB) ao storage via presigned URLs, streaming e reprodução de vídeos, design do worker de processamento (FFmpeg) e ciclo de status da entidade de vídeo."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_
- `nestjs-project/`
- _Deferred: `next-frontend/` (a UI será construída na Fase 04/05)_

## Decisions Detail

### phase-03-videos/TD-01

**Scope:** Cross-layer
**Capability:** Serviço de processamento em segundo plano (filas)
**Context:** A arquitetura requer uma Message Queue ("TBD" no diagrama) para que a API dispare jobs de processamento de vídeos para um worker assíncrono. O NestJS possui suporte nativo a filas. Precisamos de algo robusto para orquestração de tarefas assíncronas (retries, atrasos, status) que não aumente drasticamente a complexidade operacional da infraestrutura.
**Options:**
- **Option A (BullMQ + Redis):** Integração oficial de primeira classe no NestJS (`@nestjs/bullmq`). Robusto, suporta retries, prioridades e acompanhamento de progresso. Requer adicionar o Redis ao Docker Compose. É o padrão de mercado para Node.js/NestJS.
- **Option B (RabbitMQ / AMQP):** Excelente para pub/sub genérico e roteamento avançado, mas complexo para apenas orquestrar jobs (onde o controle de estado e retry pontual é necessário). Adiciona complexidade infraestrutural significativa.
- **Option C (pg-boss):** Fila baseada em PostgreSQL. Elimina a necessidade de um serviço extra (Redis), usando o banco atual. Contudo, não tem integração de primeira classe no NestJS e pode sobrecarregar o DB principal com polling de I/O intensivo.

**Recommendation:** Option A (BullMQ + Redis) — É a solução padrão-ouro no ecossistema NestJS para job queues, suportando acompanhamento de progresso, retries e rate limiting de forma nativa via decoradores. O custo de adicionar o container Redis ao Compose é trivial e isola a carga de mensageria do PostgreSQL.
**Decision:** A
**Libraries:** `@nestjs/bullmq@^11.0.0`, `bullmq@^5.0.0`, `ioredis@^5.0.0`

### phase-03-videos/TD-02

**Scope:** Backend
**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
**Context:** Fazer upload de arquivos de até 10GB através da API bloqueia threads, consome RAM excessiva (ou satura I/O no disco do server) e exige aumento irreal de timeouts, ferindo o requisito "sem travar o sistema". O object storage (MinIO/S3) suporta recebimento direto do cliente.
**Options:**
- **Option A (Upload via API com Streams):** O cliente envia o vídeo para a API NestJS, que repassa via stream (`minioClient.putObject`) para o storage. Apesar de usar pouca RAM, a API continua atuando como proxy, saturando banda e conexões por longos períodos.
- **Option B (Presigned URLs via MinIO/S3 - Upload Direto):** A API gera uma URL pré-assinada com validade curta e a devolve ao cliente. O cliente faz o PUT diretamente no MinIO/S3 usando essa URL. A API fica livre após milissegundos. Para 10GB, a estratégia exata requer Multipart Upload (geração de múltiplas presigned URLs por parte), mas o princípio arquitetural é o mesmo: cliente → storage.
- **Option C (Tus Protocol):** Resumable uploads. Muito resiliente, mas exige um servidor Tus separado ou integração pesada, aumentando o acoplamento. MinIO já suporta multipart nativo de forma escalável.

**Recommendation:** Option B (Presigned URLs) — Mantém a API escalável delegando o I/O pesado de 10GB diretamente para o Storage (MinIO). A API apenas atua como control plane (gerando credenciais temporárias e registrando a intenção). O fluxo será: 1. Cliente pede upload; 2. API cria rascunho no DB e retorna presigned URL(s); 3. Cliente faz upload direto; 4. Cliente notifica API da conclusão.
**Decision:** B
**Libraries:** `minio@^8.0.0` (S3 SDK genérico/leve)

### phase-03-videos/TD-03

**Scope:** Backend
**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados) / Geração automática de thumbnail a partir de um frame do vídeo
**Context:** O diagrama C4 especifica um "Video Worker (FFmpeg)" consumindo da Message Queue. O FFmpeg é um binário de sistema pesado. O worker pode rodar no mesmo processo da API (monolítico lógico) ou ser um serviço separado.
**Options:**
- **Option A (Serviço Node/NestJS Separado):** Um container Docker dedicado apenas para o worker, usando a mesma base de código (monorepo), mas com um `Dockerfile.worker` que instala o FFmpeg e não expõe porta HTTP. Consome da fila BullMQ. Escala independentemente da API.
- **Option B (No mesmo container da API):** Instalar o FFmpeg no `Dockerfile.dev` atual e rodar os processors do BullMQ junto com o servidor HTTP. Simples para o ambiente local, mas perigoso: processamento de vídeo rouba CPU e pode degradar a latência da API.
- **Option C (Cloud Functions / Serverless):** Fora de cogitação para o escopo local de Docker Compose.

**Recommendation:** Option A (Serviço Separado) — O diagrama arquitetural mostra "API" e "Video Worker" como containers distintos. Isso isola os recursos (CPU/Memória) de processamento de vídeo, garantindo que a API não trave. A implementação compartilhará o código NestJS, mas será iniciada via um entrypoint/script diferente ou app separado (Microservice/Standalone application do NestJS) dentro do compose.
**Decision:** A
**Libraries:** `fluent-ffmpeg@^2.1.3`, `@ffmpeg-installer/ffmpeg` (para ambiente local/testes sem depender do host)

### phase-03-videos/TD-04

**Scope:** Cross-layer
**Capability:** URL única por vídeo, sem conflito com outros vídeos
**Context:** Os vídeos precisam de identificadores curtos e amigáveis para URLs (ex: `youtube.com/watch?v=dQw4w9WgXcQ`), em vez de UUIDs longos ou IDs sequenciais previsíveis.
**Options:**
- **Option A (UUIDv4):** Nativo, sem colisões. Porém, é longo, feio em URLs e não amigável.
- **Option B (Nanoid):** Gera IDs curtos, seguros contra colisões, URL-safe e configuráveis (ex: tamanho 11, como o YouTube). É o padrão moderno para URLs públicas.
- **Option C (Hashids):** Obsoleto, substituído pelo Nanoid na comunidade.

**Recommendation:** Option B (Nanoid) — Produz URLs limpas, URL-safe e compactas. Tamanho 11 com alfabeto alfanumérico oferece entropia suficiente para a escala do projeto. O ID gerado será a `videoUrlId` armazenada no DB, separada da PK (UUIDv4) interna.
**Decision:** B
**Libraries:** `nanoid@^3.3.0` (versão 3 suporta CommonJS/Node sem problemas de ESM)

### phase-03-videos/TD-05

**Scope:** Backend
**Capability:** Reprodução via streaming (sem necessidade de download completo) / Download do vídeo pelo usuário
**Context:** O diagrama C4 indica que o Frontend "Streams (HTTPS)" diretamente do Object Storage.
**Options:**
- **Option A (Streaming via API):** A API busca o vídeo do MinIO e faz pipe para o frontend com suporte a `Range` requests (HTTP 206). Bloqueia a API e satura a rede.
- **Option B (Streaming Direto do Storage via Presigned URL de leitura):** A API gera uma presigned URL de GET para o vídeo. O frontend usa essa URL na tag `<video src="...">`. O próprio MinIO/S3 lida nativamente com requisições de `Range` e `206 Partial Content`, permitindo streaming imediato sem sobrecarregar a API. O download funciona da mesma forma, adicionando `response-content-disposition=attachment` na geração da URL.
- **Option C (HLS/DASH):** FFmpeg segmenta o vídeo em arquivos `.ts` e um manifesto `.m3u8`. É o streaming real da indústria. Contudo, adiciona enorme complexidade ao worker e storage para um MVP. O streaming progressivo de MP4 (Option B) cumpre o requisito funcional básico de "assistir sem baixar inteiro".

**Recommendation:** Option B (Streaming Direto) — Cumpre a restrição arquitetural do diagrama (conexão direta Frontend → Storage) e resolve os requisitos de streaming (progressivo via HTTP Range) e download delegando a carga ao MinIO. É a abordagem mais escalável e de menor atrito para o MVP, antes de evoluir para HLS.
**Decision:** B
**Libraries:** `minio@^8.0.0`

### phase-03-videos/TD-06

**Scope:** Backend
**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload / Ciclo de status do vídeo
**Context:** A entidade de vídeo precisa representar o estado assíncrono desde a intenção de upload até a publicação.
**Options:**
- **Option A (Enum de Status Simples):** `DRAFT` (criado, aguardando upload) → `PROCESSING` (na fila/FFmpeg) → `READY` (processado com sucesso) / `ERROR` (falha).
- **Option B (Status Expandido):** `DRAFT` → `UPLOADING` → `UPLOADED` → `PROCESSING` → `READY` → `ERROR`. Requer que o cliente sinalize múltiplos passos.

**Recommendation:** Option A (Enum Simples) — Um fluxo enxuto atende aos requisitos: 1. API cria `DRAFT` e retorna a presigned URL; 2. Cliente faz upload no storage e chama endpoint de "upload concluído", que muda para `PROCESSING` e envia para a fila; 3. Worker finaliza e atualiza para `READY` ou `ERROR`. (A publicação em si será tratada na Fase 04).
**Decision:** A
**Libraries:** —

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| phase-03-videos/TD-01 | Cross-layer | decided | Option A (BullMQ + Redis) | A |
| phase-03-videos/TD-02 | Backend | decided | Option B (Presigned URLs via MinIO/S3 - Upload Direto) | B |
| phase-03-videos/TD-03 | Backend | decided | Option A (Serviço Node/NestJS Separado) | A |
| phase-03-videos/TD-04 | Cross-layer | decided | Option B (Nanoid) | B |
| phase-03-videos/TD-05 | Backend | decided | Option B (Streaming Direto do Storage via Presigned URL de leitura) | B |
| phase-03-videos/TD-06 | Backend | decided | Option A (Enum de Status Simples) | A |
