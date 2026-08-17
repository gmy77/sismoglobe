/* SismoGlobe — monitoraggio terremoti in tempo reale (dati USGS) */
'use strict';

const APP_VERSION = 'v1.6.0';
const USGS = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/';
const FEEDS = { day: 'all_day.geojson', week: 'all_week.geojson', month: 'all_month.geojson' };
const POLL_MS = 60_000;          // refresh feed corrente
const MONTH_POLL_MS = 10 * 60_000; // refresh istogramma 30gg
const RING_WINDOW_MS = 3 * 3600_000; // anelli animati per eventi recenti
const REPLAY_RANGE_MS = 30 * 86400_000;   // copre l'intero istogramma dei 30 giorni
const REPLAY_TRAIL_MS = 24 * 3600_000;    // finestra di eventi visibili in un dato istante del replay
const REPLAY_TICK_MS = 200;
const REPLAY_STEP_MS = REPLAY_RANGE_MS / 300; // ~48s reali per rivedere tutto il mese

// ---------- Stato ----------
const state = {
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
globe.pointOfView({ lat: 20, lng: 10, altitude: 2.2 });

// Centra il globo nello spazio libero a destra del pannello: il canvas viene
// allargato oltre il bordo destro (nascosto da overflow:hidden) così che il
// centro cada a metà dell'area visibile, non a metà finestra.
function fitGlobe() {
  const panel = $('panel');
  const pw = panel && panel.offsetWidth > 0 ? panel.getBoundingClientRect().right : 0;
  globe.width(window.innerWidth + Math.max(0, pw)).height(window.innerHeight);
}

// Pannello e avvisi partono sotto la barra, qualunque sia la sua altezza reale
function syncTopbarHeight() {
  document.documentElement.style.setProperty('--topbar-h', $('topbar').offsetHeight + 'px');
}
new ResizeObserver(() => { syncTopbarHeight(); fitGlobe(); }).observe($('topbar'));
syncTopbarHeight();
fitGlobe();

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
    plateMesh = await addLineMesh(lines, { altitude: 0.0075, color: '#ff9f43', opacity: 0.45 });
    plateMesh.visible = $('chk-plates').checked;
  })
  .catch(err => console.error('Placche tettoniche non caricate:', err));

$('chk-plates').onchange = e => { if (plateMesh) plateMesh.visible = e.target.checked; };

