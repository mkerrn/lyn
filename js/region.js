/* Region: draw a rectangle or a freehand outline, and chart the hour of day
   of every strike in the filter that falls inside it. */

/* ---------- the region ---------- */
/* Kept in the same normalised mercator units as D.wx / D.wy, so the test
   per strike is a bounding box check and, for a freehand outline, a ray
   cast — no projection. */
const region = {
  mode: null,        // 'rect' or 'free' while waiting for the drag
  xs: null, ys: null, rect: false,
  x0: 0, x1: 0, y0: 0, y1: 0,
  shape: null,       // the outline on the map
  swallowClick: false
};
const mapEl = map.getContainer();
const REGION_STYLE = {color:'#cfe4ec', weight:2, dashArray:'5 4', fillColor:'#cfe4ec',
                      fillOpacity:0.06, interactive:false};

function worldOf(e){
  const r = mapEl.getBoundingClientRect();
  return map.project(map.containerPointToLatLng([e.clientX - r.left, e.clientY - r.top]), 0).divideBy(256);
}
function latLngOfWorld(x, y){ return map.unproject([x*256, y*256], 0); }

function setDrawMode(mode){
  region.mode = mode;
  if(mode){ map.dragging.disable(); map.doubleClickZoom.disable(); }
  else    { map.dragging.enable();  map.doubleClickZoom.enable(); }
  mapEl.classList.toggle('drawing', !!mode);
  document.getElementById('rgRect').classList.toggle('on', mode === 'rect');
  document.getElementById('rgFree').classList.toggle('on', mode === 'free');
}

function drawShape(xs, ys){
  const ll = [];
  for(let j=0;j<xs.length;j++) ll.push(latLngOfWorld(xs[j], ys[j]));
  if(region.shape) region.shape.setLatLngs(ll);
  else region.shape = L.polygon(ll, REGION_STYLE).addTo(map);
}

let drag = null;   // {id, xs, ys, px, py} while the pointer is down
mapEl.addEventListener('pointerdown', e=>{
  if(!region.mode || e.button > 0 || e.target.closest('.leaflet-control')) return;
  e.preventDefault();
  mapEl.setPointerCapture(e.pointerId);
  const w = worldOf(e);
  drag = {id:e.pointerId, xs:[w.x], ys:[w.y], px:e.clientX, py:e.clientY};
});
mapEl.addEventListener('pointermove', e=>{
  if(!drag || e.pointerId !== drag.id) return;
  const w = worldOf(e);
  if(region.mode === 'rect'){
    const ax = drag.xs[0], ay = drag.ys[0];
    drawShape([ax, w.x, w.x, ax], [ay, ay, w.y, w.y]);
    drag.bx = w.x; drag.by = w.y;
  } else {
    /* Only keep a point once the pointer has moved a few pixels, so a slow
       hand does not leave thousands of vertices for the ray cast. */
    const dx = e.clientX - drag.px, dy = e.clientY - drag.py;
    if(dx*dx + dy*dy < 16) return;
    drag.px = e.clientX; drag.py = e.clientY;
    drag.xs.push(w.x); drag.ys.push(w.y);
    drawShape(drag.xs, drag.ys);
  }
});
function endDrag(e){
  if(!drag || e.pointerId !== drag.id) return;
  const d = drag, mode = region.mode;
  drag = null;
  region.swallowClick = true;
  setTimeout(()=>{ region.swallowClick = false; }, 0);
  let xs, ys;
  if(mode === 'rect'){
    if(d.bx === undefined){ cancelDraw(); return; }
    const ax = d.xs[0], ay = d.ys[0];
    xs = [ax, d.bx, d.bx, ax]; ys = [ay, ay, d.by, d.by];
  } else {
    if(d.xs.length < 3){ cancelDraw(); return; }
    xs = d.xs; ys = d.ys;
  }
  /* Under a few pixels across is a click, not a region. */
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const S = 256*Math.pow(2, map.getZoom());
  if((x1-x0)*S < 4 || (y1-y0)*S < 4){ cancelDraw(); return; }
  region.xs = Float64Array.from(xs); region.ys = Float64Array.from(ys);
  region.rect = mode === 'rect';
  region.x0 = x0; region.x1 = x1; region.y0 = y0; region.y1 = y1;
  drawShape(xs, ys);
  setDrawMode(null);
  regionHours();
}
mapEl.addEventListener('pointerup', endDrag);
mapEl.addEventListener('pointercancel', endDrag);
/* The pointerup that finishes a shape is followed by a click, which would
   otherwise open the strike popup. Caught on the way down, before Leaflet. */
document.addEventListener('click', e=>{
  if(region.swallowClick && mapEl.contains(e.target)){ e.stopPropagation(); region.swallowClick = false; }
}, true);
document.addEventListener('keydown', e=>{ if(e.key === 'Escape' && region.mode){ drag = null; cancelDraw(); } });

/* Leave drawing without a new shape: the previous region, if any, stays. */
function cancelDraw(){
  if(region.xs) drawShape(region.xs, region.ys);
  else if(region.shape){ map.removeLayer(region.shape); region.shape = null; }
  setDrawMode(null);
}

function clearRegion(){
  region.xs = region.ys = null;
  if(region.shape){ map.removeLayer(region.shape); region.shape = null; }
  setDrawMode(null);
  regionHours();
}

