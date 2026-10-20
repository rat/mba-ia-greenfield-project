import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Client } from 'minio';
import storageConfig from '../config/storage.config';

/**
 * Thin wrapper around the S3-compatible object storage (MinIO locally, S3 in
 * production) per phase-03-videos/TD-02 and phase-03-videos/TD-05.
 *
 * The API never streams video bytes: it only mints short-lived presigned URLs
 * so that clients talk to the storage directly (upload and playback).
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: Client;
  private readonly publicClient: Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.client = new Client({
      endPoint: config.endpoint,
      port: config.port,
      useSSL: config.useSSL,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
    });

    // Presigned URLs are consumed by clients outside the Compose network, so
    // they must be signed against the externally reachable endpoint.
    this.publicClient = new Client({
      endPoint: config.publicEndpoint,
      port: config.publicPort,
      useSSL: config.useSSL,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
    });
  }

  get bucket(): string {
    return this.config.bucket;
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  async ensureBucket(): Promise<void> {
    const exists = await this.client.bucketExists(this.bucket);
    if (!exists) {
      await this.client.makeBucket(this.bucket);
      this.logger.log(`Created bucket "${this.bucket}"`);
    }
  }

  buildVideoObjectKey(channelId: string, videoUrlId: string): string {
    return `videos/${channelId}/${videoUrlId}`;
  }

  buildThumbnailObjectKey(channelId: string, videoUrlId: string): string {
    return `thumbnails/${channelId}/${videoUrlId}.jpg`;
  }

  /**
   * Presigned PUT used by the client to upload the file (up to 10GB) straight
   * to the object storage, bypassing the API entirely.
   */
  async createPresignedUploadUrl(objectKey: string): Promise<string> {
    return this.publicClient.presignedPutObject(
      this.bucket,
      objectKey,
      this.config.presignedUrlExpirationSeconds,
    );
  }

  /**
   * Presigned GET used for streaming. The storage itself honours HTTP Range
   * requests, so playback starts without downloading the whole file.
   */
  async createPresignedStreamUrl(objectKey: string): Promise<string> {
    return this.publicClient.presignedGetObject(
      this.bucket,
      objectKey,
      this.config.presignedUrlExpirationSeconds,
    );
  }

  /**
   * Presigned GET that forces a browser download with a friendly file name.
   */
  async createPresignedDownloadUrl(
    objectKey: string,
    fileName: string,
  ): Promise<string> {
    return this.publicClient.presignedGetObject(
      this.bucket,
      objectKey,
      this.config.presignedUrlExpirationSeconds,
      {
        'response-content-disposition': `attachment; filename="${sanitizeFileName(fileName)}"`,
      },
    );
  }

  async objectExists(objectKey: string): Promise<boolean> {
    try {
      await this.client.statObject(this.bucket, objectKey);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Streams an object straight to disk. Implemented with `getObject` + a write
   * stream (instead of `fGetObject`) so the download is a single pass with no
   * intermediate `.part` file, which keeps the worker's temp dir predictable.
   */
  async downloadToFile(objectKey: string, targetPath: string): Promise<void> {
    await mkdir(dirname(targetPath), { recursive: true });
    const objectStream = await this.client.getObject(this.bucket, objectKey);
    await pipeline(objectStream, createWriteStream(targetPath));
  }

  async uploadFile(
    objectKey: string,
    sourcePath: string,
    contentType?: string,
  ): Promise<void> {
    await this.client.fPutObject(
      this.bucket,
      objectKey,
      sourcePath,
      contentType ? { 'Content-Type': contentType } : {},
    );
  }

  async removeObject(objectKey: string): Promise<void> {
    await this.client.removeObject(this.bucket, objectKey);
  }
}

export function sanitizeFileName(fileName: string): string {
  const cleaned = fileName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9-_. ]/g, '')
    .trim()
    .replace(/\s+/g, '-');

  return cleaned.length > 0 ? cleaned : 'video';
}
