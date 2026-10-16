/* Endereço antigo desativado: a ficha mudou para https://traumapscgepm.github.io/
   Este service worker apaga o cache antigo, se desliga e recarrega as abertas,
   para que o aviso de mudança apareça mesmo em quem tinha o app instalado. */
self.addEventListener("install", function(){ self.skipWaiting(); });
self.addEventListener("activate", function(e){
  e.waitUntil(
    caches.keys().then(function(ks){ return Promise.all(ks.map(function(k){ return caches.delete(k); })); })
      .then(function(){ return self.registration.unregister(); })
      .then(function(){ return self.clients.matchAll({type:"window"}); })
      .then(function(cs){ cs.forEach(function(c){ c.navigate(c.url); }); })
  );
});
