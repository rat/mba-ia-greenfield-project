import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * Entrypoint of the dedicated video worker process. Runs as its own container
 * (`video-worker` in compose.yaml) with FFmpeg installed.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: false,
  });
  app.enableShutdownHooks();

  const logger = new Logger('VideoWorker');
  logger.log('Video worker started and listening for jobs');
}

void bootstrap();
