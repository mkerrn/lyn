/* Grid layers: WXG1 files of half-month values per map cell, combined over
   the selected years and part of the year, drawn as a canvas layer, with the
   readout, popup and region chart for them. */

const WX_INDEX_URL = 'data/wx/index.json';
const LAYER_KEY = 'lyn.layer';

let wx = null;        // data/wx/index.json, or null when there is none
let wxLayer = null;   // the grid layer shown, from wx.layers; null on lightning
let wxCur = null;     // what is drawn: {key, band, years, wt, mean, areas:[{area, files, vals}]}
let wxGen = 0;        // bumped whenever wxCur is rebuilt

/* ---------- ramps ---------- */
/* Cool colours only, so nothing reads as one of the warm strike classes. The
   temperature ramp runs from blue through white to purple, stretched over
   the range like any other, so white is the middle of it, not 0 °C. A fading
   ramp is mostly see-through at the low end, so the empty cells leave the
   base map readable, like the density grid. */
const RAMPS = {
  seq:  {stops:['#bfd3e6','#9ebcda','#8c96c6','#8c6bb1','#88419d','#6e016b','#3f0040'], fade:true},
  temp: {stops:['#053061','#2166ac','#67a9cf','#d1e5f0','#f7f7f7','#e7d4e8','#c2a5cf','#9970ab','#40004b']}
};
function rampLut(stops, fade){
  const rgb = stops.map(rgbOf), lut = new Uint32Array(256);
  for(let i=0;i<256;i++){
    const f = i/255*(rgb.length-1), j = Math.min(rgb.length-2, Math.floor(f)), u = f - j;
    let c = 0;
    for(let s=0;s<24;s+=8){
      const a = (rgb[j]>>s) & 255, b = (rgb[j+1]>>s) & 255;
      c |= Math.round(a + (b-a)*u) << s;
    }
    const A = fade ? Math.round(255*(0.15 + 0.85*Math.sqrt(i/255))) : 255;
    lut[i] = ((A << 24) | c) >>> 0;
  }
  return lut;
}
for(const r of Object.values(RAMPS)) r.lut = rampLut(r.stops, r.fade);
const rampOf = band=> RAMPS[band.ramp] || RAMPS.seq;

/* 0–1 along the ramp. */
function rampPos(v, lo, hi){
  const t = hi > lo ? (v-lo)/(hi-lo) : 0.5;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
/* The ramp as a CSS gradient, sampled from the lookup table so the legend
   fades at the low end just as the cells do. */
function rampCss(r){
  const s = [];
  for(let i=0;i<=16;i++){
    const c = r.lut[Math.round(i/16*255)];
    s.push('rgba(' + (c & 255) + ',' + (c>>8 & 255) + ',' + (c>>16 & 255) + ',' + ((c>>>24)/255).toFixed(3) + ')');
  }
  return 'linear-gradient(to right,' + s.join(',') + ')';
}

/* ---------- WXG1 ---------- */
/* Header, a 27-byte record per band, then the bands one after another, each
   24 half-months of nx × ny cells, rows north to south. */
const WX_TYPES = [null, Uint8Array, Int16Array, Uint16Array];
function parseWxg(buf){
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0),dv.getUint8(1),dv.getUint8(2),dv.getUint8(3));
  if(magic !== 'WXG1') throw new Error('not a WXG1 file');
  const L = dv.getUint8(6), nb = dv.getUint8(7), np = dv.getUint8(8), year = dv.getInt16(9, true);
  const x0 = dv.getUint32(11, true), y0 = dv.getUint32(15, true);
  const nx = dv.getUint16(19, true), ny = dv.getUint16(21, true);
  let o = 23;
  const heads = [];
  for(let b=0;b<nb;b++){
    let id = '';
    for(let k=0;k<16;k++){ const ch = dv.getUint8(o+k); if(ch) id += String.fromCharCode(ch); }
    const dtype = dv.getUint8(o+16), T = WX_TYPES[dtype];
    let nodata = dv.getUint16(o+25, true);
    if(T === Int16Array && nodata > 32767) nodata -= 65536;
    heads.push({id, T, scale:dv.getFloat32(o+17, true), offset:dv.getFloat32(o+21, true), nodata});
    o += 27;
  }
  /* Wider types are copied out to an aligned buffer: the header leaves the
     data at an odd offset. */
  const n = np*nx*ny, bands = {};
  for(const h of heads){
    const bytes = n*h.T.BYTES_PER_ELEMENT;
    h.data = h.T === Uint8Array ? new Uint8Array(buf, o, n) : new h.T(buf.slice(o, o + bytes));
    o += bytes;
    bands[h.id] = h;
  }
  return {L, year, x0, y0, nx, ny, np, bands};
}

