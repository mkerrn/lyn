/* Loading LYN1 files: parsing, unzipping, merging years, the year list. */

/* ---------------------------------------------------------------
   The manifest listing one file per year, written by split_years.py.
   Relative to this page, so on GitHub Pages the data/ folder sits
   next to index.html.
   --------------------------------------------------------------- */
const INDEX_URL = 'data/index.json';

/* ---------- the dataset ---------- */
/* Struct of arrays, sorted by time. Kept as typed arrays so a few
   hundred thousand strikes cost a few megabytes instead of a few
   hundred, and so a redraw is a tight numeric loop. */
let D = null;      // {n, t, lat, lon, peak, smaj, smin, ang, flag, wx, wy, t0}

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
  return {n, t, mon, lat, lon, peak, smaj, smin, ang, flag, wx, wy, t0:0};
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

/* Concatenating is a copy, but it happens once per selection change rather
   than once per frame, and it keeps every loop downstream working on one
   flat array. */
function merge(chunks){
  chunks = chunks.slice().sort((a,b)=> a.t[0] - b.t[0]);
  if(chunks.length === 1) return chunks[0];
  const n = chunks.reduce((s,c)=> s + c.n, 0);
  const out = {
    n, t0:0,
    t:new Uint32Array(n), mon:new Uint8Array(n), lat:new Int32Array(n), lon:new Int32Array(n),
    peak:new Int16Array(n), smaj:new Uint8Array(n), smin:new Uint8Array(n),
    ang:new Uint8Array(n), flag:new Uint8Array(n),
    wx:new Float64Array(n), wy:new Float64Array(n)
  };
  let o = 0;
  for(const c of chunks){
    for(const k of ['t','mon','lat','lon','peak','smaj','smin','ang','flag','wx','wy']) out[k].set(c[k], o);
    o += c.n;
  }
  return out;
}

function useChunks(chunks){
  if(!chunks.length){
    D = null; groups = []; filtered = 0;
    strikes.redraw();
    readout.textContent = 'No years selected';
    return;
  }
  D = merge(chunks);
  const a = new Date(D.t[0]*1000), b = new Date(D.t[D.n-1]*1000);
  const lo = a.toISOString().slice(0,10), hi = b.toISOString().slice(0,10);
  const from = document.getElementById('dFrom'), to = document.getElementById('dTo');
  from.min = to.min = lo; from.max = to.max = hi;
  if(!from.value || from.value < lo || from.value > hi) from.value = lo;
  if(!to.value   || to.value   < lo || to.value   > hi) to.value   = hi;
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

async function syncYears(){
  const boxes = [...yearsEl.querySelectorAll('input[type=checkbox]')];
  const want = boxes.filter(b=>b.checked).map(b=>b.value);
  const missing = want.filter(k=> !loaded.has(k));
  if(missing.length){
    dataStatus.textContent = 'Loading ' + missing.join(', ') + '…';
    for(const key of missing){
      const entry = manifest.files.find(f=> String(f.year) === key);
      try{
        const r = await fetch(entry.file);
        if(!r.ok) throw new Error(r.status + ' ' + r.statusText);
        const buf = await maybeGunzip(await r.arrayBuffer());
        loaded.set(key, parseBin(buf));
      }catch(err){
        dataStatus.textContent = 'Could not load ' + entry.file + ': ' + err.message;
        boxes.find(b=>b.value===key).checked = false;
        return;
      }
    }
  }
  const chunks = want.map(k=> loaded.get(k));
  const n = chunks.reduce((s,c)=> s + c.n, 0);
  dataStatus.textContent = want.length
    ? want.length + (want.length===1 ? ' year, ' : ' years, ') + n.toLocaleString('en') + ' strikes in memory.'
    : 'No years selected.';
  useChunks(chunks);
}

function buildYearList(){
  yearsEl.innerHTML = '';
  manifest.files.forEach((f,idx)=>{
    const row = document.createElement('div');
    row.className = 'row';
    const id = 'y'+f.year;
    row.innerHTML = '<input type="checkbox" id="'+id+'" value="'+f.year+'"'+
      (idx === manifest.files.length-1 ? ' checked' : '')+'>' +
      '<label for="'+id+'">'+f.year+'</label>' +
      '<span style="color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums">'+
      (f.n/1000).toFixed(0)+'k · '+(f.bytes/1e6).toFixed(0)+' MB</span>';
    row.querySelector('input').onchange = syncYears;
    yearsEl.appendChild(row);
  });
}


document.getElementById('dataFile').onchange = async e=>{
  const f = e.target.files[0];
  if(!f) return;
  dataStatus.textContent = 'Reading ' + f.name + '…';
  try{
    const buf = await maybeGunzip(await f.arrayBuffer());
    loaded.set(f.name, parseBin(buf));
    yearsEl.querySelectorAll('input[type=checkbox]').forEach(b=> b.checked = false);
    const c = loaded.get(f.name);
    dataStatus.textContent = f.name + ': ' + c.n.toLocaleString('en') + ' strikes.';
    useChunks([c]);
  }catch(err){ dataStatus.textContent = 'Could not read that file: ' + err.message; }
};
