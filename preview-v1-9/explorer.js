/* Lightweight, on-demand 2D map. Shares the existing country dataset; no tile requests. */
'use strict';
class SismoMap {
  constructor(canvas, onPick, onCountry) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.view = { lat: 0, lng: 0, zoom: 1 };
    this.countries = [];
    this.plates = [];
    this.quakes = [];
    this.showPlates = true;
    this.active = false;
    this.frame = 0;
    this.paths = [];
    this.hits = [];
    this.drag = null;
    const normalize = lng => ((lng + 180) % 360 + 360) % 360 - 180;
    canvas.addEventListener('pointerdown', e => {
      this.drag = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', e => {
      if (!this.drag) return;
      const scale = this.scale();
      this.view.lng = normalize(this.view.lng - (e.clientX - this.drag.x) / scale);
      this.view.lat = Math.max(-80, Math.min(80, this.view.lat + (e.clientY - this.drag.y) / scale));
      this.drag.moved ||= Math.hypot(e.clientX - this.drag.startX, e.clientY - this.drag.startY) > 5;
      this.drag.x = e.clientX; this.drag.y = e.clientY;
      this.schedule();
    });
    canvas.addEventListener('pointerup', e => {
      const drag = this.drag; this.drag = null;
      if (!drag || drag.moved) return;
      const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      let best = null, distance = Infinity;
      for (const h of this.hits) {
        const d = Math.hypot(h.x - x, h.y - y);
        if (d <= Math.max(8, h.r) && d < distance) { best = h.q; distance = d; }
      }
      if (best) onPick(best);
      else onCountry(this.view.lat - (y - this.height / 2) / this.scale(), normalize(this.view.lng + (x - this.width / 2) / this.scale()));
    });
    canvas.addEventListener('pointercancel', () => { this.drag = null; });
    canvas.addEventListener('wheel', e => {
      e.preventDefault(); this.zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2);
    }, { passive: false });
    canvas.addEventListener('keydown', e => {
      const step = 15 / this.view.zoom;
      if (e.key === '+' || e.key === '=') this.zoom(1.5);
      else if (e.key === '-') this.zoom(1 / 1.5);
      else if (e.key === 'ArrowLeft') this.view.lng = normalize(this.view.lng - step);
      else if (e.key === 'ArrowRight') this.view.lng = normalize(this.view.lng + step);
      else if (e.key === 'ArrowUp') this.view.lat = Math.min(80, this.view.lat + step);
      else if (e.key === 'ArrowDown') this.view.lat = Math.max(-80, this.view.lat - step);
      else return;
      e.preventDefault(); this.schedule();
    });
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
  }
  scale() { return Math.min(this.width / 360, this.height / 180) * this.view.zoom; }
  zoom(factor) { this.view.zoom = Math.max(1, Math.min(30, this.view.zoom * factor)); this.schedule(); }
  focus(lat, lng, zoom) { this.view = {lat, lng, zoom: Math.max(1, Math.min(30, zoom))}; this.schedule(); }
  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.width = r.width; this.height = r.height;
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); this.schedule();
  }
  setCountries(features) {
    this.countries = features;
    this.paths = features.map(f => {
      const path = new Path2D();
      const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const polygon of polygons) for (const ring of polygon) {
        ring.forEach(([lng,lat], i) => i ? path.lineTo(lng,-lat) : path.moveTo(lng,-lat)); path.closePath();
      }
      return path;
    });
    this.schedule();
  }
  schedule() {
    if (!this.active || document.hidden || this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); });
  }
  draw() {
    if (!this.width || !this.active) return;
    const c = this.ctx, w = this.width, h = this.height, s = this.scale();
    c.clearRect(0,0,w,h); c.fillStyle = '#070e1e'; c.fillRect(0,0,w,h);
    this.hits = [];
    for (const wrap of [-360,0,360]) {
      c.globalAlpha = 1;
      c.save(); c.translate(w/2 + (wrap-this.view.lng)*s, h/2 + this.view.lat*s); c.scale(s,s);
      c.lineWidth = .7/s; c.strokeStyle = '#182944'; c.beginPath();
      for(let lng=-180;lng<=180;lng+=30) {c.moveTo(lng,-90);c.lineTo(lng,90);}
      for(let lat=-90;lat<=90;lat+=30) {c.moveTo(-180,lat);c.lineTo(180,lat);}
      c.stroke(); c.fillStyle='#14243a'; c.strokeStyle='#59799f';
      for(const path of this.paths) { c.fill(path,'evenodd'); c.stroke(path); }
      if(this.showPlates) {
        c.strokeStyle='#bc793c';c.beginPath();
        for(const line of this.plates) line.forEach(([lat,lng],i)=>{
          if(!i || Math.abs(lng-line[i-1][1])>180)c.moveTo(lng,-lat);else c.lineTo(lng,-lat);
        });
        c.stroke();
      }
      c.restore();
      // Draw older events first so recent events stay visible above them.
      for(let i=this.quakes.length-1;i>=0;i--) {
        const q=this.quakes[i], x=w/2+(q.lng+wrap-this.view.lng)*s, y=h/2+(this.view.lat-q.lat)*s;
        const r=Math.max(2,Math.min(14,2+q.mag*q.mag*.18));
        if(x < -r || x > w+r || y < -r || y > h+r)continue;
        c.beginPath();c.arc(x,y,r,0,2*Math.PI);c.fillStyle=magColor(q.mag);c.globalAlpha=.8;c.fill();
        this.hits.push({q,x,y,r});
      }
    }
    c.globalAlpha=1;
  }
}