/* ---------- which years and which part of the year ---------- */
/* Every year on reads the one file holding the mean over all of them. */
function wxYearKeys(){
  const all = wx.years.map(String);
  const on = manifest ? all.filter(y=> yearOn.has(y)) : all;
  return on.length === all.length ? ['0'] : on;
}

const inDays = (dr, k)=> dr.lo <= dr.hi ? (k >= dr.lo && k <= dr.hi) : (k >= dr.lo || k <= dr.hi);

/* Days in each half-month: 15, then the rest of the month, Feb at 28.25. */
const PERIOD_DAYS = Array.from({length:24}, (_,p)=> p % 2 ? (p === 3 ? 13.25 : MONTH_DAYS[p>>1] - 15) : 15);
/* The same counted the way the day filter counts, Feb with 29 days. */
const PERIOD_SLOTS = Array.from({length:24}, (_,p)=> p % 2 ? MONTH_DAYS[p>>1] - 15 : 15);

/* How much of each half-month takes part, 0–1: whole halves for the month
   toggles, the share of its days in range for a day range. */
function wxWeights(){
  const w = new Float64Array(24), dr = dayRange();
  for(let m=0;m<12;m++){
    if(!dr){ if(monthOn[m]) w[2*m] = w[2*m+1] = 1; continue; }
    const cnt = [0,0];
    for(let d=1; d<=MONTH_DAYS[m]; d++) if(inDays(dr, m*32 + d)) cnt[d > 15 ? 1 : 0]++;
    w[2*m] = cnt[0]/PERIOD_SLOTS[2*m]; w[2*m+1] = cnt[1]/PERIOD_SLOTS[2*m+1];
  }
  return w;
}

/* 'Jun–Aug', 'Jan, Mar', '15/8 – 15/9', or null for the whole year. */
function wxPartLabel(){
  const dr = dayRange();
  if(dr){ const f = k=> (k & 31) + '/' + ((k >> 5) + 1); return f(dr.lo) + ' – ' + f(dr.hi); }
  const ms = seasonBins().months;
  if(ms.length === 12) return null;
  if(!ms.length) return 'no months';
  const run = ms.every((m,j)=> !j || m === (ms[j-1] + 1) % 12);
  if(ms.length === 1) return MONTHS[ms[0]];
  return run ? MONTHS[ms[0]] + '–' + MONTHS[ms[ms.length-1]] : ms.map(m=> MONTHS[m]).join(', ');
}
/* What a value means: days a year in Jun–Aug, or the mean over them. */
function wxPhrase(){
  const part = wxPartLabel();
  if(wxCur.mean) return part ? 'mean over ' + part : 'year-round mean';
  return part ? 'a year in ' + part : 'a year';
}
function wxFmt(v){
  if(!(v === v)) return '—';
  return wxRound(v) + ' ' + wxCur.band.unit;
}
/* Whole numbers from 100 up, one decimal below, as text. */
const wxRound = v=> Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1);

/* ---------- loading ---------- */
const wxFiles = new Map();    // url -> promise of the parsed file
const wxParsed = new Map();   // url -> parsed file, once it has arrived
/* One file, fetched and parsed but not kept. */
const wxGet = url=> fetch(url)
  .then(r=>{ if(!r.ok) throw new Error(r.status + ' ' + r.statusText); return r.arrayBuffer(); })
  .then(maybeGunzip).then(parseWxg);
function wxFetch(url){
  let p = wxFiles.get(url);
  if(!p){
    p = wxGet(url).then(f=>{ wxParsed.set(url, f); return f; });
    p.catch(()=> wxFiles.delete(url));
    wxFiles.set(url, p);
  }
  return p;
}

