// Uploading with a progress bar.
//
// `fetch()` cannot report upload progress in browsers today, but XMLHttpRequest can, through
// `xhr.upload.onprogress`. So uploads use XHR, wrapped in a Promise. Everything else uses fetch.
//
// The access token may expire during a long upload on a slow phone network. If the server
// answers 401 we refresh the session (sharing the single-flight refresh with fetch calls) and
// send the file once more.

import { API_BASE } from './config';
import { ApiError, errorMessageFromBody, session } from './api';
import type { MediaOwnerView, UploadFields } from './types';

export interface UploadHandle {
  promise: Promise<MediaOwnerView>;
  abort: () => void;
}

function buildForm(file: File, fields: UploadFields): FormData {
  const form = new FormData();
  form.set('title', fields.title);
  if (fields.description) form.set('description', fields.description);
  form.set('category', fields.category);
  form.set('latitude', String(fields.latitude));
  form.set('longitude', String(fields.longitude));
  if (fields.locationName) form.set('locationName', fields.locationName);
  form.set('capturedAt', fields.capturedAt);
  if (fields.priceNonExclusive !== undefined) form.set('priceNonExclusive', String(fields.priceNonExclusive));
  if (fields.priceExclusive !== undefined) form.set('priceExclusive', String(fields.priceExclusive));
  form.set('rightsConfirmed', 'true');
  // The file goes last so the server can validate the text fields before streaming bytes.
  form.set('file', file);
  return form;
}

/** Friendlier messages for the errors an uploader is most likely to hit. */
function uploadErrorMessage(status: number, body: unknown): string {
  if (status === 413) return 'This file is too big. Videos can be up to 500 MB and photos up to 25 MB.';
  if (status === 415) return 'This file type is not supported. Use an MP4, MOV or WebM video, or a JPEG, PNG, HEIC or WebP photo.';
  if (status === 409) return 'This exact file has already been uploaded to FirstFrame.';
  return errorMessageFromBody(body, status);
}

export function uploadMedia(
  file: File,
  fields: UploadFields,
  onProgress: (fraction: number) => void,
): UploadHandle {
  let current: XMLHttpRequest | null = null;
  let aborted = false;

  const sendOnce = (token: string | null) =>
    new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      current = xhr;
      xhr.open('POST', `${API_BASE}/media`);
      xhr.withCredentials = true;
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      // Do NOT set Content-Type: the browser adds multipart/form-data with the boundary.
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        let body: unknown = null;
        try {
          body = xhr.responseText ? (JSON.parse(xhr.responseText) as unknown) : null;
        } catch {
          body = null;
        }
        resolve({ status: xhr.status, body });
      };
      xhr.onerror = () => reject(new TypeError('Network error'));
      xhr.onabort = () => reject(new ApiError(0, 'Upload cancelled.'));
      xhr.send(buildForm(file, fields));
    });

  const promise = (async () => {
    let res = await sendOnce(session.getToken());
    if (res.status === 401 && !aborted) {
      const fresh = await session.refresh();
      if (!fresh) throw new ApiError(401, 'Your session has ended. Please log in again.');
      onProgress(0);
      res = await sendOnce(fresh);
    }
    if (res.status < 200 || res.status >= 300) throw new ApiError(res.status, uploadErrorMessage(res.status, res.body));
    return res.body as MediaOwnerView;
  })();

  return {
    promise,
    abort: () => {
      aborted = true;
      current?.abort();
    },
  };
}
