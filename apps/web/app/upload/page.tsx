import type { Metadata } from 'next';
import { UploadForm } from './upload-form';

export const metadata: Metadata = { title: 'Upload footage' };

// Rendered only after <RequireRole> in the layout restores the session in the browser; see the layout's note.
export const instant = false;

export default function UploadPage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8">
      <h1 className="font-display text-5xl font-extrabold">Upload footage</h1>
      <p className="mt-2 text-muted">
        Share the original photo or video from your gallery. Files forwarded through WhatsApp lose details that help us
        check them.
      </p>
      <p className="mt-4 rounded-lg border-l-4 border-signal bg-signal-soft px-4 py-3 font-semibold">
        Help first, film only if safe. Call 112 in an emergency.
      </p>
      <UploadForm />
    </div>
  );
}