/* Fetches whatever the current layer, years and part of the year need, then
   rebuilds and redraws. A newer call overtakes an older one still waiting. */
const wxStatus = document.getElementById('wxStatus');
let wxSeq = 0;
async function wxRefresh(){
  if(!wxLayer) return;
  const seq = ++wxSeq, years = wxYearKeys(), urls = [];
  for(const a of wx.areas){
    const f = wxLayer.files[a.id];
    if(f) for(const y of years) if(f[y]) urls.push(f[y]);
  }
  const missing = urls.filter(u=> !wxParsed.has(u));
  for(const [j,u] of missing.entries()){
    wxStatus.textContent = 'Loading ' + u.split('/').pop() +
      (missing.length > 1 ? ' (' + (j+1) + ' of ' + missing.length + ')' : '') + '…';
    try{ await wxFetch(u); }
    catch(err){ if(seq === wxSeq) wxStatus.textContent = 'Could not load ' + u + ': ' + err.message; return; }
    if(seq !== wxSeq) return;
  }
  wxCompute(years);
  const ny = wx.years.length;
  wxStatus.textContent = !years.length ? 'No years selected.'
    : years[0] === '0' ? 'Mean of all ' + ny + ' years, ' + wx.years[0] + '–' + wx.years[ny-1] + '.'
    : years.length === 1 ? 'The year ' + years[0] + ' only.'
    : 'Mean of ' + years.length + ' years: ' + years.join(', ') + '.';
  wxReadout(null);
  wxCanvas.redraw();
  regionHours();
}

/* ---------- combining ---------- */
/* One value per cell for the current band. Mean bands are averaged over the
   half-months weighted by their days; sum bands add the half-months up, so a
   day count is days a year in the selected part of it. Both are averaged
   over the years, and a half-month with no data in some year is left out of
   that year rather than counted as zero. Cells outside the height band are
   left without a value, which is what keeps the map, readout, popup and
   region to it. */
function wxBand(){
  const id = document.getElementById('wxBand').value;
  return wxLayer.bands.find(b=> b.id === id) || wxLayer.bands[0];
}
function wxCompute(years){
  const band = wxBand(), wt = wxWeights();
  const key = [wxLayer.id, band.id, years.join(), wt.join(), hbandLabel(hband)].join('|');
  if(wxCur && wxCur.key === key) return;
  const mean = band.agg === 'mean';
  const ww = Array.from(wt, (w,p)=> mean ? w*PERIOD_DAYS[p] : w);
  let W = 0;
  for(const w of wt) W += w;
  const areas = [];
  for(const a of wx.areas){
    const f = wxLayer.files[a.id]; if(!f) continue;
    const files = years.map(y=> wxParsed.get(f[y])).filter(Boolean);
    if(!files.length) continue;
    const g = files[0], n = g.nx*g.ny;
    const num = new Float32Array(n), den = new Float32Array(n);
    for(const file of files){
      const b = file.bands[band.id]; if(!b) continue;
      for(let p=0;p<24;p++) if(ww[p]) addPeriod(num, den, b.data, p*n, n, b.scale, b.offset, b.nodata, ww[p]);
    }
    const vals = new Float32Array(n), k = mean ? 1 : W;
    for(let i=0;i<n;i++) vals[i] = den[i] ? num[i]/den[i]*k : NaN;
    if(hband){
      const hs = cellHeights(g);
      for(let i=0;i<n;i++) if(!inHband(hs[i])) vals[i] = NaN;
    }
    areas.push({id:a.id, area:g, files, vals});
  }
  wxCur = {key, band, years, wt, mean, areas};
  wxGen++;
}
function addPeriod(num, den, raw, o, n, sc, of, nd, w){
  for(let i=0;i<n;i++){
    const r = raw[o+i];
    if(r === nd) continue;
    num[i] += w*(r*sc + of); den[i] += w;
  }
}

/* The 24 half-month values, per year, averaged over a set of cells:
   sets = [{A, cells, w}] with an area weight per cell. */
