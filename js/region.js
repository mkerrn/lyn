/* Region: draw a rectangle or a freehand outline, and chart the hour of day
   and the time of year of every strike in the filter that falls inside it. */

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

/* ---------- which part of the year ---------- */
/* The months in the filter, in calendar order but starting after a gap, so
   a winter of Nov–Feb reads left to right. The day range, when set, picks
   the months it touches. Fewer months get finer bars: halves under ten,
   quarters at three or fewer. Feb counts 29 days, as in the day filter. */
const MONTH_DAYS = [31,29,31,30,31,30,31,31,30,31,30,31];
function seasonBins(){
  const on = new Array(12).fill(false);
  const dr = dayRange();
  let first = 0;
  if(dr){
    const a = dr.lo >> 5, b = dr.hi >> 5;
    for(let m=a;;m=(m+1)%12){ on[m] = true; if(m === b) break; }
    first = a;
  } else {
    for(let m=0;m<12;m++) on[m] = monthOn[m];
    for(let m=0;m<12;m++) if(on[m] && !on[(m+11)%12]){ first = m; break; }
  }
  const months = [];
  for(let j=0;j<12;j++){ const m = (first+j)%12; if(on[m]) months.push(m); }
  const parts = months.length >= 10 ? 1 : months.length > 3 ? 2 : 4;
  const slot = new Int16Array(12).fill(-1);
  months.forEach((m,j)=> slot[m] = j*parts);
  return {months, parts, slot};
}
function seasonBin(s, md){
  const m = md >> 5, base = s.slot[m];
  if(base < 0) return -1;
  return base + Math.min(s.parts-1, Math.floor(((md & 31)-1)*s.parts/MONTH_DAYS[m]));
}
function seasonLabel(s, b){
  const m = s.months[Math.floor(b/s.parts)], p = b % s.parts, L = MONTH_DAYS[m];
  if(s.parts === 1) return MONTHS[m];
  return MONTHS[m]+' '+(Math.floor(p*L/s.parts)+1)+'–'+Math.floor((p+1)*L/s.parts);
}

/* ---------- the charts ---------- */
/* One bar chart: counts, the label under bar b (or null), the tooltip name of
   bar b, a title for the top left and the unit for the peak at the top right. */
function barChart(counts, n, tick, name, title, unit){
  const nb = counts.length;
  let best = 0;
  for(let b=0;b<nb;b++) if(counts[b] > best) best = counts[b];
  const w = 260, ch = 90, pad = 4, bw = (w - 2*pad)/nb;
  let svg = '<svg viewBox="0 0 '+w+' '+(ch+14)+'" xmlns="http://www.w3.org/2000/svg">';
  for(let b=0;b<nb;b++){
    const bh = best ? counts[b]/best*(ch-10) : 0;
    const x = pad + b*bw;
    svg += '<rect x="'+(x+0.5).toFixed(1)+'" y="'+(ch-bh).toFixed(1)+'" width="'+Math.max(0.5, bw-1).toFixed(1)+
           '" height="'+bh.toFixed(1)+'" fill="#e2652f" opacity="0.85"><title>'+
           name(b)+' · '+counts[b].toLocaleString('en')+' strikes · '+pct(counts[b]/n)+'</title></rect>';
    const t = tick(b);
    if(t !== null)
      svg += '<text x="'+x.toFixed(1)+'" y="'+(ch+11)+'" font-size="8" fill="#93aab5">'+t+'</text>';
  }
  svg += '<line x1="'+pad+'" y1="'+ch+'" x2="'+(w-pad)+'" y2="'+ch+'" stroke="#2e4a58"/>';
  svg += '<text x="'+pad+'" y="8" font-size="8" fill="#93aab5">'+title+'</text>';
  svg += '<text x="'+(w-pad)+'" y="8" text-anchor="end" font-size="8" fill="#93aab5">peak '+pct(best/n)+' per '+unit+'</text>';
  return svg + '</svg>';
}

function regionHours(){
  const host = document.getElementById('regionChart');
  if(!region.xs){
    host.innerHTML = '<p class="cap">No region yet. Pick a shape above and drag on the map.</p>';
    return;
  }
  if(!D){ host.innerHTML = '<p class="cap">No strikes loaded.</p>'; return; }
  const tz = document.getElementById('hourTz').value;
  const hours = new Float64Array(24);
  const s = seasonBins();
  const season = new Float64Array(s.months.length*s.parts);
  let n = 0;
  for(let k=0;k<NCLASS;k++){
    const g = groups[k]; if(!g) continue;
    for(let j=0;j<g.length;j++){
      const i = g[j];
      if(!inRegion(D.wx[i], D.wy[i])) continue;
      hours[hourOf(i, tz)]++; n++;
      const b = seasonBin(s, D.md[i]);
      if(b >= 0) season[b]++;
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
  const hh = h=> String(h).padStart(2,'0');
  const hourSvg = barChart(hours, n, h=> h % 3 === 0 ? hh(h) : null,
                           h=> hh(h)+':00–'+hh(h+1)+':00', 'hour of day', 'hour');
  const unit = s.parts === 1 ? 'month' : s.parts === 2 ? 'half month' : 'quarter month';
  const seasonSvg = barChart(season, n,
                             b=> b % s.parts === 0 ? MONTHS[s.months[b/s.parts]] : null,
                             b=> seasonLabel(s, b), 'time of year', unit);

  host.innerHTML = hourSvg +
    '<p class="cap">' + n.toLocaleString('en') + ' strikes in ' + area + ' km², by hour of ' +
    HOUR_LABEL[tz] + '. Busiest hour ' + hh(peak) + ':00–' + hh(peak+1) +
    ':00. Uses every strike in the filter, not the drawn sample.</p>' +
    seasonSvg +
    '<p class="cap">The same strikes by ' + unit + ' (UTC date), across every year selected.</p>';
}

document.getElementById('rgRect').onclick = ()=> setDrawMode(region.mode === 'rect' ? null : 'rect');
document.getElementById('rgFree').onclick = ()=> setDrawMode(region.mode === 'free' ? null : 'free');
document.getElementById('rgClear').onclick = clearRegion;
document.getElementById('hourTz').onchange = regionHours;
regionHours();
