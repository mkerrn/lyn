/* Loading LYN1 files: parsing, unzipping, merging years, the year list. */

/* ---------------------------------------------------------------
   The manifest listing one file per year, written by split_years.py.
   Relative to this page, so on GitHub Pages the data/ folder sits
   next to index.html.
   --------------------------------------------------------------- */
const INDEX_URL = 'data/index.json';

/* ---------- the dataset ---------- */
/* Struct of arrays. Each file is sorted by time; the merged set in D is
   sorted by map tile instead, see merge(). Kept as typed arrays so a few
   hundred thousand strikes cost a few megabytes instead of a few
   hundred, and so a redraw is a tight numeric loop. */
let D = null;      // {n, t, lat, lon, peak, smaj, smin, ang, flag, wx, wy, t0, tiles}

/* Timestamps inside a file are seconds from that file's own epoch. On the
   way in they become absolute unix seconds, so chunks from different years
   can be concatenated without touching the time column again. */
function parseBin(buf){
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0),dv.getUint8(1),dv.getUint8(2),dv.getUint8(3));
  if(magic !== 'LYN1') throw new Error('not a LYN1 file');
  const n  = dv.getUint32(4, true);
  const t0 = dv.getUint32(8, true);
  let o = 32;
  const t    = new Uint32Array(buf, o, n); o += 4*n;
  const lat  = new Int32Array (buf, o, n); o += 4*n;
  const lon  = new Int32Array (buf, o, n); o += 4*n;
  const peak = new Int16Array (buf, o, n); o += 2*n;
  const smaj = new Uint8Array (buf, o, n); o += n;
  const smin = new Uint8Array (buf, o, n); o += n;
  const ang  = new Uint8Array (buf, o, n); o += n;
  const flag = new Uint8Array (buf, o, n); o += n;
  for(let i=0;i<n;i++) t[i] += t0;

  /* Which month each strike falls in, worked out by walking month boundaries
     through the sorted time column rather than making n Date objects. */
  const mon = new Uint8Array(n);
  if(n){
    const d0 = new Date(t[0]*1000);
    let y = d0.getUTCFullYear(), m = d0.getUTCMonth(), i = 0;
    while(i < n){
      const end = Date.UTC(y, m+1, 1)/1000;
      while(i < n && t[i] < end){ mon[i] = m; i++; }
      if(++m > 11){ m = 0; y++; }
    }
  }

  /* Day of the year as month*32 + day, for the day-range filter. Comparing
     these keys orders dates within a year and ignores leap days, so 15/8 is
     the same key every year. Walked day by day like the months above. */
  const md = new Uint16Array(n);
  if(n){
    let day = Math.floor(t[0]/86400)*86400, i = 0;
    while(i < n){
      const d = new Date(day*1000), key = d.getUTCMonth()*32 + d.getUTCDate(), end = day + 86400;
      while(i < n && t[i] < end){ md[i] = key; i++; }
      day = end;
    }
  }

  /* Project once, here, into normalised web mercator (0–1 across the
     world). A redraw is then one multiply and one subtract per strike
     instead of a trigonometric projection. */
  const wx = new Float64Array(n), wy = new Float64Array(n);
  for(let i=0;i<n;i++){
    const la = lat[i]/1e5, lo = lon[i]/1e5;
    const s = Math.sin(la*Math.PI/180);
    wx[i] = (lo+180)/360;
    wy[i] = 0.5 - Math.log((1+s)/(1-s))/(4*Math.PI);
  }
  return {n, t, mon, md, lat, lon, peak, smaj, smin, ang, flag, wx, wy, t0:0};
}

async function gunzip(buf){
  if(typeof DecompressionStream === 'undefined')
    throw new Error('this browser cannot unzip; use the uncompressed .bin');
  const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(s).arrayBuffer();
}

/* Decide from the first two bytes, not the file name. Some servers send a
   .gz with Content-Encoding: gzip and the browser has already unwrapped it
   by the time we look; others hand over the raw gzip stream. Either way the
   magic number says which one happened. */
async function maybeGunzip(buf){
  const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if(head[0] === 0x1f && head[1] === 0x8b) return await gunzip(buf);
  return buf;
}

const dataStatus = document.getElementById('dataStatus');
const yearsEl = document.getElementById('years');
const loaded = new Map();     // key -> parsed chunk, kept so reselecting is free
let manifest = null;
let firstFit = true;

/* Map tiles for the spatial index: level 12 is about 4 km across at 65°N,
   a few dozen pixels at the zooms where it matters. */
const TILE_LEVEL = 12;
const COLUMNS = ['t','mon','md','lat','lon','peak','smaj','smin','ang','flag','wx','wy'];

