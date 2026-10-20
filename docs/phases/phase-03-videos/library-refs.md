---
libs:
  "@nestjs/bullmq":
    version: "^11.0.0"
    context7_id: "/nestjs/nest"
    fetched_at: "2026-07-18T13:52:00+00:00"
  "bullmq":
    version: "^5.0.0"
    context7_id: "/taskforces/bullmq"
    fetched_at: "2026-07-18T13:52:00+00:00"
  "ioredis":
    version: "^5.0.0"
    context7_id: "/luin/ioredis"
    fetched_at: "2026-07-18T13:52:00+00:00"
  "minio":
    version: "^8.0.0"
    context7_id: "/minio/minio-js"
    fetched_at: "2026-07-18T13:52:00+00:00"
  "fluent-ffmpeg":
    version: "^2.1.3"
    context7_id: "/fluent-ffmpeg/node-fluent-ffmpeg"
    fetched_at: "2026-07-18T13:52:00+00:00"
  "@ffmpeg-installer/ffmpeg":
    version: "latest"
    context7_id: "/ffmpeg-installer/ffmpeg"
    fetched_at: "2026-07-18T13:52:00+00:00"
  "nanoid":
    version: "^3.3.0"
    context7_id: "/ai/nanoid"
    fetched_at: "2026-07-18T13:52:00+00:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-18T13:44:23+00:00"
---

### @nestjs/bullmq, bullmq, ioredis

NestJS integration with BullMQ for robust job queues backed by Redis.
- Setup: `BullModule.forRootAsync` (for redis connection) and `BullModule.registerQueue({ name: 'video-processing' })`.
- Producer: Inject via `@InjectQueue('video-processing')` and call `queue.add('process', payload)`.
- Consumer: Create a class with `@Processor('video-processing')` extending `WorkerHost`, implement `process(job: Job)`.

### minio

MinIO JavaScript Client SDK for Amazon S3 Compatible Cloud Storage.
- Setup: `new Client({ endPoint, port, useSSL, accessKey, secretKey })`.
- Upload direct (Presigned URL): `client.presignedPutObject(bucketName, objectName, expiry)`.
- Download/Streaming (Presigned URL): `client.presignedGetObject(bucketName, objectName, expiry, reqParams)`.
- The `reqParams` can be used to set `response-content-disposition` for downloads.

### fluent-ffmpeg & @ffmpeg-installer/ffmpeg

A fluent API to FFMPEG.
- Setup: `const ffmpeg = require('fluent-ffmpeg'); const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg'); ffmpeg.setFfmpegPath(ffmpegInstaller.path);`
- Metadata: `ffmpeg.ffprobe(file, (err, metadata) => { ... })`
- Thumbnail generation: `ffmpeg(file).screenshots({ timestamps: ['50%'], filename: 'thumb.jpg', folder: '/tmp' })`

### nanoid

A tiny, secure, URL-friendly, unique string ID generator.
- Setup: `import { customAlphabet } from 'nanoid';`
- Usage: `const nanoid = customAlphabet('1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 11); const id = nanoid();`
- Note: Version 3.x is required for CommonJS compatibility without async imports.