function wxPeriods(sets){
  const id = wxCur.band.id, num = new Float64Array(24), den = new Float64Array(24);
  for(const s of sets) for(const f of s.files || s.A.files){
    const b = f.bands[id]; if(!b) continue;
    const n = f.nx*f.ny, raw = b.data;
    for(let p=0;p<24;p++){
      const o = p*n;
      for(let j=0;j<s.cells.length;j++){
        const r = raw[o + s.cells[j]];
        if(r === b.nodata) continue;
        num[p] += s.w[j]*(r*b.scale + b.offset); den[p] += s.w[j];
      }
    }
  }
  return Array.from(num, (x,p)=> den[p] ? x/den[p] : NaN);
}
/* Those half-months combined the way the map combines them. */
function wxTotal(per){
  let s = 0, d = 0;
  for(let p=0;p<24;p++){
    if(!wxCur.wt[p] || !(per[p] === per[p])) continue;
    const w = wxCur.mean ? wxCur.wt[p]*PERIOD_DAYS[p] : wxCur.wt[p];
    s += w*per[p]; d += w;
  }
  return d ? (wxCur.mean ? s/d : s) : NaN;
}

/* ---------- the canvas layer ---------- */
/* The strike layer's canvas handling, with a draw that copies the cells in
   view into a small image, one pixel per cell, scaled up unsmoothed. */
const WxCanvas = StrikeLayer.extend({
  _draw: function(){
    const m = this._map, c = this._canvas, ctx = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1, size = m.getSize();
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,size.x,size.y);
    if(!wxCur) return;

    const S = 256*Math.pow(2, m.getZoom());
    const origin = m.getPixelOrigin(), topLeft = m.containerPointToLayerPoint([0,0]);
    const ox = origin.x + topLeft.x, oy = origin.y + topLeft.y, W = size.x, H = size.y;

    /* The cells in view, and their range for the unfixed scale: the 1st to
       99th percentile, as rain and snow are so skewed that the wettest few
       cells would leave the rest of the map pale. */
    const views = [], seen = [];
    for(const A of wxCur.areas){
      const g = A.area, px = S/Math.pow(2, g.L);
      const a = Math.max(0, Math.floor(ox/px) - g.x0), b = Math.min(g.nx-1, Math.floor((ox+W)/px) - g.x0);
      const c0 = Math.max(0, Math.floor(oy/px) - g.y0), d = Math.min(g.ny-1, Math.floor((oy+H)/px) - g.y0);
      if(a > b || c0 > d) continue;
      views.push({A, px, a, b, c:c0, d});
      const step = Math.max(1, Math.round(Math.sqrt((b-a+1)*(d-c0+1)/40000)));
      for(let y=c0;y<=d;y+=step){
        const row = y*g.nx;
        for(let x=a;x<=b;x+=step){
          const v = A.vals[row+x];
          if(v === v) seen.push(v);
        }
      }
    }
    const sorted = Float32Array.from(seen).sort();
    let lo = sorted.length ? sorted[Math.floor(0.01*(sorted.length-1))] : Infinity;
    let hi = sorted.length ? sorted[Math.ceil(0.99*(sorted.length-1))] : -Infinity;
    if(document.getElementById('wxFix').checked){
      const fl = parseFloat(document.getElementById('wxMin').value), fh = parseFloat(document.getElementById('wxMax').value);
      if(!isNaN(fl) && !isNaN(fh) && fh > fl){ lo = fl; hi = fh; }
    }
    this._lo = lo; this._hi = hi;
    wxLegend(lo, hi);
    if(!(hi >= lo)) return;

    const r = rampOf(wxCur.band), lut = r.lut;
    ctx.globalAlpha = +document.getElementById('wxOpacity').value/100;
    for(const v of views){
      const g = v.A.area, vw = v.b - v.a + 1, vh = v.d - v.c + 1;
      const img = new ImageData(vw, vh), u32 = new Uint32Array(img.data.buffer);
      for(let y=v.c;y<=v.d;y++){
        const row = y*g.nx, o = (y - v.c)*vw - v.a;
        for(let x=v.a;x<=v.b;x++){
          const val = v.A.vals[row+x];
          if(val === val) u32[o+x] = lut[Math.round(rampPos(val, lo, hi)*255)];
        }
      }
      const off = this._cellCanvas = this._cellCanvas || document.createElement('canvas');
      off.width = vw; off.height = vh;
      off.getContext('2d').putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = v.px < 1;
      ctx.drawImage(off, (g.x0 + v.a)*v.px - ox, (g.y0 + v.c)*v.px - oy, vw*v.px, vh*v.px);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 1;
  }
});
const wxCanvas = new WxCanvas();