/* Concatenates the chosen years and sorts the result by map tile, rows of
   tiles north to south, so the strikes in any one tile are a contiguous run
   of indices. A draw then reads only the tiles in view instead of scanning
   every strike. Within a tile the order stays by time. The loaded chunks
   themselves are left in time order; this is a copy, made once per
   selection change. D.tiles.start[t] is the first index in tile t. */
function merge(chunks){
  chunks = chunks.slice().sort((a,b)=> a.t[0] - b.t[0]);
  const n = chunks.reduce((s,c)=> s + c.n, 0);

  let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
  for(const c of chunks) for(let i=0;i<c.n;i++){
    const x = c.wx[i], y = c.wy[i];
    if(x < x0) x0 = x; if(x > x1) x1 = x; if(y < y0) y0 = y; if(y > y1) y1 = y;
  }
  if(!n) x0 = x1 = y0 = y1 = 0.5;
  /* A stray strike far outside the network would stretch the box; coarser
     tiles keep the table to a couple of million entries whatever happens. */
  let L = TILE_LEVEL, N, tx0, ty0, ntx, nty;
  for(;;){
    N = Math.pow(2, L);
    tx0 = Math.floor(x0*N); ty0 = Math.floor(y0*N);
    ntx = Math.min(N-1, Math.floor(x1*N)) - tx0 + 1;
    nty = Math.min(N-1, Math.floor(y1*N)) - ty0 + 1;
    if(ntx*nty <= 1<<21 || L === 0) break;
    L--;
  }

  /* Counting sort: tile of every strike, then where each one goes. */
  const nt = ntx*nty, start = new Int32Array(nt+1), dest = new Int32Array(n);
  let o = 0;
  for(const c of chunks) for(let i=0;i<c.n;i++){
    const tx = Math.min(ntx-1, Math.floor(c.wx[i]*N) - tx0);
    const ty = Math.min(nty-1, Math.floor(c.wy[i]*N) - ty0);
    const t = ty*ntx + tx;
    dest[o++] = t; start[t+1]++;
  }
  for(let t=0;t<nt;t++) start[t+1] += start[t];
  const next = start.slice(0, nt);
  for(let j=0;j<n;j++) dest[j] = next[dest[j]]++;

  const out = {n, t0:0, tiles:{L, tx0, ty0, ntx, nty, start}};
  for(const k of COLUMNS){
    const col = out[k] = new chunks[0][k].constructor(n);
    let o = 0;
    for(const c of chunks){ scatter(col, c[k], dest, o); o += c.n; }
  }
  return out;
}

/* out[dest[o+i]] = src[i], through a view of the right width. One loop
   per element size, because a single loop fed twelve kinds of typed array
   is one the JIT gives up on, and runs many times slower. */
function scatter(out, src, dest, o){
  const w = src.BYTES_PER_ELEMENT;
  if(w === 8) scatter64(out, src, dest, o);
  else if(w === 4) scatter32(new Uint32Array(out.buffer), new Uint32Array(src.buffer, src.byteOffset, src.length), dest, o);
  else if(w === 2) scatter16(new Uint16Array(out.buffer), new Uint16Array(src.buffer, src.byteOffset, src.length), dest, o);
  else scatter8(new Uint8Array(out.buffer), new Uint8Array(src.buffer, src.byteOffset, src.length), dest, o);
}
function scatter64(out, src, dest, o){ for(let i=0;i<src.length;i++) out[dest[o+i]] = src[i]; }
function scatter32(out, src, dest, o){ for(let i=0;i<src.length;i++) out[dest[o+i]] = src[i]; }
function scatter16(out, src, dest, o){ for(let i=0;i<src.length;i++) out[dest[o+i]] = src[i]; }
function scatter8 (out, src, dest, o){ for(let i=0;i<src.length;i++) out[dest[o+i]] = src[i]; }

function useChunks(chunks){
  if(!chunks.length){
    D = null; groups = []; groupTiles = []; filtered = 0;
    strikes.redraw();
    readout.textContent = 'No years selected';
    return;
  }
  D = merge(chunks);
  refilter();
  if(firstFit){
    firstFit = false;
    let mnLa=90, mxLa=-90, mnLo=180, mxLo=-180;
    const step = Math.max(1, Math.floor(D.n/20000));
    for(let i=0;i<D.n;i+=step){
      const la=D.lat[i]/1e5, lo2=D.lon[i]/1e5;
      if(la<mnLa)mnLa=la; if(la>mxLa)mxLa=la; if(lo2<mnLo)mnLo=lo2; if(lo2>mxLo)mxLo=lo2;
    }
    if(mnLa<=mxLa) map.fitBounds([[mnLa-0.3,mnLo-0.3],[mxLa+0.3,mxLo+0.3]]);
  }
}

/* Which years are switched on, as manifest year strings. */
const yearOn = new Set();

