/** Name of the BullMQ queue that carries video processing jobs. */
export const VIDEO_PROCESSING_QUEUE = 'video-processing';

/** Name of the single job type handled by the video worker. */
export const PROCESS_VIDEO_JOB = 'process-video';

/** Length of the public, URL-safe video identifier generated with nanoid. */
export const VIDEO_URL_ID_LENGTH = 11;

/**
 * Payload of a `process-video` job. Kept intentionally small: the worker reads
 * the authoritative state from the database (phase-03-videos/TD-01).
 */
export interface ProcessVideoJobData {
  videoId: string;
  storageKey: string;
}
