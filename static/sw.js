// Koffan Service Worker - Offline Support
// __CACHE_VERSION__ and __ASSET_HASH__ are replaced at serve time by
// handlers.ServeServiceWorker using the startup-computed asset hash.
const CACHE_VERSION = 'koffan-__CACHE_VERSION__';
const STATIC_CACHE = CACHE_VERSION + '-static';
const DYNAMIC_CACHE = CACHE_VERSION + '-dynamic';
const NAVIGATION_TIMEOUT_MS = 5000;

// Pattern for list pages
const LIST_PAGE_PATTERN = /^\/lists\/\d+$/;

// Static assets to cache on install
const STATIC_ASSETS = [
    '/static/app.js?v=__ASSET_HASH__',
    '/static/realtime.js?v=__ASSET_HASH__',
    '/static/viewport.js?v=__ASSET_HASH__',
    '/static/offline-storage.js?v=__ASSET_HASH__',
    '/static/offline-crud.js?v=__ASSET_HASH__',
    '/static/offline-view.js?v=__ASSET_HASH__',
    '/static/offline-app.js?v=__ASSET_HASH__',
    '/static/ui-scale.js?v=__ASSET_HASH__',
    '/static/manifest.json',
    '/static/koffan-logo.webp',
    '/static/icon-192.png',
    '/static/icon-512.png',
    '/static/favicon.ico',
    '/static/favicon-96.png',
    '/static/apple-touch-icon.png',
    '/static/tailwind.min.js?v=__ASSET_HASH__',
    '/static/htmx.min.js?v=__ASSET_HASH__',
    '/static/htmx-ws.js?v=__ASSET_HASH__',
    '/static/alpine-collapse.min.js?v=__ASSET_HASH__',
    '/static/alpine.min.js?v=__ASSET_HASH__',
    '/static/sortable.min.js?v=__ASSET_HASH__'
];

// Install event - cache static assets and the app shell
self.addEventListener('install', (event) => {
    console.log('[SW] Installing service worker...');
    event.waitUntil(
        Promise.all([
            caches.open(STATIC_CACHE)
                .then(cache => {
                    console.log('[SW] Caching static assets');
                    return cache.addAll(STATIC_ASSETS).catch(err => {
                        console.warn('[SW] Some static assets failed to cache:', err);
                    });
                }),
            // Precache the app shell so the installed PWA can cold-start offline.
            // Without this, launching offline hits the networkFirst fallback because
            // "/" is otherwise only cached lazily after a successful online load.
            caches.open(DYNAMIC_CACHE)
                .then(cache => Promise.all(['/', '/offline/list'].map(path => fetch(path, { credentials: 'same-origin' })
                    .then(response => {
                        // Skip login redirects and errors so we never cache a non-shell page.
                        if (response.ok && !response.redirected) {
                            return cache.put(path, response);
                        }
                    })
                    .catch(err => console.warn('[SW] App shell precache failed:', err)))))
        ]).then(() => self.skipWaiting())
    );
});

// Activate event - cleanup old caches
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating service worker...');
    event.waitUntil(
        caches.keys()
            .then(keys => {
                return Promise.all(
                    keys.filter(key => {
                        return key.startsWith('koffan-') &&
                               key !== STATIC_CACHE &&
                               key !== DYNAMIC_CACHE;
                    }).map(key => {
                        console.log('[SW] Deleting old cache:', key);
                        return caches.delete(key);
                    })
                );
            })
            .then(() => self.clients.claim())
    );
});

// Fetch event - handle requests
self.addEventListener('fetch', (event) => {
    // Skip non-http(s) requests (chrome-extension, etc.)
    if (!event.request.url.startsWith('http')) {
        return;
    }

    const url = new URL(event.request.url);

    // Requests outside this application must retain their own caching behavior.
    if (url.origin !== self.location.origin || event.request.method !== 'GET') {
        return;
    }

    if (url.pathname.startsWith('/static/')) {
        event.respondWith(cacheFirst(event.request));
        return;
    }

    // Only full documents may fall back to stale content. Cached API responses
    // and HTMX fragments look like successful server replies and can undo local
    // changes or hide a disconnected mobile connection from the application.
    if (event.request.mode === 'navigate') {
        event.respondWith(networkFirst(event.request));
    }

});

// Cache First strategy - for static assets
async function cacheFirst(request) {
    const staticCache = await caches.open(STATIC_CACHE);
    const cached = await staticCache.match(request);
    if (cached) {
        return cached;
    }

    try {
        const response = await fetch(request);
        if (response.ok) {
            try {
                await staticCache.put(request, response.clone());
            } catch (error) {
                console.warn('[SW] Static asset could not be cached:', error);
            }
        }
        return response;
    } catch (error) {
        console.warn('[SW] Cache first failed:', request.url);
        // Return a simple offline page for HTML requests
        if (request.headers.get('accept')?.includes('text/html')) {
            return new Response('<html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fafaf9"><div style="text-align:center"><h1 style="color:#78716c">Koffan Offline</h1><p style="color:#a8a29e">Check your connection</p></div></body></html>', {
                headers: { 'Content-Type': 'text/html' }
            });
        }
        throw error;
    }
}

// Bound document loads when a mobile connection remains up but cannot reach
// the server. Fetch may otherwise hang for minutes before showing the cache.
async function fetchNavigation(request) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NAVIGATION_TIMEOUT_MS);
    try {
        const response = await fetch(request, { signal: controller.signal });
        // Headers can arrive before a mobile connection stalls. Buffer a clone
        // while the timeout remains active, preserving the original redirect and
        // URL metadata for cache safety and the browser's navigation handling.
        await response.clone().arrayBuffer();
        return response;
    } finally {
        clearTimeout(timer);
    }
}

async function cacheDocument(request, response) {
    if (!response.ok || response.redirected) return;
    try {
        const cache = await caches.open(DYNAMIC_CACHE);
        await cache.put(request, response.clone());
    } catch (error) {
        // Cache quota or storage failures must not turn a successful load offline.
        console.warn('[SW] Document could not be cached:', error);
    }
}

// Network First strategy for complete documents only.
async function networkFirst(request) {
    try {
        const response = await fetchNavigation(request);
        await cacheDocument(request, response);
        return response;
    } catch (error) {
        const cache = await caches.open(DYNAMIC_CACHE);
        const cached = await cache.match(request);
        if (cached) return cached;

        const isList = LIST_PAGE_PATTERN.test(new URL(request.url).pathname);
        if (isList || new URL(request.url).pathname === '/offline/list') {
            // The shell renders only the requested list from the durable model.
            // This also supports lists created on this device while offline.
            const shell = await cache.match('/offline/list');
            if (shell) return shell;
        }
        if (!isList) {
            const mainPage = await cache.match('/');
            if (mainPage) return mainPage;
        }
        const message = isList ? 'This list is not saved offline.' : 'Check your connection';
        return new Response(`<html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fafaf9"><div style="text-align:center"><h1 style="color:#78716c">Koffan Offline</h1><p style="color:#a8a29e">${message}</p><a href="/" style="color:#f472b6;text-decoration:none">Back to home page</a></div></body></html>`, {
            status: 503,
            headers: { 'Content-Type': 'text/html' }
        });
    }
}

// Listen for messages from the app
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }

    if (event.data && event.data.type === 'CLEAR_CACHE') {
        event.waitUntil(
            caches.keys().then(keys => {
                return Promise.all(keys.filter(key => key.startsWith('koffan-')).map(key => caches.delete(key)));
            })
        );
    }
});