/* A selection change can arrive while an earlier one is still downloading.
   Only the newest call gets to hand its chunks over. */
let syncSeq = 0;
const wantedYears = ()=> manifest.files.map(f=> String(f.year)).filter(k=> yearOn.has(k));
/* The years merged into D, or null for a file opened by hand, so coming back
   to lightning from a grid layer only merges again if they have changed. */
let mergedKey = null;
async function syncYears(){
  if(!isLightning()){ wxRefresh(); return; }
  const seq = ++syncSeq;
  const want = wantedYears();
  const missing = want.filter(k=> !loaded.has(k));
  if(missing.length){
    for(const [j,key] of missing.entries()){
      if(loaded.has(key)) continue;
      dataStatus.textContent = 'Loading ' + key + (missing.length > 1 ? ' (' + (j+1) + ' of ' + missing.length + ')' : '') + '…';
      const entry = manifest.files.find(f=> String(f.year) === key);
      try{
        const r = await fetch(entry.file);
        if(!r.ok) throw new Error(r.status + ' ' + r.statusText);
        const buf = await maybeGunzip(await r.arrayBuffer());
        loaded.set(key, parseBin(buf));
      }catch(err){
        dataStatus.textContent = 'Could not load ' + entry.file + ': ' + err.message;
        yearOn.delete(key); renderYears();
        return;
      }
      if(seq !== syncSeq) return;
    }
  }
  if(seq !== syncSeq) return;
  const chunks = want.map(k=> loaded.get(k));
  const n = chunks.reduce((s,c)=> s + c.n, 0);
  dataStatus.textContent = want.length
    ? want.length + (want.length===1 ? ' year, ' : ' years, ') + n.toLocaleString('en') + ' strikes in memory.'
    : 'No years selected.';
  mergedKey = want.join();
  useChunks(chunks);
}

function showLightning(){
  if(D && (mergedKey === null ? !yearOn.size : mergedKey === wantedYears().join())) refilter();
  else if(manifest) syncYears();
  else updateReadout(0, 1);
}

function renderYears(){
  yearsEl.querySelectorAll('button').forEach(b=> b.classList.toggle('off', !yearOn.has(b.value)));
}
function setYears(keys){
  yearOn.clear(); keys.forEach(k=> yearOn.add(String(k)));
  renderYears(); syncYears();
}

/* Press on a year to flip it, then drag across others to give them the
   same state. Hit-testing the pointer position rather than listening on
   each button makes the drag work with a finger as well as a mouse. */
function buildYearList(){
  yearsEl.innerHTML = '';
  manifest.files.forEach(f=>{
    const b = document.createElement('button');
    b.value = String(f.year);
    b.textContent = f.year;
    b.title = (f.n/1000).toFixed(0)+'k strikes · '+(f.bytes/1e6).toFixed(0)+' MB';
    yearsEl.appendChild(b);
    yearOn.add(b.value);
  });
  renderYears();

  let drag = null;   // the state being painted, while the pointer is down
  const hit = e=>{
    const el = document.elementFromPoint(e.clientX, e.clientY);
    return el && el.parentNode === yearsEl ? el : null;
  };
  const paint = b=>{
    if(!b || yearOn.has(b.value) === drag) return;
    if(drag) yearOn.add(b.value); else yearOn.delete(b.value);
    renderYears();
  };
  yearsEl.onpointerdown = e=>{
    const b = hit(e);
    if(!b) return;
    e.preventDefault();
    drag = !yearOn.has(b.value);
    yearsEl.setPointerCapture(e.pointerId);
    paint(b);
  };
  yearsEl.onpointermove = e=>{ if(drag !== null) paint(hit(e)); };
  yearsEl.onpointerup = yearsEl.onpointercancel = ()=>{
    if(drag === null) return;
    drag = null;
    syncYears();
  };
}
const yearKeys = ()=> manifest ? manifest.files.map(f=> f.year) : [];
document.getElementById('yAll').onclick  = ()=> manifest && setYears(yearKeys());
document.getElementById('yNone').onclick = ()=> manifest && setYears([]);
document.getElementById('yLast').onclick = ()=> manifest && setYears(yearKeys().slice(-1));


document.getElementById('dataFile').onchange = async e=>{
  const f = e.target.files[0];
  if(!f) return;
  dataStatus.textContent = 'Reading ' + f.name + '…';
  try{
    const buf = await maybeGunzip(await f.arrayBuffer());
    loaded.set(f.name, parseBin(buf));
    yearOn.clear(); if(manifest) renderYears();
    syncSeq++; mergedKey = null;
    const c = loaded.get(f.name);
    dataStatus.textContent = f.name + ': ' + c.n.toLocaleString('en') + ' strikes.';
    useChunks([c]);
  }catch(err){ dataStatus.textContent = 'Could not read that file: ' + err.message; }
};