function wxLegend(lo, hi){
  const ok = hi >= lo, r = rampOf(wxCur.band);
  document.getElementById('wxLo').textContent = ok ? wxFmt(lo) : '—';
  document.getElementById('wxHi').textContent = ok ? wxFmt(hi) : '—';
  document.getElementById('wxMid').textContent = ok ? wxFmt((lo + hi)/2) : '';
  document.getElementById('wxPhrase').textContent = wxCur.band.unit + ', ' + wxPhrase();
  document.getElementById('wxRamp').style.background = rampCss(r);
  if(!document.getElementById('wxFix').checked && ok){
    document.getElementById('wxMin').placeholder = +wxRound(lo);
    document.getElementById('wxMax').placeholder = +wxRound(hi);
  }
}

/* ---------- readout and popup ---------- */
function wxCellAt(latlng){
  if(!wxCur) return null;
  const p = map.project(latlng, 0);
  for(const A of wxCur.areas){
    const g = A.area, N = Math.pow(2, g.L);
    const cx = Math.floor(p.x/256*N) - g.x0, cy = Math.floor(p.y/256*N) - g.y0;
    if(cx >= 0 && cx < g.nx && cy >= 0 && cy < g.ny) return {A, i:cy*g.nx + cx};
  }
  return null;
}
function wxReadout(latlng){
  if(!wxCur) return;
  const h = latlng && wxCellAt(latlng), v = h ? h.A.vals[h.i] : NaN;
  readout.innerHTML = v === v
    ? '<b>' + wxFmt(v) + '</b> ' + wxPhrase() + ' · tap for the half-months'
    : wxLayer.label + ' · point at the map for a value';
}
map.on('mousemove', e=>{ if(!isLightning()) wxReadout(e.latlng); });
map.on('mouseout', ()=>{ if(!isLightning()) wxReadout(null); });

const WX_BAR = '#8c96c6';
function wxPopup(e){
  const h = wxCellAt(e.latlng); if(!h) return;
  const v = h.A.vals[h.i]; if(!(v === v)) return;
  const per = wxPeriods([{A:h.A, cells:[h.i], w:[1]}]);
  const svg = barChart(per, 0, p=> p % 6 === 0 ? MONTHS[p/2] : null,
    p=> MONTHS[p>>1] + (p % 2 ? ' 16–end' : ' 1–15'),
    'by half-month' + (wxCur.mean ? '' : ', a year'), null,
    {fmt:wxFmt, color:WX_BAR, dim:p=> !wxCur.wt[p]});
  L.popup({closeButton:true, maxWidth:280})
    .setLatLng(e.latlng)
    .setContent('<b>' + wxFmt(v) + '</b> ' + wxPhrase() + '<br>' + wxLayer.label + ' · ' +
      wxStatus.textContent.replace(/\.$/, '') + '<div class="wxPop">' + svg + '</div>' +
      e.latlng.lat.toFixed(4) + ', ' + e.latlng.lng.toFixed(4))
    .openOn(map);
}

/* ---------- region ---------- */
/* Every cell whose centre is inside the outline and has data, weighted by its
   true area, so the result is the mean over a random point of the region. */
