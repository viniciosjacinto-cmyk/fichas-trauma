/* Service worker — cache local para funcionamento offline.
   Ao publicar uma versão nova do app, troque o número em CACHE. */
const CACHE = "ficha-trauma-v28";
const ARQUIVOS = ["./", "./index.html", "./manifest.json", "./icon.svg"];
/* logos são opcionais: se não estiverem no repositório, a instalação não pode falhar */
const OPCIONAIS = ["./logo-epm.png", "./logo-unifesp.png", "./logo-epm.svg", "./logo-unifesp.svg"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(ARQUIVOS).then(() => Promise.all(OPCIONAIS.map(u => c.add(u).catch(() => {})))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Estratégia: cache primeiro. O app precisa abrir sem rede, sempre. */
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  /* nunca cachear a nuvem (login e Firestore): só o app e as bibliotecas */
  const u = new URL(e.request.url);
  if (u.origin !== location.origin && u.hostname !== "www.gstatic.com") return;
  e.respondWith(
    caches.match(e.request).then(hit =>
      hit || fetch(e.request).then(resp => {
        const copia = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copia)).catch(() => {});
        return resp;
      }).catch(() => caches.match("./index.html"))
    )
  );
});