function flyTo(d, altitude = 1.5) {
  globe.pointOfView({ lat: d.lat, lng: d.lng, altitude }, 1200);
}

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

  el.addEventListener('pointermove', ev => {
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
  el.addEventListener('pointerdown', ev => { downAt = { x: ev.clientX, y: ev.clientY }; });

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

  // Nelle viste affollate (7g/30g) i punti vengono fusi in un'unica mesh:
  // molto più fluido, si perde solo il tooltip al passaggio del mouse
  globe.pointsMerge(vis.length > 600);
  globe.pointsData(vis);
  rebuildHitIndex(vis);   // puntamento a mano quando i punti sono fusi
  // Anelli solo su eventi recenti (o M>=5 se si guarda un giorno passato),
  // limitati ai 20 più forti: ogni anello animato costa parecchi frame
  const rings = (state.selectedDay
    ? vis.filter(q => q.mag >= 5)
    : vis.filter(q => now - q.time < RING_WINDOW_MS))
    .sort((a, b) => b.mag - a.mag)
    .slice(0, 20);
  globe.ringsData(rings);

  renderList(vis);
  renderStats();
}

const LIST_CAP = 300; // oltre, il DOM (mese ~11.000 eventi) rallenterebbe troppo

function renderList(vis) {
  const ul = $('quake-list');
  ul.innerHTML = '';
  const shown = vis.slice(0, LIST_CAP);
  $('list-count').textContent = vis.length > LIST_CAP
    ? `(${shown.length} di ${vis.length})`
    : `(${vis.length} visibili)`;
  for (const q of shown) {
    const li = document.createElement('li');
    const isEmsc = q.source === 'emsc';
    const shareBtn = isEmsc ? '' :
      `<button class="q-share" type="button" title="Copia un link diretto a questo evento">🔗</button>`;
    li.innerHTML = `
      <span class="mag-badge" style="background:${magColor(q.mag)}">${q.mag.toFixed(1)}</span>
      <div class="q-info">
        <div class="q-place">${q.place}${isEmsc ? ' <span class="q-pending" title="Notifica EMSC in attesa di conferma dal feed USGS">⚡</span>' : ''}</div>
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
  const src = state.monthQuakes.length ? state.monthQuakes : state.quakes;
  const today = src.filter(q => utcDay(q.time) === utcDay(now));
  const hour = src.filter(q => now - q.time < 3600_000);
  const last24 = src.filter(q => now - q.time < 86400_000);
  const maxQ = (state.selectedDay ? visibleQuakes() : last24)
    .reduce((a, b) => (!a || b.mag > a.mag ? b : a), null);

  $('st-today').textContent = today.length;
  $('st-hour').textContent = hour.length;
  $('st-max').textContent = maxQ ? 'M ' + maxQ.mag.toFixed(1) : '–';
  $('st-energy').textContent = fmtEnergy(last24.reduce((s, q) => s + energyJoules(q.mag), 0));
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

function startReplay() {
  if (!state.monthQuakes.length) {
    showNotice('⏳ Dati ancora in caricamento, riprova tra un istante.');
    return;
  }
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
  if (!state.replay.playing) return;
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
  if (state.replay.playing) {
    if (state.replay.t >= REPLAY_RANGE_MS) state.replay.t = 0; // riparte se era arrivato in fondo
    replayTimer = setInterval(replayTick, REPLAY_TICK_MS);
  }
}

function renderReplayFrame() {
  const virtualNow = Date.now() - REPLAY_RANGE_MS + state.replay.t;
  const list = state.monthQuakes.filter(q => q.time <= virtualNow && q.time > virtualNow - REPLAY_TRAIL_MS);
  globe.pointsMerge(list.length > 600);
  globe.pointsData(list);
  rebuildHitIndex(list);
  const rings = list
    .filter(q => virtualNow - q.time < 3 * 3600_000)
    .sort((a, b) => b.mag - a.mag)
    .slice(0, 20);
  globe.ringsData(rings);
  renderList(list);
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
// USGS, senza un secondo toast/beep. Se USGS non lo conferma mai (fuori
// catalogo o sotto soglia) resta come evento EMSC per EMSC_PENDING_MAX_MS,
// poi scompare.
const EMSC_WS_URL = 'wss://www.seismicportal.eu/standing_order/websocket';
const EMSC_MIN_MAG = 2.5;
const EMSC_RECONNECT_MS = 5000;
const EMSC_PENDING_MAX_MS = 15 * 60_000;
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
    scheduleEmscReconnect();
    return;
  }
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
    }
    showToast(q, true, { label: '⚡ EMSC in diretta', shareable: false });
    beep(q.mag);
  };
  emscWs.onclose = () => { emscWs = null; scheduleEmscReconnect(); };
  emscWs.onerror = () => { if (emscWs) emscWs.close(); };
}

function scheduleEmscReconnect() {
  if (!state.emscLive || emscReconnectTimer) return;
  emscReconnectTimer = setTimeout(() => { emscReconnectTimer = null; connectEmsc(); }, EMSC_RECONNECT_MS);
}

function disconnectEmsc() {
  clearTimeout(emscReconnectTimer);
  emscReconnectTimer = null;
  if (emscWs) { emscWs.onclose = null; emscWs.close(); emscWs = null; }
  if (state.emscPending.length) {
    state.quakes = state.quakes.filter(q => q.source !== 'emsc');
    state.emscPending = [];
    render();
  }
}

// ---------- Fetch e polling ----------
async function loadFeed() {
  try {
    const r = await fetch(USGS + FEEDS[state.window], { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const quakes = parseFeed(await r.json());

    // Ogni evento EMSC "in sospeso" confermato da USGS (stesso tempo/mag/
    // posizione, vedi isSameEmscUsgsEvent) esce dai sospesi: la voce ufficiale
    // USGS lo sostituisce senza un secondo toast. Chi resta in sospeso troppo
    // a lungo (EMSC_PENDING_MAX_MS) viene scartato: USGS non l'ha mai ripreso.
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
      if (biggest && state.flyToNew && biggest.mag >= 4.5) flyTo(biggest, 1.6);
    }
    quakes.forEach(q => state.seenIds.add(q.id));

    state.quakes = [...state.emscPending, ...quakes].sort((a, b) => b.time - a.time);
    state.firstLoad = false;
    setLive(true, state.quakes.length);
    render();
  } catch (err) {
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
  try {
    const r = await fetch(USGS + FEEDS.month, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    state.monthQuakes = parseFeed(await r.json());
    renderHistogram();
    renderStats();
  } catch (err) {
    console.error('Feed mensile non raggiungibile:', err);
  }
}

function setLive(ok, count) {
  const dot = $('live-dot');
  dot.className = 'dot ' + (ok ? 'ok' : 'err');
  $('live-text').textContent = ok
    ? `LIVE · ${count} eventi · agg. ${new Date().toLocaleTimeString('it-IT')}`
    : 'feed non raggiungibile — riprovo…';
}

// ---------- Controlli ----------
$('sel-window').onchange = e => {
  state.window = e.target.value;
  state.firstLoad = true; // niente allarmi per il backlog della nuova finestra
  selectDay(null);
  loadFeed();
};

$('sel-mag').oninput = e => {
  state.minMag = parseFloat(e.target.value);
  $('mag-val').textContent = state.minMag;
  render();
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
}
$('btn-info').onclick = () => toggleInfo();
$('info-close').onclick = () => toggleInfo(false);
document.addEventListener('keydown', e => { if (e.key === 'Escape') toggleInfo(false); });

// Pausa rotazione durante l'interazione
$('globe').addEventListener('pointerdown', () => { globe.controls().autoRotate = false; });
$('globe').addEventListener('pointerup', () => {
  setTimeout(() => { globe.controls().autoRotate = $('chk-rotate').checked; }, 3000);
});

window.addEventListener('resize', fitGlobe);

// Aggiorna i "tempo fa" della lista una volta al minuto
setInterval(() => render(), POLL_MS);

// ---------- Avvio ----------
// Diagnostica da console: attiva in locale e, su richiesta esplicita, con
// ?debug in coda all'indirizzo. Serve per ispezionare il sito pubblicato
// quando c'è da indagare un problema; di suo, in produzione, non è esposta.
if (['localhost', '127.0.0.1'].includes(location.hostname) ||
    new URLSearchParams(location.search).has('debug')) {
  window.SG = { globe, state };
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
  $('loading').classList.add('done');
  setInterval(loadFeed, POLL_MS);
  setInterval(loadMonth, MONTH_POLL_MS);
  connectEmsc();
  if (sharedId) {
    await monthLoaded;
    openSharedQuake(sharedId);
  }
})();
