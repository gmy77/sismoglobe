/* Run with NODE_PATH pointing to an installation of linkedom.
   DOM simulation only: this does not measure browser/GPU performance. */
const {parseHTML} = require('linkedom');
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {document,window} = parseHTML(fs.readFileSync('index.html','utf8'));
for(const el of document.querySelectorAll('select')) {
  let value = el.querySelector('option[selected]')?.value || el.querySelector('option')?.value || '';
  Object.defineProperty(el,'value',{get:()=>value,set:v=>value=String(v)});
}
Object.defineProperty(document,'hidden',{value:false,writable:true});
for(const el of document.querySelectorAll('*')) {
  el.getBoundingClientRect=()=>({left:0,top:0,width:1000,height:700,right:332});
  el.offsetHeight=100;el.offsetWidth=320;
}
const ctx = new Proxy({}, {get:(o,k)=>o[k] || (()=>{}),set:(o,k,v)=>(o[k]=v,true)});
document.getElementById('map-canvas').getContext=()=>ctx;
const controls={autoRotate:true};let pov={lat:20,lng:10,altitude:2.6};
let paused=false,pointUpdates=0,ringUpdates=0;
const props={pointsMerge:false};
const renderer={setPixelRatio(){},setSize(){},domElement:document.createElement('canvas')};
const globe=new Proxy({}, {get:(o,k)=>{
  if(k==='controls')return()=>controls;
  if(k==='renderer')return()=>renderer;
  if(k==='scene')return()=>({traverse(){}});
  if(k==='pauseAnimation')return()=>{paused=true;return globe;};
  if(k==='resumeAnimation')return()=>{paused=false;return globe;};
  if(k==='pointOfView')return v=>v?(pov={...v},globe):pov;
  if(k==='getCoords')return(lat,lng)=>({x:lat,y:lng,z:0});
  return (...args)=>{if(!args.length)return props[k];props[k]=args[0];if(k==='pointsData')pointUpdates++;if(k==='ringsData')ringUpdates++;return globe;};
}});
let now=0, rafs=new Map(),nextRaf=1;
const storage=new Map();
const sandbox={document,window,navigator:{},location:{hostname:'localhost',search:'',href:'http://localhost/'},
  Globe:()=>()=>globe,Path2D:class{moveTo(){}lineTo(){}closePath(){}},ResizeObserver:class{observe(){}},
  matchMedia:q=>({matches:String(q).includes('min-width')}),devicePixelRatio:1,localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
  fetch:()=>new Promise(()=>{}),AbortSignal,URL,URLSearchParams,console,Date,Math,Set,Map,Float32Array,
  performance:{now:()=>now},requestAnimationFrame:f=>{const id=nextRaf++;rafs.set(id,f);return id;},cancelAnimationFrame:id=>rafs.delete(id),setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){}};
window.innerWidth=1400;window.innerHeight=900;window.devicePixelRatio=1;window.matchMedia=sandbox.matchMedia;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('explorer.js','utf8'),sandbox);
vm.runInContext(fs.readFileSync('main.js','utf8'),sandbox);
const run=code=>vm.runInContext(code,sandbox);
function test(name,fn){fn();console.log('PASS',name);}
function flushRaf(){const f=[...rafs.values()];rafs.clear();for(const cb of f)cb(now);}
const fixture=Array.from({length:12000},(_,i)=>({id:'q'+i,lat:i%150-75,lng:i%360-180,mag:i%7,depth:10,time:Date.now()-i*1000,place:'Test '+i}));
sandbox.fixture=fixture;
test('startup, version and canvas stays within visible viewport',()=>{assert.equal(document.getElementById('app-version').textContent,'SismoGlobe v1.9.1');assert.equal(props.width,1056);assert.equal(props.height,800);});
test('12000 events use merged geometry and at most six ring sources',()=>{run('state.quakes=fixture; state.monthQuakes=fixture; render()');assert.equal(props.pointsMerge,true);assert.equal(props.pointsData.length,12000);assert.ok(props.ringsData.length<=6);assert.equal(document.getElementById('quake-list').children.length,500);});
test('2D suspends globe and does not rebuild its geometry',()=>{const updates=pointUpdates;run("setView('2d'); render()");flushRaf();assert.equal(paused,true);assert.equal(pointUpdates,updates);assert.equal(document.getElementById('map-view').hidden,false);assert.ok(run('flatMap.hits.length')>0);});
test('2D shares magnitude filter and returns to 3D',()=>{run("state.minMag=5;render()");assert.equal(run('flatMap.quakes.every(q=>q.mag>=5)'),true);run("setView('3d')");assert.equal(paused,false);assert.equal(props.pointsData.every(q=>q.mag>=5),true);});
test('reduced animation mode removes rings',()=>{document.getElementById('sel-quality').onchange({target:{value:'light'}});assert.equal(props.ringsData.length,0);});
test('hidden document pauses animation and geometry updates',()=>{const updates=pointUpdates;document.hidden=true;run('syncAnimation();render()');assert.equal(paused,true);assert.equal(pointUpdates,updates);document.hidden=false;run('syncAnimation();render()');assert.equal(paused,false);});
test('source failure preserves last successful time and cached events',()=>{run("setSource('emsc','ok')");const at=run('sourceHealth.emsc.at');run("setSource('emsc','error')");assert.equal(run('sourceHealth.emsc.at'),at);assert.equal(run('state.quakes.length'),12000);assert.match(document.getElementById('source-health').textContent,/dati conservati/);});
test('favorite names are stored as text, survive storage and can be removed',()=>{document.getElementById('favorite-name').value='<img src=x onerror=alert(1)>';document.getElementById('favorite-form').onsubmit({preventDefault(){}});assert.equal(run('favorites.length'),1);assert.match(storage.get('sismoglobe.views.v1'),/img/);assert.equal(document.getElementById('sel-place').querySelector('img'),null);document.getElementById('remove-place').onclick();assert.equal(run('favorites.length'),0);});
test('map zoom bounded, motion redraws coalesced and inactive map does no work',()=>{run("setView('2d');flatMap.zoom(10000)");assert.equal(run('flatMap.view.zoom'),30);flushRaf();run('flatMap.schedule();flatMap.schedule();flatMap.schedule()');assert.equal(rafs.size,1);flushRaf();run("setView('3d');flatMap.schedule()");assert.equal(rafs.size,0);});
test('replay list throttled but paused frame stays accurate',()=>{now=2000;run('state.minMag=0;state.replay.active=true;state.replay.playing=true;state.replay.t=REPLAY_RANGE_MS;renderReplayFrame()');const first=document.getElementById('quake-list').firstChild;now=2200;run('renderReplayFrame()');assert.equal(document.getElementById('quake-list').firstChild,first);run('state.replay.playing=false;renderReplayFrame()');assert.notEqual(document.getElementById('quake-list').firstChild,first);});
test('quake detail toast includes estimated waveform',()=>{run('showToast(fixture[0], false)');const wave=document.querySelector('.toast .waveform');assert.ok(wave);assert.match(wave.textContent,/non è un sismogramma/i);assert.ok(wave.querySelector('.waveform-line')?.getAttribute('d').startsWith('M'));});
console.log('11 logic tests passed. Browser/WebGL verification remains required.');
