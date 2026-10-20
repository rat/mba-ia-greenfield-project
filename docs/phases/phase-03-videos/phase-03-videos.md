---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-18T13:50:00+00:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-18T13:52:00+00:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-18T13:44:23+00:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Upload de até 10GB funcional sem impacto na performance via armazenamento e processamento em fila, com processamento automático do vídeo (thumbnail e metadados), URLs únicas geradas e reprodução via streaming e download.

---

## Step Implementations

### SI-03.1 — Configuração de Infraestrutura e MinIO
**Description:** Adicionar Redis e MinIO ao Docker Compose e configurar o módulo base de Storage no NestJS.
**Technical actions:**
- Adicionar serviços `redis` (redis:7-alpine) e `minio` (minio/minio) ao `nestjs-project/compose.yaml`.
- Criar script/comando no compose para inicializar o bucket `streamtube` no MinIO automaticamente via `mc`.
- Adicionar variáveis de ambiente em `.env` e validação no `env.validation.ts` (MINIO_ENDPOINT, MINIO_PORT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY, REDIS_HOST, REDIS_PORT).
- Criar `src/config/storage.config.ts` e `src/config/redis.config.ts` com `registerAs`.
- Criar `StorageModule` e `StorageService` encapsulando a biblioteca `minio`.
**Dependencies:** []
**Acceptance criteria:**
- Serviços `redis` e `minio` sobem corretamente via docker compose.
- `StorageService` consegue instanciar o cliente MinIO e conectar-se ao bucket.

### SI-03.2 — Entidade e Migration de Vídeos
**Description:** Criar a tabela `videos` e a entidade TypeORM.
**Technical actions:**
- Criar entidade `Video` em `src/videos/entities/video.entity.ts`.
- Campos: `id` (UUID), `channelId` (UUID, FK para Channel), `title` (string), `status` (enum: DRAFT, PROCESSING, READY, ERROR), `videoUrlId` (string, unique, gerada por nanoid(11)), `storageKey` (string, nullable), `thumbnailKey` (string, nullable), `duration` (number, nullable), `metadata` (jsonb, nullable), `createdAt`, `updatedAt`.
- Gerar migration `CreateVideos` e rodar.
**Dependencies:** [SI-03.1]
**Acceptance criteria:**
- Tabela `videos` criada no banco com FK correta para `channels`.
- Entidade `Video` mapeada no TypeORM.

### SI-03.3 — Configuração de Fila (BullMQ)
**Description:** Configurar o BullMQ no nível global da aplicação.
**Technical actions:**
- Importar `BullModule.forRootAsync` no `AppModule` usando as configurações do Redis.
- Registrar a fila `video-processing` via `BullModule.registerQueue`.
**Dependencies:** [SI-03.1]
**Acceptance criteria:**
- Aplicação NestJS inicia sem erros e conecta ao Redis via BullMQ.

### SI-03.4 — Upload de Vídeos (Geração de Presigned URL)
**Description:** Implementar endpoint para iniciar o upload do vídeo.
**Technical actions:**
- Criar `VideosModule`, `VideosController` e `VideosService`.
- Implementar endpoint `POST /videos/upload-intent` (requer autenticação).
- Lógica: gerar `videoUrlId` via `nanoid(11)`; salvar `Video` como `DRAFT` com `title` recebido; gerar `storageKey` (ex: `videos/{channelId}/{videoUrlId}.mp4`); pedir ao `StorageService` uma URL pré-assinada de PUT (`presignedPutObject`).
- Retornar `{ videoId, videoUrlId, uploadUrl }`.
**Dependencies:** [SI-03.2, SI-03.3]
**Acceptance criteria:**
- Endpoint retorna URL válida do MinIO.
- Registro salvo no banco com status `DRAFT`.

### SI-03.5 — Conclusão de Upload e Enfileiramento
**Description:** Implementar endpoint para o cliente avisar que o upload direto terminou.
**Technical actions:**
- Implementar endpoint `POST /videos/:id/upload-complete` (requer autenticação, validar se vídeo pertence ao usuário).
- Lógica: atualizar status do vídeo para `PROCESSING`; publicar evento na fila `video-processing` com `{ videoId, storageKey }`.
**Dependencies:** [SI-03.4]
**Acceptance criteria:**
- Status muda para `PROCESSING`.
- Job é inserido na fila no Redis.

### SI-03.6 — Video Worker (FFmpeg)
**Description:** Implementar o processador assíncrono para extrair metadados e thumbnail.
**Technical actions:**
- Criar classe `VideoProcessor` estendendo `WorkerHost` e decorada com `@Processor('video-processing')`.
- Lógica do `process()`:
  1. Baixar vídeo temporariamente do MinIO (`fGetObject`).
  2. Usar `fluent-ffmpeg` e `ffprobe` para extrair duração e metadados (resolução, codec).
  3. Usar `fluent-ffmpeg` para gerar screenshot em 50% do vídeo.
  4. Fazer upload do thumbnail gerado para o MinIO (`thumbnailKey` = `thumbnails/{channelId}/{videoUrlId}.jpg`).
  5. Atualizar registro do vídeo no banco: status = `READY`, `duration`, `metadata`, `thumbnailKey`.
  6. Em caso de erro, capturar e mudar status para `ERROR`.
  7. Limpar arquivos temporários.
