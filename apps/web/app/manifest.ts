import type { MetadataRoute } from 'next';

// The web app manifest makes FirstFrame installable ("Add to Home screen"), which matters for
// uploaders who should be able to open it in seconds when something happens. There is
// deliberately no service worker caching API data: stale prices or availability would be wrong.
export default function manifest(): MetadataRoute.Manifest {
  return {
    // A stable identity for the installed app, so changing start_url later does not create a second app.
    id: '/',
    name: 'FirstFrame',
    short_name: 'FirstFrame',
    lang: 'en-IN',
    dir: 'ltr',
    description: 'Upload verified eyewitness footage. Newsrooms license it, you get paid.',
    start_url: '/upload',
    scope: '/',
    display: 'standalone',
    background_color: '#0c141b',
    theme_color: '#0c141b',
    categories: ['news', 'photo'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  };
}
