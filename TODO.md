# TODO SismoGlobe

Idee e controlli per le prossime sessioni. Stato aggiornato: **v1.9.9** (2026-10-16).

## Da fare

### Terra dinamica (`terra.html`, idee del 2026-11-08)

- [x] **Nuove sezioni del 2026-11-13** (provate in locale, da pubblicare): orologio Terra/atomico (UT1 da EOP
  interpolato), "Com'era la Terra in un giorno qualsiasi" (`?data=AAAA-MM-GG`, preset storici, dati IERS dal
  1962, Sole mensile dal 1932 dallo storico ECHO, terremoto più forte del giorno da USGS, Luna, campo IGRF),
  "Ascolta la Terra" (Web Audio, 60 anni in 60 s), replay dello scudo 24 h in 20 s, test onesto terremoti
  M7+ contro rotazione (tendenze tolte + spostamenti circolari: oggi p ≈ 0,29, nessuna prova; senza togliere
  le tendenze sarebbe p ≈ 0,02, trappola mostrata nella pagina).

- [x] **Frase "dal 1962" fraintendibile** — nel riquadro "Il giorno più corto mai misurato" (funzione
  `renderRotation`, testo dentro `insights('ins-rot', …)`) la frase "più veloce di qualunque altro giorno
  dal 1962" fa pensare che nel 1962 sia successo qualcosa. In realtà il 1962 è solo l'inizio della serie
  IERS e quell'anno i giorni erano lunghi (media +1,31 ms, nessuno sotto le 24 h). Riscrivere ad esempio:
  "…di qualunque altro giorno dall'inizio delle misure moderne (1962)". Valutare se aggiungere una riga
  sul perché i record cadono sempre fra fine giugno e inizio luglio (venti estivi + marea lunare + nucleo).
  Fatto il 2026-11-13: frase riscritta e aggiunto il riquadro "Perché i record cadono a inizio estate".
- [x] **Riga chiara sotto l'Antartide nella mappa della gravità** — in fondo alla mappa resta una sottile
  linea orizzontale: è il contorno dell'Antartide che in `land-110m` si chiude lungo il parallelo −90°.
  In `drawGravityMap` saltare il tratto del contorno (stroke) quando due punti consecutivi stanno entrambi
  sotto circa −89,9°, lasciando invariato il riempimento.
  Fatto il 2026-11-13: la causa vera era diversa. In `land-110m` l'Antartide arriva solo a −85,6° e il suo
  anello fa il giro completo delle longitudini: `closePath` tracciava un segmento orizzontale da −180° a
  +180°. Ora per gli anelli circumpolari il riempimento scende fino a −90° e il contorno resta aperto.

- [ ] **Valore vivo nel riquadro 🧭 del globo** — oggi mostra solo l'icona. Far vedere un numero che
  cambia, ad esempio la durata del giorno (`+1,2 ms`) o la distanza dello scudo magnetico (`10 R⊕`),
  colorato come gli altri riquadri. Richiede codice in `main.js` (fetch NOAA/CelesTrak) e quindi bump di
  `APP_VERSION` e dei `?v=` in `index.html`. CelesTrak EOP-All pesa ~2,4 MB: per il globo usare
  `EOP-Last5Years.csv` (~230 KB) o solo i dati NOAA.
- [ ] **Avviso tempesta sul globo** — toast quando la magnetopausa scende sotto 8 R⊕ (sotto 6,6 R⊕ i
  satelliti geostazionari restano fuori dallo scudo) o quando il Dst scende sotto −50 nT. Stessa logica
  di soglia già usata per il Kp; un solo avviso per evento, non ad ogni aggiornamento.
- [ ] **Terremoti e rotazione** — sul grafico della durata del giorno segnare con linee verticali i
  grandi sismi (Cile 1960, Alaska 1964, Sumatra 2004, Cile 2010, Tōhoku 2011), con tooltip
  dell'effetto calcolato (es. Tōhoku −1,8 µs). Nota onesta da mettere: l'effetto è di microsecondi,
  invisibile nel grafico in millisecondi, quindi le linee servono a dare il contesto e non sono una
  correlazione visibile.
- [ ] **Vera mappa delle anomalie di gravità** — sostituire la gravità solo teorica (latitudine e quota)
  con una griglia misurata dai satelliti (geoide EGM2008 o anomalie in aria libera GOCE/GRACE, da ICGEM).
  Serve un file pre-elaborato a bassa risoluzione (es. 1°×1°, PNG o JSON compresso) ospitato nel repo,
  perché i servizi originali non hanno CORS e sono troppo pesanti.

- [ ] **Rotazione automatica dopo lo spostamento laterale del globo** — con `Shift + trascina` viene
  spostato anche il centro orbitale (`controls.target`). Tre secondi dopo il rilascio, il gestore
  `pointerup` riattiva sempre `autoRotate` se la casella "rotazione" è selezionata: la telecamera inizia
  così a ruotare attorno a un punto decentrato. Il globo scivola lentamente verso il lato opposto e cambia
  dimensione apparente mentre la distanza fra telecamera e Terra varia. Riprodotto visivamente il
  2026-10-17 fra le 11:34:52 e le 11:39:35.
  Correzione proposta: se dopo l'interazione `controls.target` non è al centro, lasciare la rotazione
  disattivata e allineare la casella nell'interfaccia; permettere la ripartenza dopo `Ricentra` o dopo una
  nuova scelta esplicita dell'utente. Verificare separatamente trascinamento normale, `Shift + trascina`,
  rotella, `Ricentra`, "vola sui nuovi" e comportamento desktop/mobile, senza modificare il rendering.

- [x] **Fonte nel tooltip del globo** — passando il mouse su un punto mostrare se l'evento è USGS, EMSC o
  INGV, come già fanno le etichette `.q-src` nella lista. Il tooltip è in `pointLabel` (main.js, setup del
  globo) e, con i punti fusi delle viste 7g/30g, nel tooltip manuale `customTip`: aggiornati entrambi in v1.9.9.

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
- Provare in locale con `python -m http.server 18080 --bind 127.0.0.1` (la porta 8765 è bloccata). INGV e
  Kp usano ora le fonti ufficiali dirette: controllare sia gli esiti locali sia quelli pubblici e conservare
  gli ultimi dati validi quando una fonte risponde solo parzialmente o temporaneamente non risponde.