**Dependencies:** [SI-03.5]
**Acceptance criteria:**
- Worker processa job com sucesso.
- Vídeo no MinIO tem thumbnail extraída e enviada ao MinIO.
- Banco atualizado com status `READY` e metadados.

### SI-03.7 — Streaming e Download de Vídeos
**Description:** Implementar endpoints públicos para assistir e baixar o vídeo.
**Technical actions:**
- Implementar endpoint `@Public() GET /videos/:videoUrlId/stream`.
- Lógica: buscar vídeo por `videoUrlId`; se `READY`, gerar URL pré-assinada de GET via `StorageService` e fazer redirect (302) para ela. O MinIO cuidará do range request (206).
- Implementar endpoint `@Public() GET /videos/:videoUrlId/download`.
- Lógica: igual ao stream, mas a URL pré-assinada inclui `response-content-disposition=attachment; filename="{title}.mp4"` nos `reqParams` do MinIO.
**Dependencies:** [SI-03.6]
**Acceptance criteria:**
- GET /stream redireciona para MinIO e vídeo toca no browser.
- GET /download força o download do arquivo com nome correto.

---

## Technical Specifications

### Data Model

**Table:** `videos`
- `id`: uuid (PK)
- `channel_id`: uuid (FK to channels.id, Not Null)
- `title`: varchar (Not Null)
- `status`: varchar (Enum: DRAFT, PROCESSING, READY, ERROR) (Not Null, Default: DRAFT)
- `video_url_id`: varchar (Not Null, Unique)
- `storage_key`: varchar (Nullable)
- `thumbnail_key`: varchar (Nullable)
- `duration`: integer (Nullable, seconds)
- `metadata`: jsonb (Nullable)
- `created_at`: timestamp
- `updated_at`: timestamp

### API Contracts

#### POST /videos/upload-intent
- **Auth:** Bearer Token
- **Request:**
  ```json
  { "title": "Meu Primeiro Vídeo" }
  ```
- **Response (201):**
  ```json
  {
    "id": "uuid",
    "videoUrlId": "aB3cD4eF5gH",
    "uploadUrl": "https://minio..."
  }
  ```

#### POST /videos/:id/upload-complete
- **Auth:** Bearer Token
- **Response (200):**
  ```json
  { "message": "Video queued for processing" }
  ```
- **Errors:** 403 Forbidden (se não for o dono), 404 Not Found.

#### GET /videos/:videoUrlId/stream
- **Auth:** Public
- **Response (302 Found):** Redirect to MinIO presigned URL.

#### GET /videos/:videoUrlId/download
- **Auth:** Public
- **Response (302 Found):** Redirect to MinIO presigned URL with attachment disposition.

### Authorization Matrix

| Resource | Action | Role | Condition |
|----------|--------|------|-----------|
| Video | Create (upload-intent) | Authenticated | Must have a channel |
| Video | Complete Upload | Authenticated | Must be the owner (channelId matches) |
| Video | Stream | Public | Video status must be READY |
| Video | Download | Public | Video status must be READY |

### Error Catalog

- `VIDEO_NOT_FOUND`: Vídeo não existe.
- `VIDEO_NOT_READY`: Tentativa de streaming/download de vídeo não processado.
- `NOT_VIDEO_OWNER`: Tentativa de completar upload de vídeo de outro usuário.

### Events/Messages

#### video-processing
**Payload:**
```json
{ "videoId": "uuid", "storageKey": "videos/channel-id/video-id.mp4" }
```
**Producer:** `VideosService` (per `phase-03-videos/TD-01`)
**Consumer:** `VideoProcessor` (per `phase-03-videos/TD-03`)
**Trigger:** Quando o cliente chama o endpoint de `upload-complete`.
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-01`)

---

## Dependency Map

```text
SI-03.1 (Infra/MinIO)
├── SI-03.2 (Entidade/Migration)
│   └── SI-03.4 (Upload Intent)
│       └── SI-03.5 (Upload Complete)
│           └── SI-03.6 (Video Worker)
│               └── SI-03.7 (Streaming/Download)
└── SI-03.3 (Fila BullMQ)
    └── SI-03.4 (Upload Intent)
```

1. SI-03.1 — Configuração de Infraestrutura e MinIO
2. SI-03.2 — Entidade e Migration de Vídeos
3. SI-03.3 — Configuração de Fila (BullMQ)
4. SI-03.4 — Upload de Vídeos (Geração de Presigned URL)
5. SI-03.5 — Conclusão de Upload e Enfileiramento
6. SI-03.6 — Video Worker (FFmpeg)
7. SI-03.7 — Streaming e Download de Vídeos

---

## Deliverables

- [ ] Serviços MinIO e Redis rodando no compose.yaml.
- [ ] Migration e entidade `Video` criadas.
- [ ] Módulo BullMQ configurado no NestJS.
- [ ] Endpoint de intenção de upload retornando presigned URL.
- [ ] Endpoint de upload completo disparando evento na fila.
- [ ] Worker extraindo thumbnail e duração usando FFmpeg.
- [ ] Endpoints públicos de stream e download redirecionando para MinIO.
- [ ] Testes unitários, de integração e E2E implementados e passando.
