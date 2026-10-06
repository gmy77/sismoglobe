/* SismoGlobe — monitoraggio terremoti in tempo reale (dati USGS) */
'use strict';

const APP_VERSION = 'v1.9.1';
const USGS = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/';
const FEEDS = { day: 'all_day.geojson', week: 'all_week.geojson', month: 'all_month.geojson' };
const POLL_MS = 60_000;          // refresh feed corrente
const MONTH_POLL_MS = 10 * 60_000; // refresh istogramma 30gg
const RING_WINDOW_MS = 3 * 3600_000; // anelli animati per eventi recenti
const REPLAY_RANGE_MS = 30 * 86400_000;   // copre l'intero istogramma dei 30 giorni
const REPLAY_TRAIL_MS = 24 * 3600_000;    // finestra di eventi visibili in un dato istante del replay
const REPLAY_TICK_MS = 200;
const REPLAY_STEP_MS = REPLAY_RANGE_MS / 300; // ~48s reali per rivedere tutto il mese
const FLY_MIN_MAG = 4.5; // soglia magnitudo per il volo automatico "vola sui nuovi"

// USGS registra in modo completo solo sopra M4-4.5 fuori dagli USA: i
// micro-sismi del Friuli Venezia Giulia (M0.3-3) non compaiono quasi mai.
// Il worker sismo-fvg (progetto ECHO, gmy77/sismo-echo) li ingerisce da INGV
// ogni volta che viene aggiornato (cron 4x/giorno + "Aggiorna ora" manuale),
// li salva in D1 e li espone su questo endpoint pubblico (CORS aperto).
const SISMOFVG_BASE = 'https://sismo-fvg.gimmy077.workers.dev';
const INGV_API = SISMOFVG_BASE + '/api/events';
const SOLAR_API = SISMOFVG_BASE + '/api/solar'; // stesso worker: indice Kp giornaliero (NOAA SWPC), utile per l'ipotesi di correlazione sismo/attività solare
const INGV_POLL_MS = 10 * 60_000; // stesso ritmo del refresh mensile: il worker non aggiorna più spesso di così
const INGV_MIN_MAG = 0.3;
// Catalogo EMSC (FDSN, CORS aperto): USGS fuori dagli USA è completo solo
// sopra M4-4.5, EMSC aggiunge ~170 eventi M2.5+ al giorno che USGS non ha
// (Cile, Indonesia, Grecia, sciami in Kamchatka...). Stesso ritmo di INGV.
const EMSC_FDSN = 'https://www.seismicportal.eu/fdsnws/event/1/query';
const EMSC_POLL_MS = 10 * 60_000;
const WINDOW_MS = { day: 86400_000, week: 7 * 86400_000, month: REPLAY_RANGE_MS };

// ---------- Stato ----------
const state = {
  view: '3d',
  quality: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'light' : 'auto',
  window: 'day',
  minMag: 0,
  quakes: [],        // eventi della finestra corrente
  monthQuakes: [],   // cache 30 giorni per istogramma / filtro giorno
  seenIds: new Set(),
  firstLoad: true,
  selectedDay: null, // 'YYYY-MM-DD' UTC oppure null
  selectedCountry: null, // Feature GeoJSON del paese selezionato, oppure null
  sound: false,
  flyToNew: true,
  replay: { active: false, playing: false, t: 0 }, // t = ms trascorsi dall'inizio della finestra di 30gg
  emscLive: true,
  emscPending: [], // eventi EMSC non ancora confermati dal feed USGS
  ingvQuakes: [],  // cache degli eventi FVG/CF da sismo-fvg (fonte INGV), indipendente dalla finestra
  emscQuakes: [],  // cache 30 giorni del catalogo EMSC (fonte 'emsc-cat'), indipendente dalla finestra
  live: { ok: null, at: null }, // esito (true/false, null = in attesa) e Date dell'ultimo poll USGS
  kp: null,        // { day, max, avg } ultimo giorno disponibile del feed solare NOAA (via sismo-fvg), o null se non ancora caricato
};

// ---------- Utility ----------
const $ = id => document.getElementById(id);

function magColor(m) {
  if (m >= 7) return '#ff2d78';
  if (m >= 6) return '#ff3b30';
  if (m >= 5) return '#ff7a00';
  if (m >= 4) return '#ffb300';
  if (m >= 3) return '#ffe14d';
  return '#68e07f';
}

// Soglie NOAA/G-scale: Kp<4 quiete, 4 attivo, 5-6 tempesta minore/moderata (G1-G2), 7+ forte e oltre.
function kpColor(kp) {
  if (kp >= 7) return '#ff2d78';
  if (kp >= 5) return '#ff7a00';
  if (kp >= 4) return '#ffe14d';
  return '#68e07f';
}

