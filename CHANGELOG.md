# Changelog

## Terra dinamica 2 - 2026-11-13

- Orologio Terra contro orologio atomico: UTC e UT1 affiancati al millesimo, con la stima del prossimo secondo intercalare e di quando lo scarto arriverà a un minuto.
- "Com'era la Terra in un giorno qualsiasi": per ogni data dal 1900 durata del giorno, spostamento del polo, secondi intercalari, inclinazione dell'asse, campo magnetico, Luna, Sole (dal 1932) e terremoto più forte del giorno (USGS). Date famose già pronte e link condivisibile `?data=AAAA-MM-GG`.
- "Ascolta la Terra": la durata del giorno dal 1962 e l'oscillazione del polo trasformate in suono, 60 anni in un minuto.
- Replay della magnetosfera: le ultime 24 ore dello scudo magnetico in 20 secondi.
- Test sui terremoti M7+ e la rotazione: tendenze di lungo periodo tolte e confronto con la serie spostata nel tempo; oggi il risultato è "nessuna prova" e la pagina mostra perché senza quel controllo sembrerebbe significativo.
- Corretti la frase sul 1962 (ora "dall'inizio delle misure moderne") e la riga orizzontale sotto l'Antartide nella mappa della gravità.

## ECHO Constellation - 2026-11-12

- Nuovo riquadro "satelliti" in alto accanto a "terra": apre in una nuova scheda [ECHO Constellation](https://echo-constellation.gimmy077.workers.dev/), la mappa piatta con i satelliti in tempo reale (ISS e Tiangong, Starlink, GPS, GLONASS, Galileo, BeiDou, OneWeb, Amazon Leo, Iridium). È un progetto a parte, ospitato su Cloudflare.

## Terra dinamica - 2026-11-08

- Nuova pagina `terra.html`: durata del giorno dal 1962 e UT1−UTC con i secondi intercalari (IERS via CelesTrak), traccia e deriva del polo di rotazione, inclinazione dell'asse (nutazione 18,6 anni e ciclo di 41 000 anni), magnetosfera in tempo reale (forma della magnetopausa con il modello di Shue, vento solare, Bz, Dst, Kp, ovale aurorale OVATION), campo magnetico IGRF dal 1900 e calcolatore della gravità con mappa e anomalie.
- Nuovo riquadro "terra" in alto accanto alla radiazione; link anche dalla pagina radiazione e nella sitemap.

## v1.10.0 - 2026-11-07

- Nuova pagina `radiazione.html`: radiazione spaziale dal rilevatore ECHO (sismo-fvg) con valori attuali, grafici delle ultime 24 ore (protoni, elettroni, raggi X, vento solare, Kp), storico giornaliero del rilevatore, cicli solari dal 1932 (macchie, F10.7), tempeste geomagnetiche per anno e le tempeste record.
- Nuovo riquadro "radiazione" (scala S) in alto accanto al Kp, che apre la pagina.
- Nuova scheda "Radiazione spaziale" nella colonna laterale con i valori attuali e il mini-grafico dei protoni nelle 24 ore.
- Nuova fonte "Radiazione · ECHO" nello stato delle fonti, aggiornata ogni 10 minuti.
- Dati da `sismo-fvg.gimmy077.workers.dev/api/radiation` e `/api/radiation/history` (nuovo endpoint).

## v1.9.9 - 2026-10-16

- Aggiunta la fonte `USGS`, `EMSC` o `INGV` al tooltip dei terremoti sul globo.
- Allineato anche il tooltip manuale usato nelle viste aggregate 7g/30g.
- Nessuna modifica ai feed, alla geometria o al carico di rendering del globo.
- Aggiornati versione degli asset, sitemap, TODO e test automatici.
- Verifiche completate: 19 test logici/DOM superati, incluso il nuovo controllo delle tre fonti, e prova visiva locale approvata dall'utente.
- Pubblicazione autorizzata dall'utente il 2026-10-16.