function wxRegion(){
  const host = document.getElementById('regionChart');
  if(!wxCur || !wxCur.areas.length){ host.innerHTML = '<p class="cap">Nothing loaded for this layer yet.</p>'; return; }
  const sets = [];
  let ncell = 0, km2 = 0;
  for(const A of wxCur.areas){
    const g = A.area, N = Math.pow(2, g.L), side = EARTH_KM/N;
    const a = Math.max(0, Math.floor(region.x0*N) - g.x0), b = Math.min(g.nx-1, Math.floor(region.x1*N) - g.x0);
    const c = Math.max(0, Math.floor(region.y0*N) - g.y0), d = Math.min(g.ny-1, Math.floor(region.y1*N) - g.y0);
    const cells = [], w = [];
    for(let y=c;y<=d;y++){
      const lat = Math.atan(Math.sinh(Math.PI*(1 - 2*(g.y0 + y + 0.5)/N)));
      const cw = Math.pow(side*Math.cos(lat), 2);
      for(let x=a;x<=b;x++){
        const i = y*g.nx + x;
        if(!(A.vals[i] === A.vals[i]) || !inRegion((g.x0 + x + 0.5)/N, (g.y0 + y + 0.5)/N)) continue;
        cells.push(i); w.push(cw); km2 += cw;
      }
    }
    if(cells.length){ sets.push({A, cells, w, box:{a, b, c, d}}); ncell += cells.length; }
  }
  if(!ncell){
    host.innerHTML = '<p class="cap">No cells with data inside the region' + (hband ? ' and the height band' : '') +
      '. Draw a larger one, or one over land.</p>' + (wxLayer.id === 'thunder' ? thunderHours() : '');
    return;
  }
  const per = wxPeriods(sets);
  const s = seasonBins(), dr = dayRange(), bins = new Float64Array(s.months.length*s.parts);
  for(let b=0;b<bins.length;b++){
    const m = s.months[Math.floor(b/s.parts)], q = b % s.parts, Ld = MONTH_DAYS[m];
    let acc = 0, cnt = 0;
    for(let dd=Math.floor(q*Ld/s.parts)+1; dd<=Math.floor((q+1)*Ld/s.parts); dd++){
      if(dr && !inDays(dr, m*32 + dd)) continue;
      const p = 2*m + (dd > 15 ? 1 : 0), v = per[p];
      if(!(v === v)) continue;
      acc += wxCur.mean ? v : v/PERIOD_SLOTS[p]; cnt++;
    }
    bins[b] = cnt ? (wxCur.mean ? acc/cnt : acc) : NaN;
  }
  const unit = s.parts === 1 ? 'month' : s.parts === 2 ? 'half month' : 'quarter month';
  const svg = barChart(bins, 0, b=> b % s.parts === 0 ? MONTHS[s.months[b/s.parts]] : null,
    b=> seasonLabel(s, b), 'time of year', unit, {fmt:wxFmt, color:WX_BAR});
  const area = km2 >= 100 ? Math.round(km2).toLocaleString('en') : km2.toFixed(1);
  host.innerHTML = '<p class="cap"><b>' + wxFmt(wxTotal(per)) + '</b> ' + wxPhrase() +
    ', averaged over ' + ncell.toLocaleString('en') + ' cells, ' + area + ' km²' +
    (hband ? ' ' + hbandLabel(hband) : '') + '.</p>' + svg +
    '<p class="cap">By ' + unit + (wxCur.mean ? ', the mean' : ', per year') +
    ' over the years selected.</p>' + wxRegionYears(sets) +
    (wxLayer.id === 'thunder' ? thunderHours() : '');
}

/* ---------- the region, year by year ---------- */
/* The region's value in each selected year, from the per-year files. A year
   file the map is not drawing is fetched, cut down to the region's box and
   let go, so ten years of a layer never sit in memory at once. Files on
   this site (thunderstorm days, a few hundred kB) are fetched straight away;
   the climate files are 5–10 MB each, so those wait for the button. */
const wxCuts = new Map();     // url -> {box, file}: a year file cut down to a region's box
const wxByYear = new Set();   // layers whose by-year chart has been asked for
let wxCutRun = null;          // the urls being fetched, joined, while a fetch runs

function wxCut(f, box){
  const w = box.b - box.a + 1, h = box.d - box.c + 1, n = f.nx*f.ny, bands = {};
  for(const [id, B] of Object.entries(f.bands)){
    const out = new B.T(f.np*w*h);
    for(let p=0;p<f.np;p++) for(let y=0;y<h;y++){
      const o = p*n + (box.c + y)*f.nx + box.a;
      out.set(B.data.subarray(o, o + w), (p*h + y)*w);
    }
    bands[id] = Object.assign({}, B, {data:out});
  }
  return {L:f.L, year:f.year, x0:f.x0 + box.a, y0:f.y0 + box.c, nx:w, ny:h, np:f.np, bands};
}
const boxIn = (i, o)=> i.a >= o.a && i.b <= o.b && i.c >= o.c && i.d <= o.d;

