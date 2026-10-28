// Offline support. The app shell is cached on install; an updated version waits until the
// user clicks Reload (so an edit is never interrupted); the 32 MB format converter is cached
// the first time it's used (or when the user downloads it from Movie settings).
// Bump VERSION whenever any file below changes so installed copies update.

const VERSION = 'cutline-v1.0.0';
const RUNTIME = 'cutline-runtime-v1';

// Every file the app needs to start offline. `npm run check:sw` fails if this list is out of date.
const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'icons/apple-touch-icon.png',
  'icons/favicon.ico',
  'icons/favicon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'js/actions.js',
  'js/core/audioenv.js',
  'js/core/formats.js',
  'js/core/gifplan.js',
  'js/core/history.js',
  'js/core/model.js',
  'js/core/mp4meta.js',
  'js/core/overlays.js',
  'js/core/render-plan.js',
  'js/core/scenes.js',
  'js/core/split.js',
  'js/core/srt.js',
  'js/core/time.js',
  'js/core/timeline.js',
  'js/core/util.js',
  'js/engine/compositor.js',
  'js/engine/convert.js',
  'js/engine/exporter.js',
  'js/engine/framerender.js',
  'js/engine/gif.js',
  'js/engine/media.js',
  'js/engine/player.js',
  'js/engine/scenes.js',
  'js/engine/storage.js',
  'js/main.js',
  'js/store.js',
  'js/ui/dialogs.js',
  'js/ui/dom.js',
  'js/ui/drag.js',
  'js/ui/export-dialog.js',
  'js/ui/menu.js',
  'js/ui/preview.js',
  'js/ui/properties.js',
  'js/ui/storyboard.js',
  'js/ui/timeline.js',
  'js/ui/toolbar.js',
  'js/ui/workspace.js',
  'vendor/fflate.mjs',
  'vendor/gifenc.mjs',
  'vendor/heic2any.min.js',
  'vendor/mp4-muxer.mjs',
  'vendor/webm-muxer.mjs',
  'vendor/ffmpeg/classes.js',
  'vendor/ffmpeg/const.js',
  'vendor/ffmpeg/errors.js',
  'vendor/ffmpeg/index.js',
  'vendor/ffmpeg/types.js',
  'vendor/ffmpeg/utils.js',
  'vendor/ffmpeg/worker.js',
];

// Large files cached on first use instead of at install.
const ON_DEMAND = ['vendor/ffmpeg/ffmpeg-core.js', 'vendor/ffmpeg/ffmpeg-core.wasm'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(PRECACHE.map((p) => new Request(p, { cache: 'reload' })))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'skipWaiting') self.skipWaiting();
});

function isOnDemand(url) {
  return ON_DEMAND.some((p) => url.pathname.endsWith('/' + p));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (isOnDemand(url)) {
    event.respondWith(
      caches.open(RUNTIME).then(async (cache) => {
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('index.html', { ignoreSearch: true }).then((hit) => hit || fetch(req)).catch(() => fetch(req)),
    );
    return;
  }

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req);
    }),
  );
});
