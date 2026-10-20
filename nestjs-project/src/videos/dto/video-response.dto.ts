import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class UploadIntentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    example: 'V1StGXR8Z5j',
    description: 'Short public identifier used in playback URLs',
  })
  video_url_id: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({
    description:
      'Presigned PUT URL. The client uploads the file directly to the object storage.',
    example: 'http://localhost:9000/streamtube/videos/...',
  })
  upload_url: string;

  @ApiProperty({
    description: 'Object key reserved for this upload',
    example: 'videos/2f2c.../V1StGXR8Z5j',
  })
  storage_key: string;

  @ApiProperty({
    description: 'Seconds until the presigned upload URL expires',
    example: 3600,
  })
  expires_in: number;
}

export class VideoMetadataDto {
  @ApiProperty({ required: false, example: 1920 })
  width?: number;

  @ApiProperty({ required: false, example: 1080 })
  height?: number;

  @ApiProperty({ required: false, example: 'h264' })
  video_codec?: string;

  @ApiProperty({ required: false, example: 'aac' })
  audio_codec?: string;

  @ApiProperty({ required: false, example: 1490000 })
  bit_rate?: number;

  @ApiProperty({ required: false, example: 'mov,mp4,m4a,3gp,3g2,mj2' })
  format_name?: string;

  @ApiProperty({ required: false, example: 10485760 })
  size_bytes?: number;
}

export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'V1StGXR8Z5j' })
  video_url_id: string;

  @ApiProperty({ example: 'My holiday video' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.READY })
  status: VideoStatus;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Duration in seconds, filled in by the worker',
    example: 125,
  })
  duration: number | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Presigned URL of the generated thumbnail',
    example: 'http://localhost:9000/streamtube/thumbnails/...',
  })
  thumbnail_url: string | null;

  @ApiProperty({ required: false, nullable: true, type: VideoMetadataDto })
  metadata: VideoMetadataDto | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Failure reason when status is "error"',
    example: null,
  })
  processing_error: string | null;

  @ApiProperty()
  created_at: Date;

  @ApiProperty()
  updated_at: Date;
}
