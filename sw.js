// 診断士ジム service worker: アプリシェルをキャッシュしてオフライン利用を可能にする。
// キャッシュ内容を更新した際は CACHE_NAME のバージョンを上げること
// （合わせて js/version.js の APP_VERSION / APP_UPDATED も更新し、
// 画面右上の表示からデプロイが反映されたかを確認できるようにする）。
const CACHE_NAME = "shindanshi-shell-v16";
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/style.css",
  "./js/app.js",
  "./js/questions.js",
  "./js/cloud-sync.js",
  "./js/version.js",
  "./js/data/subjects.js",
  "./js/data/pastexam/index.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png"
];
// Firebase SDK（gstatic.com）は cache.addAll の必須リストには含めない。
// addAll は1件でも失敗すると全体が失敗し、コアアプリのオフライン化まで
// 巻き添えになるため。初回オンライン利用時に fetch ハンドラのキャッシュ
// 処理（下記）で自動的にキャッシュされ、以降はオフラインでも動作する。

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(
        // cache: "reload" でブラウザのHTTPキャッシュを無視して必ずネットワークから
        // 取得する。指定しないと、直前にページ側が読み込んだ古い応答がHTTPキャッシュ
        // 経由でそのままプリキャッシュされてしまい、SW自体は更新されても中身が
        // 古いままになることがある（Cache-Controlヘッダがない静的ホスティングで発生）。
        PRECACHE_URLS.map((url) => new Request(url, { cache: "reload" }))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// プッシュ通知（Cloud Functions からのFCM webpush配信）。
// title/body のみをJSONで送ってもらい、アイコンや遷移先はこの端末での
// 実際のデプロイパス（self.registration.scope）から組み立てる。
self.addEventListener("push", (event) => {
  var payload = {};
  try {
    var raw = event.data ? event.data.json() : {};
    payload = raw && raw.data ? raw.data : raw;
  } catch (e) {
    // ペイロードがJSONでない場合は本文なしで通知だけ出す
  }
  var title = payload.title || "診断士ジム";
  var body = payload.body || "";
  var scope = self.registration.scope;
  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: new URL("icons/icon-192.png", scope).toString(),
      badge: new URL("icons/icon-192.png", scope).toString(),
      data: { url: scope }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || self.registration.scope;
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  // 「?t=...」付きのURLは更新確認用のキャッシュバスティングリクエスト
  // （js/app.js の checkForNewVersion）であり、常に新規URLのため素通しし、
  // キャッシュに無駄なエントリが溜まらないようにする。
  const isCacheBust = event.request.url.indexOf("?t=") !== -1;
  if (isCacheBust) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
