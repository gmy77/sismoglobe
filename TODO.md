# TODO SismoGlobe

Idee e controlli per le prossime sessioni. Stato di partenza: **v1.8.6** (2026-10-03).

## Da fare

- [ ] **Fonte nel tooltip del globo** — passando il mouse su un punto mostrare se l'evento è USGS, EMSC o
  INGV, come già fanno le etichette `.q-src` nella lista. Il tooltip è in `pointLabel` (main.js, setup del
  globo) e, con i punti fusi delle viste 7g/30g, nel tooltip manuale `customTip`: vanno aggiornati entrambi.

- [ ] **Doppioni USGS/EMSC nelle sequenze fitte** — nello sciame in Kamchatka di inizio ottobre 2026 alcune
  scosse compaiono due volte, perché USGS ed EMSC ne stimano la magnitudo con 0.5 o più di differenza e il
  confronto (`isSameEmscUsgsEvent`: 6 min, mag < 0.5, 150 km) non le riconosce come lo stesso evento.
  Prima misurare quanti casi ci sono sui 30 giorni (script di confronto in Node sui feed reali), poi valutare
  una tolleranza sulla magnitudo più larga (es. < 1.0) solo quando tempo e posizione sono molto vicini
  (es. < 60 s e < 50 km), per non fondere scosse diverse e quasi simultanee.

- [ ] **Larghezza del canvas del globo** — in prova dentro un iframe (1380 px) il canvas risultava largo
  1712 px. Non si vede (body ha `overflow: hidden`), ma conviene controllare `fitGlobe()` a varie
  larghezze, anche su telefono vero.

## Promemoria

- Dopo modifiche a testi o fonti: aggiornare `lastmod` in `sitemap.xml` e, se serve, inviare di nuovo la
  sitemap da Google Search Console / Bing Webmaster Tools.
- Deploy: aumentare `?v=` di `main.js`/`style.css` in `index.html` e `APP_VERSION` in `main.js`; dopo il
  push aspettare che l'HTML live mostri la nuova versione **prima** di richiedere gli asset con il nuovo
  `?v=` (altrimenti Cloudflare mette in cache il file vecchio sotto il nuovo indirizzo per 1 ora).
- Provare in locale con `python -m http.server 18080 --bind 127.0.0.1` (la porta 8765 è bloccata). Da
  localhost il feed INGV di sismo-fvg non si carica: è normale, sul sito pubblico funziona.
