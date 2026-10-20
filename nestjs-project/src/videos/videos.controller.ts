import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CreateUploadIntentDto } from './dto/create-upload-intent.dto';
import {
  UploadIntentResponseDto,
  VideoResponseDto,
} from './dto/video-response.dto';
import { VideosService } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('upload-intent')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create an upload intent',
    description:
      'Reserves a video record in draft status and returns a short-lived presigned URL. The client uploads the file (up to 10GB) directly to the object storage with a single HTTP PUT, so the API never handles the bytes.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload intent created',
    type: UploadIntentResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Channel not found for the current user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async createUploadIntent(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateUploadIntentDto,
  ): Promise<UploadIntentResponseDto> {
    return this.videosService.createUploadIntent(user.sub, dto);
  }

  @Post(':id/upload-complete')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Confirm an upload and start processing',
    description:
      'Verifies that the uploaded object exists in the storage, moves the video to processing status and enqueues the asynchronous processing job (duration extraction and thumbnail generation).',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Internal video id' })
  @ApiResponse({
    status: 202,
    description: 'Processing accepted and enqueued',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is already processing or processed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description: 'No uploaded file was found in the storage',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VideoResponseDto> {
    return this.videosService.completeUpload(user.sub, id);
  }

  @Get()
  @ApiBearerAuth()
  @ApiOperation({
    summary: "List the current user's videos",
    description:
      "Returns every video of the authenticated user's channel, newest first, including processing status, duration and thumbnail URL.",
  })
  @ApiResponse({
    status: 200,
    description: 'Videos listed',
    type: [VideoResponseDto],
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async listMyVideos(
    @CurrentUser() user: JwtPayload,
  ): Promise<VideoResponseDto[]> {
    return this.videosService.findOwnedVideos(user.sub);
  }

  @Get(':id')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get processing status and details of a video',
    description:
      'Returns the current status of the video so the client can poll until it becomes ready or error.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Internal video id' })
  @ApiResponse({
    status: 200,
    description: 'Video found',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getVideo(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VideoResponseDto> {
    return this.videosService.findOwnedVideoDetails(user.sub, id);
  }

  @Public()
  @Get(':videoUrlId/stream')
  @Redirect('', HttpStatus.FOUND)
  @ApiOperation({
    summary: 'Stream a ready video',
    description:
      'Redirects (302) to a short-lived presigned URL served by the object storage. The storage honours HTTP Range requests, so players can seek and start playback without downloading the whole file.',
  })
  @ApiParam({
    name: 'videoUrlId',
    description: 'Short public video identifier',
    example: 'V1StGXR8Z5j',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned streaming URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('videoUrlId') videoUrlId: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getStreamUrl(videoUrlId);
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Public()
  @Get(':videoUrlId/download')
  @Redirect('', HttpStatus.FOUND)
  @ApiOperation({
    summary: 'Download a ready video',
    description:
      'Redirects (302) to a short-lived presigned URL that forces a file download with a friendly file name.',
  })
  @ApiParam({
    name: 'videoUrlId',
    description: 'Short public video identifier',
    example: 'V1StGXR8Z5j',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned download URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for download yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('videoUrlId') videoUrlId: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getDownloadUrl(videoUrlId);
    return { url, statusCode: HttpStatus.FOUND };
  }
}