/* The file and cell indices to use for one area set in one year, or null
   when the year has not been fetched. */
function wxYearCells(s, url){
  const full = wxParsed.get(url);
  if(full) return {files:[full], cells:s.cells, w:s.w};
  const cut = wxCuts.get(url);
  if(!cut || !boxIn(s.box, cut.box)) return null;
  const nx = s.A.area.nx, cb = cut.box, cw = cb.b - cb.a + 1;
  const cells = s.cells.map(i=> (Math.floor(i/nx) - cb.c)*cw + i % nx - cb.a);
  return {files:[cut.file], cells, w:s.w};
}

function wxRegionYears(sets){
  const keys = wxYearKeys(), years = keys[0] === '0' ? wx.years.map(String) : keys;
  if(years.length < 2) return '';
  const vals = new Float64Array(years.length).fill(NaN), need = [], unbuilt = [], part = [];
  years.forEach((y, j)=>{
    const parts = [];
    let have = 0;
    for(const s of sets){
      const url = (wxLayer.files[s.A.id] || {})[y];
      if(!url) continue;
      have++;
      const p = wxYearCells(s, url);
      if(p) parts.push(p); else need.push({url, box:s.box});
    }
    if(!have){ unbuilt.push(y); return; }
    if(parts.length < have) return;
    /* A year still being built has its later half-months empty, and its
       mean over the rest is not comparable with the other years. */
    const per = wxPeriods(parts), gaps = wxCur.wt.filter((w,p)=> w && !(per[p] === per[p])).length;
    if(gaps === wxCur.wt.filter(Boolean).length) unbuilt.push(y);
    else{ vals[j] = wxTotal(per); if(gaps) part.push(y); }
  });
  if(unbuilt.length === years.length) return '';
  if(need.length){
    if(need.every(n=> !/^https?:/.test(n.url)) || wxByYear.has(wxLayer.id)) wxCutFetch(need);
    else return '<p class="cap" style="margin-top:10px"><button class="btn" id="wxYearsGo">By year: load ' +
      need.length + ' files</button> A climate year file is 5–10 MB.</p>';
  }
  const svg = barChart(vals, 0, j=> years.length <= 12 || j % 2 === 0 ? years[j] : null,
    j=> years[j] + (unbuilt.includes(years[j]) ? ', not built yet' : part.includes(years[j]) ? ', part of it only' : ''),
    'by year', null, {fmt:wxFmt, color:WX_BAR, dim:j=> part.includes(years[j])});
  return svg + '<p class="cap">Each year on its own, ' +
    (wxCur.mean ? wxPhrase() : wxPartLabel() ? 'in ' + wxPartLabel() : 'the whole year') + '.' +
    (need.length ? ' <span id="wxYearStatus">Loading the years…</span>' : '') +
    (unbuilt.length ? ' No data yet for ' + unbuilt.join(', ') + '.' : '') +
    (part.length ? ' Faded: ' + part.join(', ') + ', with only part of the selection built so far.' : '') + '</p>';
}

async function wxCutFetch(need){
  const key = need.map(n=> n.url).join();
  if(wxCutRun === key) return;
  wxCutRun = key;
  for(const [j, n] of need.entries()){
    const st = document.getElementById('wxYearStatus');
    if(st) st.textContent = 'Loading year ' + (j+1) + ' of ' + need.length + '…';
    let f;
    try{ f = await wxGet(n.url); }
    catch(err){
      if(wxCutRun === key) wxCutRun = null;
      const s2 = document.getElementById('wxYearStatus');
      if(s2) s2.textContent = 'Could not load ' + n.url + ': ' + err.message;
      return;
    }
    if(wxCutRun !== key) return;
    wxCuts.set(n.url, {box:n.box, file:wxCut(f, n.box)});
  }
  wxCutRun = null;
  regionHours();
}
document.getElementById('regionChart').addEventListener('click', e=>{
  if(e.target.id === 'wxYearsGo'){ wxByYear.add(wxLayer.id); regionHours(); }
  if(e.target.id === 'thunderGo'){ strikesForGrid = true; syncYears(); regionHours(); }
});

