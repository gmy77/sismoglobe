# SismoGlobe v1.9.0 — preparazione, non pubblicata

Base: gmy77/sismoglobe, commit 07cf19c9d36f9b1075d77d4324af35e8f67092d5.
Ramo locale: feat/views-sources-performance.

## Modifiche
- Stato distinto per USGS corrente/storico, EMSC catalogo/diretta, INGV e Kp via ECHO.
- Ultima ricezione riuscita, segnalazione errori/ritardi, conservazione dell'ultimo catalogo disponibile.
- Vista 2D canvas, senza nuove dipendenze o richieste per mappe di base: riusa world-atlas e placche.
- Pan, zoom, clic su evento e paese; filtri, lista e replay condivisi col globo.
- Preferiti di inquadratura: Mondo, Italia, Friuli e fino a 20 viste personalizzate in localStorage.
- Modalità animazioni ridotte, rispetto di prefers-reduced-motion all'avvio.
- Canvas 3D limitato all'area visibile, senza disegnare fuori schermo.
- Globo sospeso in vista 2D, con guida aperta e scheda nascosta; replay sospeso in background.
- Anelli limitati a 6 oltre 5000 eventi, 10 oltre 600, 20 altrimenti; zero in modalità ridotta.
- Lista del replay ricostruita al massimo una volta al secondo anziché cinque.
- Puntamento durante trascinamento sospeso, movimento mouse limitato a 20 controlli/s.
- Input filtro magnitudo raggruppati per frame; aggiornamento testi temporali senza ricostruire la geometria.
- Timeout di 20 secondi sui feed e protezione dalle risposte USGS obsolete anche nel ramo errore.

## Verifiche completate
- node --check main.js e explorer.js; git diff --check.
- 10 test in tests/logic.cjs con DOM simulato (linkedom), inclusi 12000 eventi sintetici.
- I test coprono dimensioni canvas, fusione punti, limite anelli, passaggio 2D/3D, filtro,
  sospensione in background, stato fonti, preferiti e throttling della lista replay.
- I test NON eseguono un browser, WebGL o rasterizzazione canvas reale e NON misurano FPS.

Ripetizione test dalla cartella del progetto:
  npm install --prefix /tmp/sismo-tests linkedom@0.18.13 --no-audit --no-fund
  NODE_PATH=/tmp/sismo-tests/node_modules node tests/logic.cjs

## Verifiche ancora necessarie
- Aspetto desktop e telefono, accessibilità dei controlli nel pannello, zoom e pan reali.
- Integrità dei confini 2D, puntamento degli eventi e funzionamento di tutti i feed.
- Confronto ripetibile baseline/v1.9.0 con dati identici: frame time p50/p95,
  frame oltre 50 ms, interazione durante rotazione e replay con 12000 eventi.
- Pubblicazione solo dopo verifica dell'anteprima; aspettare l'HTML nuovo prima di
  richiedere main.js/style.css/explorer.js col nuovo parametro versione.

## Blocco della sessione
Il repository dichiara push=true per l'utente, ma il collegamento GitHub rifiuta
la creazione del ramo con 403 Resource not accessible by integration.
Cloudflare consente letture ma rifiuta creazione Worker/Pages (access/authentication error).
Nessun ramo remoto, anteprima o modifica al sito principale è stato pubblicato.
Il browser remoto non può aprire localhost. Il sito pubblico è stato aperto ma
è rimasto nello stato Caricamento del pianeta, senza permettere una misura attendibile.