function fmtTime(t) {
  return new Date(t).toLocaleString('it-IT', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function timeAgo(t) {
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s fa`;
  if (s < 3600) return `${Math.floor(s / 60)}min fa`;
  if (s < 86400) return `${Math.floor(s / 3600)}h fa`;
  return `${Math.floor(s / 86400)}g fa`;
}

function utcDay(t) {
  return new Date(t).toISOString().slice(0, 10);
}

// USGS valorizza sempre la profondità, ma i messaggi EMSC appena creati a
// volte non l'hanno ancora (arriva con l'aggiornamento successivo): senza
// guardia il template literal stampa "undefined km".
function fmtDepth(depth) {
  return depth != null ? depth.toFixed(0) + ' km' : 'n.d.';
}

// Energia sismica: log10(E) = 1.5*M + 4.8 (Joule)
function energyJoules(m) { return Math.pow(10, 1.5 * m + 4.8); }

function fmtEnergy(j) {
  const tnt = j / 4.184e9; // tonnellate di TNT
  if (tnt >= 1e6) return (tnt / 1e6).toFixed(1) + ' Mt';
  if (tnt >= 1e3) return (tnt / 1e3).toFixed(1) + ' kt';
  return tnt.toFixed(1) + ' t';
}

function quakeWaveformPath(q, width = 268, height = 52) {
  const mid = height / 2;
  const mag = Math.max(0, q.mag || 0);
  const depth = q.depth != null ? Math.max(0, q.depth) : 10;
  const depthDamping = 1 - Math.min(0.62, depth / 700);
  const amp = Math.max(5, Math.min(22, (5 + mag * 2.2) * depthDamping));
  const decay = 2.2 + Math.max(0, 7 - mag) * 0.32 + Math.min(1.2, depth / 260);
  const seed = Math.abs(Math.sin((q.time || 1) * 0.000001 + q.lat * 12.9898 + q.lng * 78.233)) * 3.5;
  const steps = 86;
  let path = '';
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = t * width;
    const attack = Math.min(1, t * 9);
    const envelope = attack * Math.exp(-t * decay);
    const carrier =
      Math.sin(t * Math.PI * (18 + mag * 1.9) + seed) * 0.72 +
      Math.sin(t * Math.PI * (43 + mag * 3.1) + seed * 0.6) * 0.28 +
      Math.sin(t * Math.PI * (91 + mag * 2.2) + seed * 1.4) * 0.14;
    const y = mid - carrier * amp * envelope;
    path += `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `;
  }
  return path.trim();
}

function quakeWaveformSvg(q) {
  const color = magColor(q.mag);
  const path = quakeWaveformPath(q);
  return `
    <div class="waveform" aria-label="Profilo stimato del terremoto">
      <div class="waveform-head">
        <span>profilo stimato</span>
        <span>M ${q.mag.toFixed(1)} · ${fmtDepth(q.depth)}</span>
      </div>
      <svg viewBox="0 0 268 52" role="img" aria-hidden="true" focusable="false">
        <path class="waveform-grid" d="M0 26 H268 M0 13 H268 M0 39 H268"></path>
        <path class="waveform-line" d="${path}" style="stroke:${color}"></path>
      </svg>
      <div class="waveform-note">non è un sismogramma: non distingue terremoto, frana o esplosione</div>
    </div>`;
}

function parseFeed(geojson) {
  return geojson.features
    .filter(f => f.geometry && f.properties.mag != null)
    .map(f => ({
      id: f.id,
      lat: f.geometry.coordinates[1],
      lng: f.geometry.coordinates[0],
      depth: f.geometry.coordinates[2],
      mag: f.properties.mag,
      place: f.properties.place || 'Località sconosciuta',
      time: f.properties.time,
      url: f.properties.url,
      tsunami: f.properties.tsunami === 1,
    }))
    .sort((a, b) => b.time - a.time);
}

// Altezza del punto = profondità dell'ipocentro: gli eventi superficiali (i
// più distruttivi in superficie, vedi guida) si sollevano dal globo, quelli
// profondi restano quasi appiattiti. Scala a radice per rendere visibile la
// differenza anche nei primi km, dove si concentra la maggioranza dei sismi.
function depthAltitude(depth) {
  const d = depth != null ? Math.max(0, depth) : 10;
  const norm = Math.min(1, Math.sqrt(d / 200));
  return 0.05 - norm * 0.042;
}

// ---------- Globo ----------
const globe = Globe({ rendererConfig: { antialias: true, powerPreference: 'high-performance' } })($('globe'))
  .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-night.jpg')
  .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png')
  .backgroundImageUrl('https://unpkg.com/three-globe/example/img/night-sky.png')
  .atmosphereColor('#5a82ff')
  .atmosphereAltitude(0.18)
  // Punti: cerchi proporzionali alla magnitudo, sollevati dal globo in base alla profondità
  .pointLat('lat').pointLng('lng')
  .pointColor(d => magColor(d.mag))
  .pointAltitude(d => depthAltitude(d.depth))
  .pointRadius(d => Math.max(0.13, d.mag * d.mag * 0.032))
  .pointResolution(6)
  .pointsTransitionDuration(300)
  .pointLabel(d => `
    <div class="globe-tip">
      <b style="color:${magColor(d.mag)}">M ${d.mag.toFixed(1)}</b> — ${d.place}<br>
      ${fmtTime(d.time)} (${timeAgo(d.time)})<br>
      Profondità: ${fmtDepth(d.depth)} <span class="tip-hint">(più il punto è sollevato, più è superficiale)</span>${d.tsunami ? '<br>⚠️ Allerta tsunami' : ''}
    </div>`)
  .onPointClick(d => { flyTo(d, 1.2); showToast(d, false); })
  // Anelli: onde sismiche animate sugli eventi recenti
  .ringLat('lat').ringLng('lng')
  .ringColor(d => t => `rgba(${d.mag >= 6 ? '255,59,48' : d.mag >= 4.5 ? '255,150,0' : '104,224,127'},${1 - t})`)
  .ringMaxRadius(d => Math.max(2, d.mag * 2.2))
  .ringPropagationSpeed(d => Math.max(1, d.mag * 0.8))
  .ringRepeatPeriod(d => Math.max(400, 1600 - d.mag * 150));

// Limita il costo di rendering (il pixel ratio alto pesa molto sui portatili)
globe.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));

// Il test "cosa sta puntando il mouse" gira a ogni frame. Contro la sfera del
// globo three.js prova tutti i suoi ~11.000 triangoli: ~2,8 ms per frame, per
// questo il globo scattava appena il puntatore ci passava sopra e tornava
// fluido spostandolo sullo sfondo (lì il raggio manca la sfera e il test esce
// subito). Per una sfera basta l'intersezione analitica; graticolo e confini
// non sono interattivi e dal test si possono escludere del tutto.
// Costanti di three.js per material.side (three non è accessibile da qui:
// globe.gl incorpora la propria istanza e non la espone).
const THREE_BACK_SIDE = 1;
const THREE_DOUBLE_SIDE = 2;

function speedUpRaycasting() {
  globe.scene().traverse(o => {
    if (o.__fastRaycast) return;
    if (o.isMesh && o.geometry && o.geometry.type === 'SphereGeometry') {
      o.geometry.computeBoundingSphere();
      const localRadius = o.geometry.boundingSphere.radius;
      o.raycast = function (raycaster, intersects) {
        const ray = raycaster.ray;
        const e = this.matrixWorld.elements;
        const radius = localRadius * Math.hypot(e[0], e[1], e[2]);
        const d = ray.direction;
        const ox = ray.origin.x - e[12];
        const oy = ray.origin.y - e[13];
        const oz = ray.origin.z - e[14];
        const b = ox * d.x + oy * d.y + oz * d.z;
        const c = ox * ox + oy * oy + oz * oz - radius * radius;
        const disc = b * b - c;
        if (disc < 0) return;                       // il raggio manca la sfera
        const sq = Math.sqrt(disc);
        // Va rispettato il lato del materiale come fa three.js: l'atmosfera è
        // disegnata solo all'interno (BackSide), quindi la sua faccia vicina
        // non conta — altrimenti "coprirebbe" i terremoti al passaggio del mouse.
        const side = this.material && this.material.side;
        const tNear = -b - sq;                      // faccia frontale
        const tFar = -b + sq;                       // faccia posteriore
        let t;
        if (side === THREE_BACK_SIDE) t = tFar;
        else if (side === THREE_DOUBLE_SIDE) t = tNear >= 0 ? tNear : tFar;
        else t = tNear;                             // FrontSide, il predefinito
        if (t < 0 || t < raycaster.near || t > raycaster.far) return;
        intersects.push({
          distance: t,
          object: this,
          point: new (ray.origin.constructor)(
            ray.origin.x + d.x * t, ray.origin.y + d.y * t, ray.origin.z + d.z * t),
        });
      };
      o.__fastRaycast = true;
    } else if (o.isLineSegments) {
      o.raycast = () => {};
      o.__fastRaycast = true;
    }
  });
}
speedUpRaycasting();

globe.controls().autoRotate = true;
globe.controls().autoRotateSpeed = 0.4;
// altitude 2.2 lasciava il polo nord del globo dietro la topbar fissa in
// alto: bisognava zoommare indietro a mano a ogni apertura. Con 2.6 il globo
// parte un po' più piccolo ma tutto visibile sotto la barra.
globe.pointOfView({ lat: 20, lng: 10, altitude: 2.6 });

function viewportSize() {
  const vv = window.visualViewport;
  return {
    width: Math.round(vv?.width || document.documentElement.clientWidth || window.innerWidth),
    height: Math.round(vv?.height || document.documentElement.clientHeight || window.innerHeight),
  };
}

// Render only the visible area beside the panel, without off-screen pixels.
// On mobile the panel is off-canvas, so it must not shift or shrink the globe.
function fitGlobe() {
  const panel = $('panel');
  const { width, height } = viewportSize();
  const isDesktop = window.matchMedia('(min-width: 768px)').matches;
  const panelRight = panel && isDesktop ? panel.getBoundingClientRect().right : 0;
  const left = isDesktop ? Math.max(0, panelRight + 12) : 0;
  const top = $('topbar').offsetHeight;
  $('globe').style.left = left + 'px';
  $('globe').style.top = top + 'px';
  $('map-view').style.left = left + 'px';
  $('map-view').style.top = top + 'px';
  const renderWidth = Math.max(1, width - left);
  const renderHeight = Math.max(1, height - top);
  globe.width(renderWidth).height(renderHeight);
  globe.renderer().setSize(renderWidth, renderHeight, false);
}

function scheduleFitGlobe() {
  fitGlobe();
  requestAnimationFrame(fitGlobe);
}

// Pannello e avvisi partono sotto la barra, qualunque sia la sua altezza reale
function syncTopbarHeight() {
  document.documentElement.style.setProperty('--topbar-h', $('topbar').offsetHeight + 'px');
}
new ResizeObserver(() => { syncTopbarHeight(); scheduleFitGlobe(); }).observe($('topbar'));
syncTopbarHeight();
scheduleFitGlobe();

// Confini nazionali (TopoJSON world-atlas), fusi in un'unica mesh di linee:
// il layer poligoni di globe.gl genera ~1400 draw call, questa 1 sola.
// globe.gl crea il proprio oggetto di linee (il graticolo, che tiene nascosto)
// poco DOPO l'inizializzazione, non necessariamente prima che arrivi il
// TopoJSON: a cache calda il file arriva per primo e senza questa attesa i
// confini non venivano disegnati affatto. Si usa setTimeout e non
// requestAnimationFrame perché quest'ultimo è sospeso nelle schede in secondo
// piano, e il sito verrebbe aperto senza confini.
function findLinePrototype(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const look = () => {
      let proto = null;
      globe.scene().traverse(o => { if (!proto && o.isLineSegments) proto = o; });
      if (proto) return resolve(proto);
      if (Date.now() > deadline) return reject(new Error('nessun oggetto di linee interno da cui clonare'));
      setTimeout(look, 30);
    };
    look();
  });
}

// Restituisce una BufferGeometry vuota della three INTERNA di globe.gl.
// La geometria del graticolo è una sottoclasse (GeoJsonGeometry) il cui
// costruttore pretende argomenti GeoJSON, e cui clone() va in errore perché li
// ha persi: si risale quindi alla classe base. Il ciclo con la prova d'uso
// evita di dipendere dalla profondità esatta della gerarchia.
function newInternalBufferGeometry(protoGeometry) {
  const candidates = [Object.getPrototypeOf(protoGeometry.constructor), protoGeometry.constructor];
  for (const Cls of candidates) {
    try {
      const g = new Cls();
      if (typeof g.setAttribute === 'function') return g;
    } catch (_) { /* non istanziabile senza argomenti: prova la prossima */ }
  }
  throw new Error('classe BufferGeometry interna non individuata');
}

// Costruisce una singola mesh LineSegments da un insieme di polilinee
// [lat,lng] e la aggiunge alla scena, riusando l'istanza three INTERNA di
// globe.gl (vedi commenti sopra: un three esterno mandarebbe in stallo il
// rendering). Ritorna l'oggetto three, per poterne poi cambiare .visible
// senza rifare la fetch/geometria a ogni toggle.
async function addLineMesh(linesLatLng, { altitude, color, opacity }) {
  const pos = [];
  for (const line of linesLatLng) {
    for (let i = 0; i < line.length - 1; i++) {
      const a = globe.getCoords(line[i][0], line[i][1], altitude);
      const b = globe.getCoords(line[i + 1][0], line[i + 1][1], altitude);
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }
  const proto = await findLinePrototype();
  const AttributeCls = proto.geometry.attributes.position.constructor;
  const geo = newInternalBufferGeometry(proto.geometry);
  geo.setAttribute('position', new AttributeCls(new Float32Array(pos), 3));
  geo.computeBoundingSphere();
  const mat = proto.material.clone();
  mat.color.set(color);
  mat.transparent = true;
  mat.opacity = opacity;
  mat.depthWrite = false;
  const mesh = new (proto.constructor)(geo, mat);
  globe.scene().add(mesh);
  speedUpRaycasting(); // esclude anche la mesh appena aggiunta
  return mesh;
}

// Confini nazionali (TopoJSON world-atlas), fusi in un'unica mesh di linee:
// il layer poligoni di globe.gl genera ~1400 draw call, questa 1 sola. Dallo
// stesso file si ricavano anche i poligoni dei singoli paesi (nessuna fetch
// aggiuntiva): servono solo per il point-in-polygon al clic, mai per il
// disegno, quindi non pesano sul rendering.
let countryFeatures = [];
fetch('https://unpkg.com/world-atlas@2.0.2/countries-110m.json')
  .then(r => r.json())
  .then(world => {
    countryFeatures = topojson.feature(world, world.objects.countries).features
      .filter(f => f.properties && f.properties.name && f.properties.name !== 'Antarctica');
    flatMap.setCountries(countryFeatures);
    const lines = topojson.mesh(world, world.objects.countries).coordinates
      .map(line => line.map(([lng, lat]) => [lat, lng]));
    return addLineMesh(lines, { altitude: 0.006, color: '#8cafff', opacity: 0.55 });
  })
  .catch(err => console.error('Confini non caricati:', err));

// ---------- Selezione paese al clic (point-in-polygon) ----------
// Algoritmo ray-casting classico in coordinate lng/lat: gira solo al clic
// (mai per frame), quindi anche un ciclo su tutti i ~940 vertici del paese
// più complesso costa una frazione di millisecondo — zero impatto sulla GPU.
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
function pointInPolygon(lng, lat, rings) {
  if (!pointInRing(lng, lat, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (pointInRing(lng, lat, rings[k])) return false; // buchi
  return true;
}
function countryAt(lat, lng) {
  for (const f of countryFeatures) {
    const geom = f.geometry;
    if (geom.type === 'Polygon') {
      if (pointInPolygon(lng, lat, geom.coordinates)) return f;
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) if (pointInPolygon(lng, lat, poly)) return f;
    }
  }
  return null;
}

function quakeInCountry(q, feature) {
  const geom = feature.geometry;
  if (geom.type === 'Polygon') return pointInPolygon(q.lng, q.lat, geom.coordinates);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some(poly => pointInPolygon(q.lng, q.lat, poly));
  return false;
}

globe.onGlobeClick((coords, ev) => {
  // Se il clic ha colpito un epicentro (puntamento a mano, viste affollate),
  // quello ha priorità: niente selezione del paese sotto al terremoto.
  if (pickQuakeAt(ev.clientX, ev.clientY)) return;
  const country = countryFeatures.length ? countryAt(coords.lat, coords.lng) : null;
  const same = country && state.selectedCountry && country.properties.name === state.selectedCountry.properties.name;
  selectCountry(same ? null : country);
});

// Confini di placca tettonica (dataset PB2002, Bird 2003) — stessa tecnica a
// mesh unica dei confini nazionali: costo di rendering pressoché nullo anche
// se sommato ai punti e agli anelli dei terremoti. Altitudine leggermente
// superiore ai confini nazionali per evitare z-fighting fra le due mesh.
let plateMesh = null;
fetch('https://cdn.jsdelivr.net/gh/fraxen/tectonicplates@master/GeoJSON/PB2002_boundaries.json')
  .then(r => r.json())
  .then(async geojson => {
    const lines = geojson.features
      .flatMap(f => f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates])
      .map(line => line.map(([lng, lat]) => [lat, lng]));
    flatMap.plates = lines; flatMap.schedule();
    plateMesh = await addLineMesh(lines, { altitude: 0.0075, color: '#ff9f43', opacity: 0.45 });
    plateMesh.visible = $('chk-plates').checked;
  })
  .catch(err => console.error('Placche tettoniche non caricate:', err));

$('chk-plates').onchange = e => { if (plateMesh) plateMesh.visible = e.target.checked; flatMap.showPlates = e.target.checked; flatMap.schedule(); };

function flyTo(d, altitude = 1.5) {
  if (state.view === '2d') flatMap.focus(d.lat, d.lng, Math.max(3, flatMap.view.zoom));
  else globe.pointOfView({ lat: d.lat, lng: d.lng, altitude }, state.quality === 'light' ? 0 : 1200);
}

// ---------- Fonti, viste e preferiti ----------
const sourceHealth = Object.fromEntries([
  ['usgs', 'USGS · finestra', POLL_MS], ['month', 'USGS · storico', MONTH_POLL_MS],
  ['emsc', 'EMSC · catalogo', EMSC_POLL_MS], ['ingv', 'INGV · ECHO', INGV_POLL_MS],
  ['solar', 'Kp · ECHO', INGV_POLL_MS], ['stream', 'EMSC · diretta', 0],
].map(([id, label, interval]) => [id, { label, interval, status: 'waiting', at: null }]));
function setSource(id, status) {
  const entry = sourceHealth[id]; entry.status = status;
  if (status === 'ok') entry.at = Date.now();
  renderSources();
}
function renderSources() {
  const list = $('source-health'); list.replaceChildren();
  let problems = 0;
  for (const [id, entry] of Object.entries(sourceHealth)) {
    const stale = entry.at && entry.interval && Date.now() - entry.at > entry.interval * 2 + 20000;
    const problem = entry.status === 'error' || stale;
    if (problem) problems++;
    const status = entry.status === 'off' ? 'disattivata' : problem ? (entry.at ? 'ritardo · dati conservati' : 'non disponibile') :
      entry.status === 'ok' ? (id === 'stream' ? 'connessa' : 'ricevuto') : entry.status === 'loading' ? 'connessione…' : 'in attesa';
    const row = document.createElement('li'); row.dataset.status = problem ? 'error' : entry.status;
    const label = document.createElement('b'); label.textContent = entry.label;
    const detail = document.createElement('span');
    detail.textContent = status + (entry.at ? ' · ' + new Date(entry.at).toLocaleTimeString('it-IT') : '');
    row.append(label, detail); list.append(row);
  }
  const entries = Object.values(sourceHealth);
  $('sources-summary').textContent = problems ? `${problems} da verificare` :
    entries.some(e => ['waiting','loading'].includes(e.status)) ? 'connessione…' : 'collegate';
}
const flatMap = new SismoMap($('map-canvas'), q => showToast(q, false, {shareable:q.source !== 'emsc'}), (lat,lng) => {
  const country = countryAt(lat,lng);
  selectCountry(country === state.selectedCountry ? null : country);
});
let displayedQuakes = [], displayedRings = [];
function renderVisualization(list, rings) {
  displayedQuakes = list; displayedRings = rings;
  if (document.hidden) return;
  if (state.view === '2d') {
    flatMap.quakes = list; flatMap.schedule(); return;
  }
  globe.pointsMerge(list.length > 600);
  globe.pointsTransitionDuration(state.quality === 'light' || state.replay.active || list.length > 600 ? 0 : 300);
  globe.pointsData(list); rebuildHitIndex(list);
  const cap = state.quality === 'light' ? 0 : list.length > 5000 ? 6 : list.length > 600 ? 10 : 20;
  globe.ringsData(rings.slice(0, cap));
}
function syncAnimation() {
  const visible = !document.hidden && $('info').hidden;
  if (visible && state.view === '3d') globe.resumeAnimation(); else globe.pauseAnimation();
  flatMap.active = visible && state.view === '2d';
  if (flatMap.active) flatMap.schedule();
}
function setView(view) {
  if (view === state.view) return;
  const previous = state.view;
  state.view = view; hideCustomTip();
  $('globe').hidden = view !== '3d'; $('map-view').hidden = view !== '2d';
  $('view-3d').setAttribute('aria-pressed', String(view === '3d'));
  $('view-2d').setAttribute('aria-pressed', String(view === '2d'));
  $('chk-rotate').disabled = view === '2d';
  if (view === '2d') {
    const pov = globe.pointOfView();
    flatMap.focus(pov.lat, pov.lng, Math.max(1, 2.6/pov.altitude)); flatMap.resize();
  } else if (previous === '2d') {
    globe.pointOfView({lat:flatMap.view.lat,lng:flatMap.view.lng,altitude:Math.max(.15,2.6/flatMap.view.zoom)},0);
  }
  syncAnimation(); render();
}
$('view-3d').onclick = () => setView('3d');
$('view-2d').onclick = () => setView('2d');
$('map-in').onclick = () => flatMap.zoom(1.5);
$('map-out').onclick = () => flatMap.zoom(1/1.5);
$('map-world').onclick = () => flatMap.focus(0,0,1);
$('sel-quality').value = state.quality;
$('sel-quality').onchange = e => {
  state.quality = e.target.value;
  globe.renderer().setPixelRatio(Math.min(devicePixelRatio || 1, state.quality === 'light' ? 1 : 1.25));
  renderVisualization(displayedQuakes, displayedRings);
};
if (state.quality === 'light') { $('chk-rotate').checked = false; globe.controls().autoRotate = false; }
document.addEventListener('visibilitychange', () => { syncAnimation(); if (!document.hidden) { render(); renderSources(); } });
const FAVORITES_KEY = 'sismoglobe.views.v1';
const presets = {world:{lat:20,lng:10,zoom:1},italy:{lat:42,lng:12.5,zoom:7},friuli:{lat:46.1,lng:13,zoom:24}};
let favorites = [];
try {
  const saved = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
  if (Array.isArray(saved)) favorites = saved.filter(f => f && typeof f.id === 'string' && f.id.startsWith('saved-') && typeof f.name === 'string' &&
    Number.isFinite(f.lat) && Math.abs(f.lat)<=90 && Number.isFinite(f.lng) && Math.abs(f.lng)<=180 && Number.isFinite(f.zoom) && f.zoom>=1 && f.zoom<=30).slice(0,20);
} catch (_) { /* storage unavailable: session-only favorites still work */ }
function renderFavorites() {
  const select = $('sel-place'), chosen = select.value;
  for (const option of [...select.options]) if(option.value.startsWith('saved-')) option.remove();
  for (const f of favorites) { const option=document.createElement('option'); option.value=f.id; option.textContent=f.name; select.append(option); }
  select.value=chosen; $('remove-place').disabled=!chosen.startsWith('saved-');
}
function persistFavorites() {
  try {localStorage.setItem(FAVORITES_KEY,JSON.stringify(favorites)); return true;}
  catch (_) {showNotice('Memoria del browser non disponibile: preferito valido solo per questa sessione.');return false;}
}
$('sel-place').onchange = e => {
  const view = presets[e.target.value] || favorites.find(f=>f.id===e.target.value);
  $('remove-place').disabled=!e.target.value.startsWith('saved-');
  if(!view)return;
  // A favorite frames an area; existing data filters remain explicit and unchanged.
  if(state.view==='2d')flatMap.focus(view.lat,view.lng,view.zoom);
  else globe.pointOfView({lat:view.lat,lng:view.lng,altitude:Math.max(.15,2.6/view.zoom)},state.quality==='light'?0:900);
  $('chk-rotate').checked=false;globe.controls().autoRotate=false;
};
$('save-place').onclick = () => { $('favorite-form').hidden=false; $('favorite-name').focus(); };
$('cancel-favorite').onclick = () => { $('favorite-form').hidden=true; };
$('favorite-form').onsubmit = e => {
  e.preventDefault();const name=$('favorite-name').value.trim();if(!name)return;
  if(favorites.length>=20){showNotice('Puoi salvare fino a 20 viste. Rimuovine una per aggiungerne un’altra.');return;}
  const pov=globe.pointOfView();
  const view=state.view==='2d'?{...flatMap.view}:{lat:pov.lat,lng:((pov.lng+180)%360+360)%360-180,zoom:Math.max(1,Math.min(30,2.6/pov.altitude))};
  const favorite={id:'saved-'+Date.now(),name,...view};favorites.push(favorite);
  const persisted=persistFavorites();renderFavorites();$('sel-place').value=favorite.id;$('remove-place').disabled=false;
  $('favorite-form').hidden=true;$('favorite-name').value='';if(persisted)showNotice('Vista salvata in questo browser.');
};
$('remove-place').onclick = () => {
  favorites=favorites.filter(f=>f.id!==$('sel-place').value);persistFavorites();$('sel-place').value='';renderFavorites();
};
renderFavorites();renderSources();


// ---------- Audio ----------
let audioCtx = null;
function beep(mag) {
  if (!state.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.type = 'sine';
    o.frequency.value = mag >= 6 ? 220 : mag >= 4.5 ? 440 : 660;
    g.gain.setValueAtTime(0.18, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.7);
    o.start(); o.stop(audioCtx.currentTime + 0.7);
  } catch (_) { /* audio non disponibile */ }
}

// ---------- Toast ----------
function showToast(d, isNew = true, opts = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.style.borderLeftColor = magColor(d.mag);
  const title = opts.label || (isNew ? '🚨 Nuovo terremoto' : 'ℹ️ Dettaglio');
  // Gli eventi EMSC non sono nel dataset USGS del globo (vedi più sotto): un
  // link ?id= punterebbe a un evento introvabile, quindi niente pulsante.
  const shareBtn = opts.shareable === false ? '' :
    `<button class="t-share" type="button" title="Copia un link diretto a questo evento">🔗 copia link</button>`;
  el.innerHTML = `
    <div class="t-title">${title} — <span style="color:${magColor(d.mag)}">M ${d.mag.toFixed(1)}</span></div>
    <div class="t-body">${d.place}<br>${fmtTime(d.time)} · prof. ${fmtDepth(d.depth)}${d.tsunami ? ' · ⚠️ tsunami' : ''}</div>
    ${quakeWaveformSvg(d)}
    ${shareBtn}`;
  el.onclick = () => { flyTo(d, 1.2); dismiss(); };
  if (shareBtn) el.querySelector('.t-share').onclick = ev => { ev.stopPropagation(); shareQuake(d); };
  $('toasts').prepend(el);
  const dismiss = () => { el.classList.add('out'); setTimeout(() => el.remove(), 400); };
  setTimeout(dismiss, isNew ? 10_000 : 6_000);
  while ($('toasts').children.length > 5) $('toasts').lastChild.remove();
}

// Notice generica (non un evento): usata per confermare la copia del link.
function showNotice(text, ms = 3000) {
  const el = document.createElement('div');
  el.className = 'toast notice';
  el.textContent = text;
  $('toasts').prepend(el);
  const dismiss = () => { el.classList.add('out'); setTimeout(() => el.remove(), 400); };
  setTimeout(dismiss, ms);
  while ($('toasts').children.length > 5) $('toasts').lastChild.remove();
}

// Link diretto a un evento (?id=...): niente backend, solo un parametro nella
// stessa index.html letto all'avvio (vedi in fondo al file).
function shareUrl(q) {
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('id', q.id);
  return url.toString();
}
function shareQuake(q) {
  const link = shareUrl(q);
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(link)
      .then(() => showNotice('🔗 Link copiato negli appunti'))
      .catch(() => showNotice(link)); // niente permesso clipboard: mostra il link da copiare a mano
  } else {
    showNotice(link); // http non sicuro (es. anteprima locale): l'API Clipboard non è disponibile
  }
}

// ---------- Puntamento dei terremoti con i punti fusi ----------
// Con pointsMerge globe.gl disegna tutti i punti come un unico oggetto e non sa
// più dire quale si stia puntando: nelle viste affollate tooltip e clic
// sull'epicentro smetterebbero di funzionare. Qui il puntamento lo facciamo a
// mano: si interseca il raggio del mouse con la sfera del globo e si cerca il
// terremoto più vicino al punto colpito. È un ciclo su un vettore di posizioni
// precalcolate, quindi costa una frazione di millisecondo e non tocca la GPU.
const GLOBE_RADIUS = 100;   // raggio del globo nelle unità interne di globe.gl
const PICK_TOLERANCE = 1.6; // ~180 km: quanto si può sbagliare mira
// Le posizioni stanno in un Float32Array invece che in un vettore di oggetti:
// con 11.000 eventi il ciclo di ricerca scende da ~0,8 a ~0,2 ms, e gira a
// ogni movimento del mouse.
let hitPos = new Float32Array(0);
let hitQuakes = [];
let customTip = null;

function rebuildHitIndex(list) {
  hitPos = new Float32Array(list.length * 3);
  hitQuakes = list;
  for (let i = 0; i < list.length; i++) {
    const v = globe.getCoords(list[i].lat, list[i].lng, 0.008);
    hitPos[i * 3] = v.x;
    hitPos[i * 3 + 1] = v.y;
    hitPos[i * 3 + 2] = v.z;
  }
}

function pickQuakeAt(clientX, clientY) {
  if (!hitQuakes.length) return null;
  const cam = globe.camera();
  const rect = globe.renderer().domElement.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const Vec3 = cam.position.constructor;
  const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
  const dir = new Vec3(ndcX, ndcY, 0.5).unproject(cam).sub(cam.position).normalize();
  const o = cam.position;
  // intersezione raggio-sfera: si tiene solo la faccia rivolta verso di noi,
  // così i terremoti dell'altro emisfero non vengono puntati "attraverso" il globo
  const b = o.x * dir.x + o.y * dir.y + o.z * dir.z;
  const c = o.x * o.x + o.y * o.y + o.z * o.z - GLOBE_RADIUS * GLOBE_RADIUS;
  const disc = b * b - c;
  if (disc < 0) return null;                    // il puntatore è fuori dal globo
  const t = -b - Math.sqrt(disc);
  if (t < 0) return null;
  const px = o.x + dir.x * t, py = o.y + dir.y * t, pz = o.z + dir.z * t;

  let bestIdx = -1, bestD2 = Infinity;
  for (let i = 0, j = 0; j < hitPos.length; i++, j += 3) {
    const dx = hitPos[j] - px, dy = hitPos[j + 1] - py, dz = hitPos[j + 2] - pz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
  }
  if (bestIdx < 0) return null;
  const best = hitQuakes[bestIdx];
  // la tolleranza segue il raggio disegnato: i sismi forti sono cerchi più grandi
  const tol = Math.max(PICK_TOLERANCE, Math.max(0.13, best.mag * best.mag * 0.032) * 1.4);
  return bestD2 <= tol * tol ? best : null;
}

function showCustomTip(q, x, y) {
  if (!customTip) {
    customTip = document.createElement('div');
    customTip.className = 'globe-tip';
    customTip.id = 'custom-tip';
    document.body.appendChild(customTip);
  }
  customTip.innerHTML = `
    <b style="color:${magColor(q.mag)}">M ${q.mag.toFixed(1)}</b> — ${q.place}<br>
    ${fmtTime(q.time)} (${timeAgo(q.time)})<br>
    Profondità: ${fmtDepth(q.depth)}${q.tsunami ? '<br>⚠️ Allerta tsunami' : ''}`;
  customTip.style.display = 'block';
  // si sposta a sinistra del cursore se altrimenti uscirebbe dallo schermo
  const w = customTip.offsetWidth;
  customTip.style.left = (x + 14 + w > window.innerWidth ? x - w - 14 : x + 14) + 'px';
  customTip.style.top = (y + 14) + 'px';
}

function hideCustomTip() {
  if (customTip) customTip.style.display = 'none';
}

// Attivo solo quando i punti sono fusi: altrimenti ci pensa globe.gl da sé e
// si otterrebbero due tooltip sovrapposti.
function customPickingActive() {
  return globe.pointsMerge();
}

(() => {
  const el = $('globe');
  let downAt = null;

  let lastPick = 0;
  el.addEventListener('pointermove', ev => {
    if (downAt || performance.now() - lastPick < 50) return;
    lastPick = performance.now();
    if (!customPickingActive()) { hideCustomTip(); return; }
    const q = pickQuakeAt(ev.clientX, ev.clientY);
    if (q) {
      showCustomTip(q, ev.clientX, ev.clientY);
      el.style.cursor = 'pointer';
    } else {
      hideCustomTip();
      el.style.cursor = '';
    }
  });

  el.addEventListener('pointerleave', hideCustomTip);
  el.addEventListener('pointercancel', () => { downAt = null; hideCustomTip(); });
  el.addEventListener('pointerdown', ev => { hideCustomTip(); downAt = { x: ev.clientX, y: ev.clientY }; });

  // Un clic vale solo se il puntatore non si è spostato: trascinando si ruota
  // il globo, e non deve partire l'azione sull'epicentro.
  el.addEventListener('pointerup', ev => {
    if (!customPickingActive() || !downAt) { downAt = null; return; }
    const moved = Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y);
    downAt = null;
    if (moved > 5) return;
    const q = pickQuakeAt(ev.clientX, ev.clientY);
    if (q) { flyTo(q, 1.2); showToast(q, false); }
  });
})();

// ---------- Rendering dati ----------
function visibleQuakes() {
  let list;
  if (state.selectedDay) {
    list = state.monthQuakes.filter(q => utcDay(q.time) === state.selectedDay);
  } else {
    list = state.quakes;
  }
  // minMag = 0 mostra tutto (il feed USGS contiene anche magnitudo negative)
  if (state.minMag > 0) list = list.filter(q => q.mag >= state.minMag);
  if (state.selectedCountry) list = list.filter(q => quakeInCountry(q, state.selectedCountry));
  return list;
}

function render() {
  // In modalità replay il globo mostra la finestra scorrevole del mese invece
  // che gli eventi live: nessun filtro giorno/paese, nessuna nuova geometria,
  // solo un pointsData/ringsData diverso riusando gli stessi layer.
  if (state.replay.active) { renderReplayFrame(); return; }
  const vis = visibleQuakes();
  const now = Date.now();

  const rings = (state.selectedDay
    ? vis.filter(q => q.mag >= 5)
    : vis.filter(q => now - q.time < RING_WINDOW_MS)).sort((a, b) => b.mag - a.mag);
  renderVisualization(vis, rings);

  renderList(vis);
  renderStats();
  renderLive(); // eventi EMSC/INGV arrivano fuori dal poll USGS: il contatore LIVE deve seguire il globo
}

const LIST_CAP = 500; // oltre, il DOM (mese ~11.000 eventi) rallenterebbe troppo

function renderList(vis) {
  const ul = $('quake-list');
  ul.innerHTML = '';
  const shown = vis.slice(0, LIST_CAP);
  // Gli eventi EMSC in sospeso sono sul globo ma non ancora nel feed USGS né nel
  // catalogo EMSC (e quindi non nelle statistiche): dichiararli spiega la
  // differenza di conteggio.
  const pending = vis.filter(q => q.source === 'emsc').length;
  const pendingTxt = pending ? `, di cui ${pending} ⚡ EMSC in attesa` : '';
  $('list-count').textContent = vis.length > LIST_CAP
    ? `(${shown.length} di ${vis.length}${pendingTxt})`
    : `(${vis.length} visibili${pendingTxt})`;
  for (const q of shown) {
    const li = document.createElement('li');
    const isEmsc = q.source === 'emsc';
    const isIngv = q.source === 'ingv';
    const shareBtn = isEmsc ? '' :
      `<button class="q-share" type="button" title="Copia un link diretto a questo evento">🔗</button>`;
    const srcTag = isEmsc
      ? ' <span class="q-pending" title="Notifica EMSC in diretta, in attesa del feed USGS o del catalogo EMSC">⚡</span>'
      : isIngv
        ? ' <span class="q-src" title="Fonte: INGV via sismo-fvg.gimmycloud.net — sismicità regionale FVG/Campi Flegrei, non presente sul feed USGS">INGV</span>'
        : q.source === 'emsc-cat'
          ? ' <span class="q-src" title="Fonte: catalogo EMSC (European-Mediterranean Seismological Centre) — evento non presente sul feed USGS">EMSC</span>'
          : '';
    li.innerHTML = `
      <span class="mag-badge" style="background:${magColor(q.mag)}">${q.mag.toFixed(1)}</span>
      <div class="q-info">
        <div class="q-place">${q.place}${srcTag}</div>
        <div class="q-meta">${fmtTime(q.time)} · ${timeAgo(q.time)} · ${fmtDepth(q.depth)}</div>
      </div>
      ${shareBtn}`;
    li.onclick = () => flyTo(q, 1.2);
    if (shareBtn) li.querySelector('.q-share').onclick = ev => { ev.stopPropagation(); shareQuake(q); };
    ul.appendChild(li);
  }
}

function renderStats() {
  const now = Date.now();
  // state.quakes copre sempre almeno 24h (finestra 24h/7g/30g) ed è aggiornato
  // ogni 60s: il mese (ogni 10 min) restava indietro di qualche evento rispetto
  // a LIVE e alla lista. Esclusi gli EMSC in sospeso, non ancora confermati.
  const src = state.quakes.filter(q => q.source !== 'emsc');
  const hour = src.filter(q => now - q.time < 3600_000);
  const last24 = src.filter(q => now - q.time < 86400_000);
  const maxQ = (state.selectedDay ? visibleQuakes() : last24)
    .reduce((a, b) => (!a || b.mag > a.mag ? b : a), null);

  $('st-24h').textContent = last24.length; // stessa finestra del globo (feed 24h), non il giorno UTC
  $('st-hour').textContent = hour.length;
  $('st-max').textContent = maxQ ? 'M ' + maxQ.mag.toFixed(1) : '–';
  $('st-energy').textContent = fmtEnergy(last24.reduce((s, q) => s + energyJoules(q.mag), 0));

  const kpEl = $('st-kp');
  if (state.kp) {
    kpEl.textContent = state.kp.max.toFixed(1);
    kpEl.style.color = kpColor(state.kp.max);
    $('st-kp-box').title = `Indice geomagnetico Kp (NOAA SWPC) — massimo del ${state.kp.day}: ${state.kp.max.toFixed(1)}, media ${state.kp.avg.toFixed(1)}. Via sismo-fvg.`;
  } else {
    kpEl.textContent = '–';
    kpEl.style.color = '';
  }
}

function renderHistogram() {
  const box = $('histogram');
  box.innerHTML = '';
  const byDay = new Map();
  const src = state.selectedCountry
    ? state.monthQuakes.filter(q => quakeInCountry(q, state.selectedCountry))
    : state.monthQuakes;
  for (const q of src) {
    const d = utcDay(q.time);
    const e = byDay.get(d) || { count: 0, max: 0 };
    e.count++;
    e.max = Math.max(e.max, q.mag);
    byDay.set(d, e);
  }
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = utcDay(Date.now() - i * 86400_000);
    days.push([d, byDay.get(d) || { count: 0, max: 0 }]);
  }
  const maxCount = Math.max(1, ...days.map(([, e]) => e.count));
  for (const [day, e] of days) {
    const bar = document.createElement('div');
    bar.className = 'bar' + (state.selectedDay === day ? ' sel' : '');
    bar.style.height = Math.max(2, (e.count / maxCount) * 100) + '%';
    bar.style.background = e.count ? magColor(e.max) : '#2a3350';
    const [, m, g] = day.split('-');
    bar.innerHTML = `<div class="tip"><b>${g}/${m}</b> — ${e.count} eventi<br>max M ${e.max.toFixed(1)}</div>`;
    bar.onclick = () => selectDay(state.selectedDay === day ? null : day);
    box.appendChild(bar);
  }
}

function selectDay(day) {
  state.selectedDay = day;
  const banner = $('day-banner');
  if (day) {
    const [, m, g] = day.split('-');
    const n = state.monthQuakes.filter(q => utcDay(q.time) === day).length;
    $('day-banner-text').textContent = `📅 ${g}/${m} — ${n} eventi`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
  renderHistogram();
  render();
}

function selectCountry(feature) {
  state.selectedCountry = feature;
  const banner = $('country-banner');
  if (feature) {
    const n = visibleQuakes().length;
    $('country-banner-text').textContent = `🌐 ${feature.properties.name} — ${n} eventi`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
  renderHistogram();
  render();
}

// ---------- Replay dei 30 giorni ----------
let replayTimer = null;
let lastReplayList = -Infinity;

function startReplay() {
  if (!state.monthQuakes.length) {
    showNotice('⏳ Dati ancora in caricamento, riprova tra un istante.');
    return;
  }
  lastReplayList = -Infinity;
  state.replay.active = true;
  state.replay.playing = true;
  state.replay.t = 0;
  $('replay-panel').classList.remove('hidden');
  $('btn-replay').classList.add('active');
  $('replay-playpause').textContent = '⏸️';
  clearInterval(replayTimer);
  replayTimer = setInterval(replayTick, REPLAY_TICK_MS);
  render();
}

function exitReplay() {
  state.replay.active = false;
  state.replay.playing = false;
  clearInterval(replayTimer);
  replayTimer = null;
  $('replay-panel').classList.add('hidden');
  $('btn-replay').classList.remove('active');
  render(); // torna alla vista live con i filtri correnti
}

function replayTick() {
  if (!state.replay.playing || document.hidden) return;
  state.replay.t += REPLAY_STEP_MS;
  if (state.replay.t >= REPLAY_RANGE_MS) {
    state.replay.t = REPLAY_RANGE_MS;
    state.replay.playing = false;
    $('replay-playpause').textContent = '▶️';
    clearInterval(replayTimer);
  }
  render();
}

function toggleReplayPlay() {
  state.replay.playing = !state.replay.playing;
  $('replay-playpause').textContent = state.replay.playing ? '⏸️' : '▶️';
  clearInterval(replayTimer);
  if (!state.replay.playing) renderReplayFrame();
  if (state.replay.playing) {
    if (state.replay.t >= REPLAY_RANGE_MS) state.replay.t = 0; // riparte se era arrivato in fondo
    replayTimer = setInterval(replayTick, REPLAY_TICK_MS);
  }
}

function renderReplayFrame() {
  const virtualNow = Date.now() - REPLAY_RANGE_MS + state.replay.t;
  const list = state.monthQuakes.filter(q => q.time <= virtualNow && q.time > virtualNow - REPLAY_TRAIL_MS);
  const rings = list.filter(q => virtualNow - q.time < RING_WINDOW_MS).sort((a,b) => b.mag-a.mag);
  renderVisualization(list, rings);
  // The map follows every replay tick; rebuild the long DOM list at most once a second.
  if (!state.replay.playing || performance.now() - lastReplayList > 1000) {
    renderList(list); lastReplayList = performance.now();
  }
  $('replay-slider').value = Math.round((state.replay.t / REPLAY_RANGE_MS) * 1000);
  $('replay-date').textContent = fmtTime(virtualNow);
}

// ---------- EMSC in tempo reale (WebSocket) ----------
// Gli eventi arrivano dallo European-Mediterranean Seismological Centre in
// pochi secondi, molto prima del prossimo poll USGS (fino a 60s). Vengono
// inseriti subito in state.quakes (fonte 'emsc', id sintetico 'emsc-<unid>')
// così contatore/lista/globo si aggiornano all'istante — non solo il toast.
// Quando arriva il prossimo feed USGS, ogni evento EMSC "in sospeso" che
// corrisponde (tempo/magnitudo/posizione vicini, vedi isSameEmscUsgsEvent) a
// un evento USGS viene tolto dai sospesi e sostituito dalla voce ufficiale
// USGS, senza un secondo toast/beep. Se USGS non lo conferma (fuori catalogo
// o sotto soglia) lo sostituisce la stessa voce del catalogo EMSC (stesso id,
// vedi loadEmscCatalog) al refresh successivo; altrimenti resta come evento
// EMSC per EMSC_PENDING_MAX_MS,
// poi scompare.
const EMSC_WS_URL = 'wss://www.seismicportal.eu/standing_order/websocket';
const EMSC_MIN_MAG = 2.5;
const EMSC_RECONNECT_MS = 5000;
// Oltre il prossimo refresh del catalogo EMSC (10 min, più il ritardo con cui
// EMSC pubblica): un evento solo-EMSC passa dal "sospeso" al catalogo senza
// sparire nel frattempo.
const EMSC_PENDING_MAX_MS = 30 * 60_000;
const EMSC_PENDING_CAP = 40;
let emscWs = null;
let emscReconnectTimer = null;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Confronto euristico: EMSC e USGS non condividono un id comune, quindi si
// considera "lo stesso evento" quando tempo, magnitudo e posizione sono
// abbastanza vicini da escludere un caso di due sismi distinti e simultanei.
function isSameEmscUsgsEvent(usgsQ, emscQ) {
  return Math.abs(usgsQ.time - emscQ.time) < 6 * 60_000 &&
    Math.abs(usgsQ.mag - emscQ.mag) < 0.5 &&
    haversineKm(usgsQ.lat, usgsQ.lng, emscQ.lat, emscQ.lng) < 150;
}

function connectEmsc() {
  if (!state.emscLive || emscWs) return;
  try {
    emscWs = new WebSocket(EMSC_WS_URL);
  } catch (err) {
    setSource('stream', 'error'); scheduleEmscReconnect();
    return;
  }
  setSource('stream', 'loading');
  emscWs.onopen = () => setSource('stream', 'ok');
  emscWs.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.action !== 'create') return; // "update" = revisione di un evento già notificato
    const p = msg.data && msg.data.properties;
    if (!p || p.mag == null || p.mag < EMSC_MIN_MAG || p.lat == null || p.lon == null) return;
    const id = 'emsc-' + (p.unid || `${p.time}-${p.lat}-${p.lon}`);
    if (state.emscPending.some(e => e.id === id) || state.quakes.some(q => q.id === id)) return;
    const q = {
      id,
      mag: p.mag,
      place: p.flynn_region || 'Località sconosciuta',
      time: Date.parse(p.time) || Date.now(),
      depth: p.depth,
      lat: p.lat,
      lng: p.lon,
      tsunami: false,
      source: 'emsc',
    };
    state.emscPending.push(q);
    if (state.emscPending.length > EMSC_PENDING_CAP) state.emscPending.shift();
    if (!state.replay.active && !state.selectedDay) {
      state.quakes = [q, ...state.quakes];
      render();
      // Gli eventi EMSC in diretta non passavano mai da qui: prima "vola sui
      // nuovi" scattava solo al poll USGS (ogni 60s, soglia 4.5), quindi in
      // pratica non si vedeva quasi mai volare il globo.
      if (state.flyToNew && q.mag >= FLY_MIN_MAG) flyTo(q, 1.6);
    }
    showToast(q, true, { label: '⚡ EMSC in diretta', shareable: false });
    beep(q.mag);
  };
  emscWs.onclose = () => { emscWs = null; setSource('stream', 'error'); scheduleEmscReconnect(); };
  emscWs.onerror = () => { if (emscWs) emscWs.close(); };
}

function scheduleEmscReconnect() {
  if (!state.emscLive || emscReconnectTimer) return;
  emscReconnectTimer = setTimeout(() => { emscReconnectTimer = null; connectEmsc(); }, EMSC_RECONNECT_MS);
}

function disconnectEmsc() {
  setSource('stream', 'off');
  clearTimeout(emscReconnectTimer);
  emscReconnectTimer = null;
  if (emscWs) { emscWs.onclose = null; emscWs.close(); emscWs = null; }
  if (state.emscPending.length) {
    state.quakes = state.quakes.filter(q => q.source !== 'emsc');
    state.emscPending = [];
    render();
  }
}

// ---------- Fusione delle fonti (USGS + INGV + catalogo EMSC) ----------
// Stesso spirito della fusione EMSC/USGS sopra: le fonti non condividono un id
// comune, quindi un evento presente su più fonti va scartato da un lato per non
// mostrarlo due volte sul globo. Priorità: USGS, poi INGV (un sisma italiano
// presente anche su EMSC resta con l'etichetta e i dati INGV), poi EMSC.
const SAME_EVENT_MS = 6 * 60_000;
function isSameIngvEvent(o, ev) {
  return Math.abs(o.time - ev.time) < SAME_EVENT_MS &&
    Math.abs(o.mag - ev.mag) < 0.5 &&
    haversineKm(o.lat, o.lng, ev.lat, ev.lng) < 50;
}

// Sul mese i confronti sarebbero ~10.000 USGS × ~7.000 EMSC = 70 milioni a ogni
// poll: il riferimento viene ordinato per tempo una volta sola e per ogni
// candidato si provano solo gli eventi entro ±SAME_EVENT_MS (ricerca binaria).
function makeTimeIndex(list) {
  const sorted = [...list].sort((a, b) => a.time - b.time);
  return { sorted, times: sorted.map(q => q.time) };
}
function hasSameEvent(index, ev, same) {
  const { sorted, times } = index;
  const from = ev.time - SAME_EVENT_MS;
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < from) lo = mid + 1; else hi = mid;
  }
  for (let i = lo; i < sorted.length && times[i] <= ev.time + SAME_EVENT_MS; i++) {
    if (same(sorted[i], ev)) return true;
  }
  return false;
}

const EXTRA_SOURCES = new Set(['ingv', 'emsc-cat']);

// Aggiunge a una lista USGS (più eventuali EMSC in sospeso) gli eventi INGV ed
// EMSC che non ha già, limitati alla finestra windowMs (null = tutto il mese).
function withExtraSources(base, windowMs) {
  const now = Date.now();
  const inWindow = q => windowMs == null || now - q.time < windowMs;
  const baseIndex = makeTimeIndex(base);
  const ingv = state.ingvQuakes.filter(ev => inWindow(ev) && !hasSameEvent(baseIndex, ev, isSameIngvEvent));
  const refIndex = makeTimeIndex([...base, ...ingv]);
  const emsc = state.emscQuakes.filter(ev => inWindow(ev) && !hasSameEvent(refIndex, ev, isSameEmscUsgsEvent));
  return [...base, ...ingv, ...emsc].sort((a, b) => b.time - a.time);
}

// L'endpoint sismo-fvg salva l'orario INGV con microsecondi ("...54.320000",
// senza 'Z'): Date.parse lo ignorerebbe silenziosamente. Troncato a millisecondi
// e con 'Z' esplicito, è un ISO valido (i dati INGV sono in UTC).
function parseIngvTime(s) {
  return Date.parse(String(s).slice(0, 23) + 'Z');
}

// Rimescola gli eventi INGV ed EMSC nella finestra corrente e nel mese, senza
// duplicare eventi USGS della stessa area/istante. Non chiama render(): lo fa
// il chiamante, per non ridisegnare due volte in loadFeed()/loadMonth().
function mergeExtrasIntoState() {
  // Un evento EMSC "in sospeso" ormai presente nel catalogo (stesso id
  // 'emsc-<unid>') lascia il posto alla voce del catalogo, che non scade.
  const catalogIds = new Set(state.emscQuakes.map(q => q.id));
  state.emscPending = state.emscPending.filter(q => !catalogIds.has(q.id));
  const strip = list => list.filter(q => !EXTRA_SOURCES.has(q.source) && !catalogIds.has(q.id));

  // Finché il feed mensile USGS non è arrivato il mese resta vuoto: con le sole
  // fonti extra le statistiche (che lo preferiscono a state.quakes) mostrerebbero
  // solo INGV/EMSC.
  const monthBase = strip(state.monthQuakes);
  state.monthQuakes = monthBase.length ? withExtraSources(monthBase, null) : [];
  state.quakes = withExtraSources(strip(state.quakes), WINDOW_MS[state.window]);
}

// Carica in un colpo solo i due dataset esposti da sismo-fvg: eventi INGV
// (FVG/Campi Flegrei) e indice geomagnetico Kp. Le due fetch sono indipendenti
// (Promise.allSettled): se una delle due fallisce l'altra resta comunque utile,
// invece di perdere tutto per un problema isolato a un solo endpoint.
async function loadSismoFvg() {
  setSource('ingv', 'loading'); setSource('solar', 'loading');
  const [evRes, solRes] = await Promise.allSettled([
    fetch(`${INGV_API}?giorni=30&mag=${INGV_MIN_MAG}`, { cache: 'no-store', signal: AbortSignal.timeout(20000) }),
    fetch(SOLAR_API, { cache: 'no-store', signal: AbortSignal.timeout(20000) }),
  ]);

  if (evRes.status === 'fulfilled' && evRes.value.ok) {
    try {
      const data = await evRes.value.json();
      if (!Array.isArray(data.events)) throw new Error('Catalogo INGV non valido');
      state.ingvQuakes = data.events
        .map(e => ({
          id: 'ingv-' + e.event_id,
          lat: e.latitudine,
          lng: e.longitudine,
          depth: e.profondita,
          mag: e.magnitudine,
          place: e.localita,
          time: parseIngvTime(e.data_ora),
          tsunami: false,
          source: 'ingv',
        }))
        .filter(q => q.time); // scarta eventuali orari non interpretabili
      mergeExtrasIntoState(); setSource('ingv', 'ok');
    } catch (err) { setSource('ingv', 'error'); console.error('Eventi INGV (sismo-fvg) non interpretabili:', err); }
  } else {
    setSource('ingv', 'error');
    console.error('Eventi INGV (sismo-fvg) non raggiungibili:', evRes.reason || evRes.value?.status);
  }

  if (solRes.status === 'fulfilled' && solRes.value.ok) {
    try {
      const days = await solRes.value.json();
      if (Array.isArray(days) && days.length) {
        const latest = days[0]; // query ordina già DESC per giorno
        state.kp = { day: latest.giorno, max: latest.kp_max, avg: latest.kp_avg };
        setSource('solar', 'ok');
      } else throw new Error('Dati solari assenti');
    } catch (err) { setSource('solar', 'error'); console.error('Dati solari (sismo-fvg) non interpretabili:', err); }
  } else {
    setSource('solar', 'error');
    console.error('Dati solari (sismo-fvg) non raggiungibili:', solRes.reason || solRes.value?.status);
  }

  render();
  renderHistogram();
  renderStats();
}

// ---------- Catalogo EMSC ----------
// Gli ultimi 30 giorni M>=EMSC_MIN_MAG (~7.000 eventi, ~4 MB). L'id 'emsc-<unid>'
// è lo stesso degli eventi in diretta via WebSocket, così un evento notificato
// in diretta passa al catalogo senza comparire due volte, e resta condivisibile
// con ?id= (openSharedQuake lo trova nel mese).
async function loadEmscCatalog() {
  setSource('emsc', 'loading');
  try {
    const start = new Date(Date.now() - REPLAY_RANGE_MS).toISOString().slice(0, 19);
    const r = await fetch(`${EMSC_FDSN}?format=json&minmag=${EMSC_MIN_MAG}&start=${start}&limit=20000`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    // FDSN risponde 204 senza corpo quando non ci sono eventi
    const data = r.status === 204 ? { features: [] } : await r.json();
    if (!Array.isArray(data.features)) throw new Error('Catalogo EMSC non valido');
    state.emscQuakes = data.features
      .map(f => f.properties)
      .filter(p => p && p.unid && p.mag != null && p.lat != null && p.lon != null)
      .map(p => ({
        id: 'emsc-' + p.unid,
        lat: p.lat,
        lng: p.lon,
        depth: p.depth,
        mag: p.mag,
        place: p.flynn_region || 'Località sconosciuta',
        time: Date.parse(p.time),
        url: 'https://www.seismicportal.eu/eventdetails.html?unid=' + encodeURIComponent(p.unid),
        tsunami: false,
        source: 'emsc-cat',
      }))
      .filter(q => q.time);
    mergeExtrasIntoState();
    setSource('emsc', 'ok');
  } catch (err) {
    setSource('emsc', 'error');
    console.error('Catalogo EMSC non raggiungibile:', err);
    return;
  }
  render();
  renderHistogram();
  renderStats();
}

// ---------- Fetch e polling ----------
let feedRequestSeq = 0;
async function loadFeed() {
  const seq = ++feedRequestSeq;
  setSource('usgs', 'loading');
  try {
    const r = await fetch(USGS + FEEDS[state.window], { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const quakes = parseFeed(await r.json());
    // Se nel frattempo la finestra è cambiata di nuovo (es. 24h→7g→24h fatto
    // in rapida successione), questa risposta è ormai superata: scartarla,
    // altrimenti una risposta "7g" arrivata in ritardo sovrascrive la scelta
    // corrente e il globo resta bloccato sulla finestra sbagliata fino al
    // prossimo poll.
    if (seq !== feedRequestSeq) return;

    // Ogni evento EMSC "in sospeso" confermato da USGS (stesso tempo/mag/
    // posizione, vedi isSameEmscUsgsEvent) esce dai sospesi: la voce ufficiale
    // USGS lo sostituisce senza un secondo toast. Chi resta in sospeso troppo
    // a lungo (EMSC_PENDING_MAX_MS) viene scartato: né USGS né il catalogo
    // EMSC l'hanno mai ripreso.
    const confirmedIds = new Set();
    const now = Date.now();
    state.emscPending = state.emscPending.filter(eq => {
      const match = quakes.find(u => isSameEmscUsgsEvent(u, eq));
      if (match) { confirmedIds.add(match.id); return false; }
      return now - eq.time < EMSC_PENDING_MAX_MS;
    });

    // Rileva nuovi eventi (non al primo caricamento) — esclusi quelli già
    // notificati poco prima come evento EMSC in diretta.
    if (!state.firstLoad) {
      const fresh = quakes.filter(q => !state.seenIds.has(q.id) && !confirmedIds.has(q.id));
      for (const q of fresh.slice(0, 4)) {
        showToast(q, true);
        beep(q.mag);
        markNewInList(q.id);
      }
      const biggest = fresh.reduce((a, b) => (!a || b.mag > a.mag ? b : a), null);
      if (biggest && state.flyToNew && biggest.mag >= FLY_MIN_MAG) flyTo(biggest, 1.6);
    }
    quakes.forEach(q => state.seenIds.add(q.id));

    state.quakes = [...state.emscPending, ...quakes].sort((a, b) => b.time - a.time);
    mergeExtrasIntoState(); // riaggiunge gli eventi INGV/EMSC in cache: loadFeed() li avrebbe appena sovrascritti
    state.firstLoad = false;
    setLive(true);
    render();
  } catch (err) {
    if (seq !== feedRequestSeq) return;
    console.error('Feed USGS non raggiungibile:', err);
    setLive(false);
  }
}

function markNewInList(id) {
  // La lista viene ricostruita al render(): flash sul primo elemento nuovo
  setTimeout(() => {
    const first = $('quake-list').firstChild;
    if (first) first.classList.add('new');
  }, 100);
}

async function loadMonth() {
  setSource('month', 'loading');
  try {
    const r = await fetch(USGS + FEEDS.month, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    state.monthQuakes = parseFeed(await r.json());
    setSource('month', 'ok');
    mergeExtrasIntoState(); // riaggiunge gli eventi INGV/EMSC in cache: loadMonth() li avrebbe appena sovrascritti
    renderHistogram();
    renderStats();
    if (state.selectedDay || state.replay.active) render();
  } catch (err) {
    setSource('month', 'error');
    console.error('Feed mensile non raggiungibile:', err);
  }
}

// state.live conserva esito e ora dell'ultimo poll USGS; il conteggio invece è
// letto da state.quakes a ogni renderLive(), così resta allineato al globo
// anche quando un evento EMSC/INGV arriva tra un poll e l'altro.
function setLive(ok) {
  setSource('usgs', ok ? 'ok' : 'error');
  state.live.ok = ok;
  if (ok) state.live.at = new Date();
  renderLive();
}

function renderLive() {
  const { ok, at } = state.live;
  if (ok === null) return; // nessun poll ancora concluso: resta "connessione…"
  $('live-dot').className = 'dot ' + (ok ? 'ok' : 'err');
  $('live-text').textContent = ok
    ? `LIVE · ${state.quakes.length} eventi · agg. ${at.toLocaleTimeString('it-IT')}`
    : 'feed non raggiungibile — riprovo…';
}

// ---------- Controlli ----------
$('sel-window').onchange = e => {
  state.window = e.target.value;
  state.firstLoad = true; // niente allarmi per il backlog della nuova finestra
  selectDay(null);
  loadFeed();
};

let filterFrame = 0;
$('sel-mag').oninput = e => {
  state.minMag = parseFloat(e.target.value);
  $('mag-val').textContent = state.minMag;
  if (!filterFrame) filterFrame = requestAnimationFrame(() => { filterFrame = 0; render(); });
};

$('chk-sound').onchange = e => {
  state.sound = e.target.checked;
  if (state.sound) beep(3); // feedback + sblocco AudioContext
};
$('chk-rotate').onchange = e => { globe.controls().autoRotate = e.target.checked; };
$('chk-fly').onchange = e => { state.flyToNew = e.target.checked; };
$('chk-emsc').onchange = e => {
  state.emscLive = e.target.checked;
  if (state.emscLive) connectEmsc(); else disconnectEmsc();
};
// Box "Sulla fonte dati" comprimibile: un click sull'intestazione lo riduce,
// così istogramma e lista terremoti sotto guadagnano spazio (segnalato da
// Gimmy: nel pannello sinistro si vede sempre meno lista scendendo di finestra).
function toggleSourceBox(collapse) {
  const box = $('source-box');
  // Nessun argomento = alterna lo stato attuale: il "prossimo" show è il
  // contrario di collapsed. (Bug corretto: la negazione di troppo qui faceva
  // sì che il calcolo restituisse sempre lo stesso valore, click dopo click.)
  const show = collapse === undefined ? box.classList.contains('collapsed') : !collapse;
  box.classList.toggle('collapsed', !show);
  $('source-toggle').setAttribute('aria-expanded', String(show));
}
$('source-toggle').addEventListener('click', () => toggleSourceBox());
$('source-toggle').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSourceBox(); }
});

$('day-reset').onclick = () => selectDay(null);
$('country-reset').onclick = () => selectCountry(null);

$('btn-replay').onclick = () => { state.replay.active ? exitReplay() : startReplay(); };
$('replay-playpause').onclick = toggleReplayPlay;
$('replay-exit').onclick = exitReplay;
$('replay-slider').oninput = e => {
  state.replay.playing = false;
  $('replay-playpause').textContent = '▶️';
  clearInterval(replayTimer);
  state.replay.t = (parseInt(e.target.value, 10) / 1000) * REPLAY_RANGE_MS;
  render();
};

// Guida: il testo sta già nell'HTML (serve anche a motori di ricerca e IA,
// che non eseguono JavaScript), qui si gestisce solo l'apertura.
function toggleInfo(open) {
  const info = $('info');
  const show = open === undefined ? info.hidden : open;
  info.hidden = !show;
  document.body.classList.toggle('info-open', show);
  $('btn-info').setAttribute('aria-expanded', String(show));
  if (show) info.scrollTop = 0;
  syncAnimation();
}
$('btn-info').onclick = () => toggleInfo();
$('info-close').onclick = () => toggleInfo(false);

// Mobile: hamburger menu + panel drawer
const panel = $('panel');
const backdrop = $('panel-backdrop');
const hamburger = $('btn-hamburger');

const togglePanel = (show) => {
  panel.classList.toggle('open', show !== false);
};

hamburger.onclick = () => togglePanel();
backdrop.onclick = () => togglePanel(false);

// Chiudi il panel quando clicchi su un link o controllo
panel.addEventListener('click', (e) => {
  if (e.target.tagName === 'A' || e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT') {
    // Non chiudere subito per select (altrimenti non si apre), solo per click su link/button
    if (e.target.tagName !== 'SELECT' && !e.target.closest('#explore-box')) {
      setTimeout(() => togglePanel(false), 200);
    }
  }
});

document.addEventListener('keydown', e => { if (e.key === 'Escape') toggleInfo(false); });

// Pausa rotazione durante l'interazione
$('globe').addEventListener('pointerdown', () => { globe.controls().autoRotate = false; });
$('globe').addEventListener('pointerup', () => {
  setTimeout(() => { globe.controls().autoRotate = $('chk-rotate').checked; }, 3000);
});

window.addEventListener('resize', scheduleFitGlobe);
window.visualViewport?.addEventListener('resize', scheduleFitGlobe);

// Aggiorna i "tempo fa" della lista una volta al minuto
setInterval(() => {
  if (document.hidden) return;
  if (!state.replay.active) renderList(visibleQuakes());
  renderSources();
}, POLL_MS);

// ---------- Avvio ----------
// Diagnostica da console: attiva in locale e, su richiesta esplicita, con
// ?debug in coda all'indirizzo. Serve per ispezionare il sito pubblicato
// quando c'è da indagare un problema; di suo, in produzione, non è esposta.
if (['localhost', '127.0.0.1'].includes(location.hostname) ||
    new URLSearchParams(location.search).has('debug')) {
  window.SG = { globe, state, flatMap };
}
// Link diretto a un evento (?id=...): cercato solo nei 30 giorni disponibili,
// gli eventi più vecchi non sono raggiungibili con questa app.
function openSharedQuake(id) {
  const q = state.monthQuakes.find(x => x.id === id);
  if (!q) {
    showNotice('⚠️ Evento non trovato: il link punta a un terremoto più vecchio di 30 giorni, oppure non è più valido.');
    return;
  }
  selectDay(utcDay(q.time));
  flyTo(q, 1.3);
  showToast(q, false);
}

$('app-version').textContent = 'SismoGlobe ' + APP_VERSION;
(async () => {
  const sharedId = new URLSearchParams(location.search).get('id');
  await loadFeed();
  const monthLoaded = loadMonth();
  const sismoFvgLoaded = loadSismoFvg();
  const emscLoaded = loadEmscCatalog();
  $('loading').classList.add('done');
  setInterval(loadFeed, POLL_MS);
  setInterval(loadMonth, MONTH_POLL_MS);
  setInterval(loadSismoFvg, INGV_POLL_MS);
  setInterval(loadEmscCatalog, EMSC_POLL_MS);
  connectEmsc();
  if (sharedId) {
    await monthLoaded;
    await sismoFvgLoaded; // il link condiviso potrebbe puntare a un evento INGV
    await emscLoaded;     // ... o del catalogo EMSC
    openSharedQuake(sharedId);
  }
})();
