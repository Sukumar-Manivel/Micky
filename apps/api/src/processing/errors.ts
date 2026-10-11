/**
 * The file itself is the problem (corrupt, no video track, too long...).
 * Retrying cannot help, so the job fails at once and the media becomes FAILED.
 * `message` is shown to the uploader: the web app prints
 * "We could not process this file: <message> Try uploading the original again."
 */
export class PermanentProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentProcessingError';
  }
}

/** Shown to the uploader when processing failed for a reason that is not their file's fault. */
export const GENERIC_FAILURE_MESSAGE = 'something went wrong on our side while processing it.';
