import { DomainException } from '../common/exceptions/domain.exception';

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super('CHANNEL_NOT_FOUND', 404, 'Channel not found for the current user');
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready for playback yet');
  }
}

export class NotVideoOwnerException extends DomainException {
  constructor() {
    super('NOT_VIDEO_OWNER', 403, 'Video does not belong to the current user');
  }
}

export class VideoFileMissingException extends DomainException {
  constructor() {
    super(
      'VIDEO_FILE_MISSING',
      422,
      'No uploaded file was found for this video',
    );
  }
}

export class InvalidVideoStateException extends DomainException {
  constructor(message: string) {
    super('INVALID_VIDEO_STATE', 409, message);
  }
}