function inRegion(x, y){
  if(x < region.x0 || x > region.x1 || y < region.y0 || y > region.y1) return false;
  if(region.rect) return true;
  const xs = region.xs, ys = region.ys, n = xs.length;
  let inside = false;
  for(let a=0, b=n-1; a<n; b=a++){
    if((ys[a] > y) !== (ys[b] > y) && x < (xs[b]-xs[a])*(y-ys[a])/(ys[b]-ys[a]) + xs[a]) inside = !inside;
  }
  return inside;
}

/* Ground area from the shoelace area in mercator units, scaled by the
   mercator stretch at the region's middle latitude. Fine for anything
   short of half the country. */
function regionKm2(){
  const xs = region.xs, ys = region.ys, n = xs.length;
  let a = 0;
  for(let j=0, k=n-1; j<n; k=j++) a += (xs[k] + xs[j])*(ys[k] - ys[j]);
  const lat = latLngOfWorld(0, (region.y0+region.y1)/2).lat*Math.PI/180;
  const km = 40075.016686*Math.cos(lat);
  return Math.abs(a)/2*km*km;
}

/* ---------- which hour ---------- */
/* Norwegian clock time is CET, CEST from the last Sunday in March to the last
   Sunday in October, both at 01:00 UTC. One pair of switch times per year. */
const dstCache = new Map();
function dstSpan(y){
  let s = dstCache.get(y);
  if(!s){
    const last = m=>{ const d = new Date(Date.UTC(y, m+1, 0)); return Date.UTC(y, m, d.getUTCDate()-d.getUTCDay(), 1)/1000; };
    s = [last(2), last(9)];
    dstCache.set(y, s);
  }
  return s;
}
/* The year from an average year length can be one off around New Year,
   but both switches are months away from it, so the answer is the same. */
function osloOffset(t){
  const s = dstSpan(1970 + Math.floor(t/31556952));
  return t >= s[0] && t < s[1] ? 7200 : 3600;
}
const HOUR_LABEL = {oslo:'Norwegian clock time', solar:'local solar time', utc:'UTC'};
function hourOf(i, tz){
  let t = D.t0 + D.t[i];
  if(tz === 'oslo') t += osloOffset(t);
  else if(tz === 'solar') t += Math.round(D.lon[i]/1e5*240);   // 4 minutes per degree
  return Math.floor((((t % 86400) + 86400) % 86400)/3600);
}

/* ---------- the chart ---------- */
function regionHours(){
  const host = document.getElementById('regionChart');
  if(!region.xs){
    host.innerHTML = '<p class="cap">No region yet. Pick a shape above and drag on the map.</p>';
    return;
  }
  if(!D){ host.innerHTML = '<p class="cap">No strikes loaded.</p>'; return; }
  const tz = document.getElementById('hourTz').value;
  const hours = new Float64Array(24);
  let n = 0;
  for(let k=0;k<NCLASS;k++){
    const g = groups[k]; if(!g) continue;
    for(let j=0;j<g.length;j++){
      const i = g[j];
      if(!inRegion(D.wx[i], D.wy[i])) continue;
      hours[hourOf(i, tz)]++; n++;
    }
  }
  const km2 = regionKm2();
  const area = km2 >= 100 ? Math.round(km2).toLocaleString('en') : km2.toFixed(1);
  if(!n){
    host.innerHTML = '<p class="cap">No strikes in the region (' + area + ' km²) with the current filters.</p>';
    return;
  }

  let best = 0, peak = 0;
  for(let h=0;h<24;h++) if(hours[h] > best){ best = hours[h]; peak = h; }
  const w = 260, ch = 90, pad = 4, bw = (w - 2*pad)/24;
  let svg = '<svg viewBox="0 0 '+w+' '+(ch+14)+'" xmlns="http://www.w3.org/2000/svg">';
  for(let h=0;h<24;h++){
    const bh = hours[h]/best*(ch-10);
    const x = pad + h*bw;
    svg += '<rect x="'+(x+0.5).toFixed(1)+'" y="'+(ch-bh).toFixed(1)+'" width="'+(bw-1).toFixed(1)+
           '" height="'+bh.toFixed(1)+'" fill="#e2652f" opacity="0.85"><title>'+
           String(h).padStart(2,'0')+':00–'+String(h+1).padStart(2,'0')+':00 · '+
           hours[h].toLocaleString('en')+' strikes · '+pct(hours[h]/n)+'</title></rect>';
    if(h % 3 === 0)
      svg += '<text x="'+x.toFixed(1)+'" y="'+(ch+11)+'" font-size="8" fill="#93aab5">'+String(h).padStart(2,'0')+'</text>';
  }
  svg += '<line x1="'+pad+'" y1="'+ch+'" x2="'+(w-pad)+'" y2="'+ch+'" stroke="#2e4a58"/>';
  svg += '<text x="'+(w-pad)+'" y="8" text-anchor="end" font-size="8" fill="#93aab5">peak '+pct(best/n)+' per hour</text>';
  svg += '</svg>';

  host.innerHTML = svg +
    '<p class="cap">' + n.toLocaleString('en') + ' strikes in ' + area + ' km², by hour of ' +
    HOUR_LABEL[tz] + '. Busiest hour ' + String(peak).padStart(2,'0') + ':00–' +
    String(peak+1).padStart(2,'0') + ':00. Uses every strike in the filter, not the drawn sample.</p>';
}

document.getElementById('rgRect').onclick = ()=> setDrawMode(region.mode === 'rect' ? null : 'rect');
document.getElementById('rgFree').onclick = ()=> setDrawMode(region.mode === 'free' ? null : 'free');
document.getElementById('rgClear').onclick = clearRegion;
document.getElementById('hourTz').onchange = regionHours;
regionHours();
