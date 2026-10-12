# Fonti e diagnostica

## SISMO v1.9.7

INGV e Kp non dipendono piu dal Worker ECHO. Il browser interroga direttamente:

- INGV: `https://webservices.ingv.it/fdsnws/event/1/query`, formato GeoJSON.
- NOAA: `https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json`.

Le aree INGV sono quelle del repository `gmy77/sismo-echo`:
FVG latitudine 45.5-46.8, longitudine 12.4-14.1; Campi Flegrei/Vesuvio/Ischia
latitudine 40.4-41.1, longitudine 13.7-14.8. La soglia SISMO resta M0.3.
Ogni area ha una cache indipendente in memoria. HTTP 204 significa nessun evento,
non un errore. In caso di errore resta il catalogo precedente di quell'area;
lo stato INGV segnala errore anche se l'altra area ha risposto (copertura parziale).

Kp mantiene la semantica precedente: massimo giornaliero, non valore istantaneo.
Il giorno e l'orario dell'ultimo campione sono nel tooltip. Campioni piu vecchi
di 12 ore non sono accettati come aggiornamento riuscito. Il precedente valore,
se presente, resta visibile con lo stato della fonte in errore.

Le fonti vengono aggiornate ogni 10 minuti, fuori dal ciclo di animazione.
Il grafico GOES conserva il caricamento su richiesta e la cache di 5 minuti.

## Controlli

Aprire "Stato delle fonti" per vedere l'ultima ricezione riuscita. Per errori
di rete, HTTP o parsing usare Console e Network degli strumenti del browser:
i messaggi distinguono INGV FVG, INGV Campi Flegrei e Kp NOAA diretto.
Verificare sempre la versione dello script e la data dei dati, non solo HTTP 200.

Test: `NODE_PATH` deve indicare un'installazione di `linkedom`, quindi
eseguire `node tests/logic.cjs` dalla radice. Le prove DOM non sostituiscono
le verifiche reali CORS, WebGL e delle fonti nel browser.

## Cloudflare ECHO

Verifica in sola lettura del 12 ottobre 2026: il Worker `sismo-fvg` ha
Observability abilitata, logs persistenti e invocation logs al 100%, traces
al 100% e Issues abilitati. Logpush non e abilitato. Nel repository ECHO,
`sismo-worker/wrangler.toml` contiene `[observability] enabled = true`.

Per consultare: Cloudflare > Workers & Pages > sismo-fvg > Observability
(logs, traces, issues). Una query sul servizio nelle ultime 24 ore non ha
restituito eventi e la lista Issues non ha restituito elementi. Questo NON
dimostra che il Worker sia sano: richieste bloccate prima dell'esecuzione
possono non produrre log del Worker.

I log del Worker NON raccolgono automaticamente errori JavaScript o fetch
dirette di SISMO, ospitato su GitHub Pages. Non sono stati cambiati permessi,
destinazioni o servizi Cloudflare, ne aggiunta telemetria dei visitatori.