/* ---------- switching layers ---------- */
async function wxBoot(){
  try{
    const r = await fetch(WX_INDEX_URL);
    if(!r.ok) throw new Error(r.status + ' ' + r.statusText);
    wx = await r.json();
  }catch(err){ wx = null; return; }
  const sel = document.getElementById('layer');
  for(const l of wx.layers){
    const o = document.createElement('option');
    o.value = l.id; o.textContent = l.label;
    sel.appendChild(o);
  }
}
function savedLayer(){
  try{ return localStorage.getItem(LAYER_KEY) || 'lightning'; }catch(e){ return 'lightning'; }
}

/* Lightning-only and grid-only parts of the panel say so with data-layers. */
function setLayer(id){
  const l = wx && wx.layers.find(l=> l.id === id) || null;
  if(wxLayer && wxLayer.attribution) map.attributionControl.removeAttribution(wxLayer.attribution);
  layerId = l ? id : 'lightning'; wxLayer = l; wxCur = null;
  try{ localStorage.setItem(LAYER_KEY, layerId); }catch(e){}
  document.getElementById('layer').value = layerId;
  /* A list of layer ids, where 'grid' means any grid layer. */
  document.querySelectorAll('[data-layers]').forEach(el=>{
    const ks = el.dataset.layers.split(' ');
    el.hidden = !ks.includes(layerId) && !(l && ks.includes('grid'));
  });
  map.closePopup();
  if(!l){
    if(map.hasLayer(wxCanvas)) map.removeLayer(wxCanvas);
    if(!map.hasLayer(strikes)) strikes.addTo(map);
    showLightning();
    return;
  }
  if(l.attribution) map.attributionControl.addAttribution(l.attribution);
  if(map.hasLayer(strikes)) map.removeLayer(strikes);
  if(!map.hasLayer(wxCanvas)) wxCanvas.addTo(map);
  wxUnfix();
  const bs = document.getElementById('wxBand');
  bs.innerHTML = '';
  for(const b of l.bands){
    const o = document.createElement('option');
    o.value = b.id; o.textContent = b.label + (b.unit ? ' (' + b.unit + ')' : '');
    bs.appendChild(o);
  }
  document.getElementById('wxTitle').textContent = l.label;
  document.getElementById('wxNote').textContent = l.note || '';
  document.getElementById('wxSource').textContent = 'Source: ' + l.source + '.';
  wxStatus.textContent = '';
  readout.textContent = 'Loading ' + l.label.toLowerCase() + '…';
  wxRefresh();
}

document.getElementById('layer').onchange = e=> setLayer(e.target.value);
/* A fixed scale belongs to one band: another band has other units. */
function wxUnfix(){
  const mn = document.getElementById('wxMin'), mx = document.getElementById('wxMax');
  document.getElementById('wxFix').checked = false;
  mn.value = mx.value = ''; mn.disabled = mx.disabled = true;
}
document.getElementById('wxBand').onchange = ()=>{ wxUnfix(); wxRefresh(); };
document.getElementById('wxOpacity').oninput = ()=> wxCanvas.redraw();
document.getElementById('wxFix').onchange = e=>{
  const on = e.target.checked, mn = document.getElementById('wxMin'), mx = document.getElementById('wxMax');
  mn.disabled = mx.disabled = !on;
  /* Start from the range on screen, so ticking the box freezes the look. */
  if(on && wxCanvas._hi >= wxCanvas._lo){
    if(!mn.value) mn.value = +wxRound(wxCanvas._lo);
    if(!mx.value) mx.value = +wxRound(wxCanvas._hi);
  }
  wxCanvas.redraw();
};
['wxMin','wxMax'].forEach(id=>{
  const el = document.getElementById(id);
  el.oninput = ()=>{ clearTimeout(el._t); el._t = setTimeout(()=> wxCanvas.redraw(), 300); };
});
