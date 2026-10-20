import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import databaseConfig from './config/database.config';
import { envValidationSchema } from './config/env.validation';
import redisConfig from './config/redis.config';
import storageConfig from './config/storage.config';
import { BullModule } from '@nestjs/bullmq';
import { QueueModule } from './queue/queue.module';
import { StorageModule } from './storage/storage.module';
import { Channel } from './channels/entities/channel.entity';
import { User } from './users/entities/user.entity';
import { Video } from './videos/entities/video.entity';
import { VideoProcessingService } from './videos/video-processing.service';
import { VideoProcessor } from './videos/video.processor';
import { VIDEO_PROCESSING_QUEUE } from './videos/videos.constants';

/**
 * Root module of the standalone video worker process (phase-03-videos/TD-03).
 *
 * It deliberately excludes the HTTP layer: the worker only needs the database,
 * the object storage and the queue consumer.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, redisConfig, storageConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        // The worker resolves the Video relation graph, so the related entities
        // are registered explicitly instead of relying on autoLoadEntities.
        entities: [Video, Channel, User],
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature([Video]),
    StorageModule,
    QueueModule,
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  providers: [VideoProcessingService, VideoProcessor],
})
export class WorkerModule {}
