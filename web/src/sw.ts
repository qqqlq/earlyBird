/// <reference lib="WebWorker" />
import { precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope;

// vite-plugin-pwa（injectManifest）が注入するprecacheマニフェスト
precacheAndRoute(self.__WB_MANIFEST);

// push通知受信 → 通知を表示
self.addEventListener('push', () => {
  self.registration.showNotification('earlyBird ⏰', {
    body: '起きる時間です！アプリを開いて筋トレを完了してください',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: 'earlybird-alarm',
    requireInteraction: true,
    silent: false,
    // @ts-expect-error - vibrate はAndroid対応
    vibrate: [500, 200, 500, 200, 500],
  });
});

// 通知クリック → PWAを前面化、なければ /alarm を開く
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // 既存のPWAウィンドウがあればfocus
        for (const client of clientList) {
          if ('focus' in client) {
            client.postMessage({ type: 'ALARM_TRIGGERED' });
            return client.focus();
          }
        }
        // なければ新規で /alarm を開く
        return self.clients.openWindow('/alarm');
      }),
  );
});

// Service Worker インストール・アクティベーション
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
