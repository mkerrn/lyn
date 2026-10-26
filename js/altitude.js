/* Altitude shading from elevation tiles, and the strikes-by-height chart. */

/* ---------- altitude shading from terrarium elevation tiles ---------- */
/* Same tiles the ski map uses for slope, read as heights instead. The ramp is
   blue through green to pale mint: nothing in it competes with the warm strike
   palette, and sea is left transparent so the fjords still read. */
const ALT_STOPS = [
  [0.00, [ 11, 28, 44]],
  [0.25, [ 34, 80,110]],
  [0.50, [ 47,143,138]],
  [0.75, [127,196,160]],
  [1.00, [227,242,231]]
];
const ALT_LUT = (()=>{
  const lut = new Uint8Array(256*3);
  for(let i=0;i<256;i++){
    const t = i/255;
    let a = ALT_STOPS[0], b = ALT_STOPS[ALT_STOPS.length-1];
    for(let j=0;j<ALT_STOPS.length-1;j++){
      if(t >= ALT_STOPS[j][0] && t <= ALT_STOPS[j+1][0]){ a = ALT_STOPS[j]; b = ALT_STOPS[j+1]; break; }
    }
    const f = (b[0] - a[0]) ? (t - a[0])/(b[0] - a[0]) : 0;
    for(let c=0;c<3;c++) lut[i*3+c] = Math.round(a[1][c] + f*(b[1][c] - a[1][c]));
  }
  return lut;
})();

const DEM_MAX_Z = 13;
const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const elevCache = new Map();

function loadElev(z,x,y){
  const key = z+'/'+x+'/'+y;
  if(elevCache.has(key)) return Promise.resolve(elevCache.get(key));
  const p = new Promise((resolve,reject)=>{
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = ()=>{
      const c = document.createElement('canvas'); c.width = c.height = 256;
      const cx = c.getContext('2d', {willReadFrequently:true});
      cx.drawImage(img,0,0,256,256);
      let d;
      try { d = cx.getImageData(0,0,256,256).data; }
      catch(err){ reject(err); return; }
      const el = new Float32Array(256*256);
      for(let i=0;i<256*256;i++) el[i] = (d[i*4]*256 + d[i*4+1] + d[i*4+2]/256) - 32768;
      elevCache.set(key, el);
      resolve(el);
    };
    img.onerror = ()=> reject(new Error('elevation tile failed'));
    img.src = DEM_URL.replace('{z}',z).replace('{x}',x).replace('{y}',y);
  });
  elevCache.set(key, p);
  return p;
}

const AltLayer = L.GridLayer.extend({
  initialize: function(opts){
    L.setOptions(this, opts);
    this._data = new Map();
    this.on('tileunload', e=>{
      this._data.delete(e.coords.z+'/'+e.coords.x+'/'+e.coords.y);
      this._schedule();
    });
  },
  onAdd: function(map){
    L.GridLayer.prototype.onAdd.call(this, map);
    map.on('moveend', this._schedule, this);
  },
  onRemove: function(map){
    map.off('moveend', this._schedule, this);
    L.GridLayer.prototype.onRemove.call(this, map);
    this._data.clear();
  },
  createTile: function(coords, done){
    const tile = document.createElement('canvas');
    tile.width = tile.height = 256;
    const dz = Math.max(0, coords.z - DEM_MAX_Z);
    const pz = coords.z - dz, px = coords.x >> dz, py = coords.y >> dz;
    const sw = 256/Math.pow(2,dz);
    const sx = (coords.x - (px<<dz))*sw, sy = (coords.y - (py<<dz))*sw;
    loadElev(pz,px,py).then(el=>{
      this._data.set(coords.z+'/'+coords.x+'/'+coords.y, {el, sx, sy, sw, tile, coords, pz, px, py});
      this._schedule();
      done(null, tile);
    }).catch(()=> done(null, tile));
    return tile;
  },

  _schedule: function(){
    if(this._pending) return;
    this._pending = requestAnimationFrame(()=>{ this._pending = null; this.rescale(); });
  },

  /* The range is taken from the tiles actually on screen, so the ramp
     restretches as you pan — the same behaviour as topographic-map.com. Sea
     is excluded from the range, otherwise bathymetry would flatten the land
     into the top few percent of the ramp. */
  rescale: function(){
    const fixed = document.getElementById('altFix').checked;
    let lo, hi;
    if(fixed){
      lo = parseFloat(document.getElementById('altMin').value);
      hi = parseFloat(document.getElementById('altMax').value);
      if(isNaN(lo) || isNaN(hi) || hi <= lo){ lo = 0; hi = 2000; }
    }else{
      lo = Infinity; hi = -Infinity;
      for(const d of this._data.values()){
        const x1 = Math.ceil(d.sx + d.sw), y1 = Math.ceil(d.sy + d.sw);
        for(let y=Math.floor(d.sy); y<y1; y+=2){
          for(let x=Math.floor(d.sx); x<x1; x+=2){
            const v = d.el[y*256+x];
            if(v < -0.5) continue;
            if(v < lo) lo = v;
            if(v > hi) hi = v;
          }
        }
      }
      if(!isFinite(lo) || !isFinite(hi)){ lo = 0; hi = 1; }
      if(hi - lo < 10) hi = lo + 10;
    }
    this._lo = lo; this._hi = hi;
    document.getElementById('altLo').textContent = Math.round(lo) + ' m';
    document.getElementById('altHi').textContent = Math.round(hi) + ' m';
    if(!fixed){
      document.getElementById('altMin').placeholder = Math.round(lo);
      document.getElementById('altMax').placeholder = Math.round(hi);
    }
    for(const d of this._data.values()) this._paint(d);
  },

  _paint: function(d){
    const lo = this._lo, span = this._hi - this._lo;
    const work = document.createElement('canvas'); work.width = work.height = 256;
    const wc = work.getContext('2d');
    const img = wc.createImageData(256,256);
    const out = img.data, el = d.el;
    for(let i=0;i<256*256;i++){
      const v = el[i];
      if(v < -0.5) continue;                    // sea stays clear
      let t = (v - lo)/span;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const k = (t*255)|0;
      out[i*4]   = ALT_LUT[k*3];
      out[i*4+1] = ALT_LUT[k*3+1];
      out[i*4+2] = ALT_LUT[k*3+2];
      out[i*4+3] = 255;
    }
    wc.putImageData(img,0,0);
    const ctx = d.tile.getContext('2d');
    ctx.clearRect(0,0,256,256);
    ctx.imageSmoothingEnabled = d.sw < 256;
    ctx.drawImage(work, d.sx, d.sy, d.sw, d.sw, 0, 0, 256, 256);
  }
});
const alt = new AltLayer({maxZoom:18, opacity:0.6, tileSize:256});

document.getElementById('altOn').onchange = e=>{
  if(e.target.checked) alt.addTo(map); else map.removeLayer(alt);
};
document.getElementById('altOpacity').oninput = e=> alt.setOpacity(e.target.value/100);
document.getElementById('altFix').onchange = e=>{
  const on = e.target.checked;
  document.getElementById('altMin').disabled = !on;
  document.getElementById('altMax').disabled = !on;
  if(on){
    /* Start the fixed range from whatever is on screen right now, so ticking
       the box freezes the current look instead of jumping somewhere else. */
    if(alt._lo !== undefined){
      if(!document.getElementById('altMin').value) document.getElementById('altMin').value = Math.round(alt._lo);
      if(!document.getElementById('altMax').value) document.getElementById('altMax').value = Math.round(alt._hi);
    }
  }
  alt.rescale();
};
['altMin','altMax'].forEach(id=>{
  const el = document.getElementById(id);
  el.oninput = ()=>{ clearTimeout(el._t); el._t = setTimeout(()=> alt.rescale(), 300); };
});

/* ---------- strikes per unit area, by height ---------- */
/* The question "does it strike summits more" cannot be answered by looking at
   dots, because there is far more low ground than high ground. This bins the
   elevation pixels on screen to get area per height band, bins the strikes the
   same way, and divides. A rising curve means height matters. */
const ELEV_BIN = 100;      // metres
const ELEV_MAXB = 30;      // up to 3000 m

function elevationResponse(){
  const host = document.getElementById('elevChart');
  if(!map.hasLayer(alt) || !alt._data.size){
    host.innerHTML = '<p class="cap">Turn on the altitude layer first and let the tiles load — this reads the same elevation data.</p>';
    return;
  }
  if(!D){ host.innerHTML = '<p class="cap">No strikes loaded.</p>'; return; }

  const z = map.getZoom(), S = 256*Math.pow(2,z);
  const origin = map.getPixelOrigin(), topLeft = map.containerPointToLayerPoint([0,0]);
  const ox = origin.x + topLeft.x, oy = origin.y + topLeft.y;
  const size = map.getSize();

  const areaKm2 = new Float64Array(ELEV_MAXB);
  const hits = new Float64Array(ELEV_MAXB);

  /* area per band, from the elevation pixels of the tiles on screen */
  for(const d of alt._data.values()){
    const tx = d.coords.x*256 - ox, ty = d.coords.y*256 - oy;
    if(tx > size.x || ty > size.y || tx + 256 < 0 || ty + 256 < 0) continue;
    const n = Math.PI - 2*Math.PI*(d.py+0.5)/Math.pow(2,d.pz);
    const lat = Math.atan(0.5*(Math.exp(n)-Math.exp(-n)));
    const mpp = 156543.03392*Math.cos(lat)/Math.pow(2,d.pz);
    const pxKm2 = (mpp*mpp)/1e6;
    const x1 = Math.ceil(d.sx + d.sw), y1 = Math.ceil(d.sy + d.sw);
    for(let y=Math.floor(d.sy); y<y1; y++){
      for(let x=Math.floor(d.sx); x<x1; x++){
        const v = d.el[y*256+x];
        if(v < -0.5) continue;
        const b = Math.min(ELEV_MAXB-1, Math.floor(v/ELEV_BIN));
        areaKm2[b] += pxKm2;
      }
    }
  }

  /* strikes per band, looked up in the same elevation tiles */
  const pz = Math.min(z, DEM_MAX_Z), PS = 256*Math.pow(2,pz);
  let counted = 0;
  for(let k=0;k<NCLASS;k++){
    const g = groups[k]; if(!g) continue;
    for(let j=0;j<g.length;j++){
      const i = g[j];
      const sx = D.wx[i]*S - ox; if(sx < 0 || sx > size.x) continue;
      const sy = D.wy[i]*S - oy; if(sy < 0 || sy > size.y) continue;
      const X = D.wx[i]*PS, Y = D.wy[i]*PS;
      const el = elevCache.get(pz+'/'+Math.floor(X/256)+'/'+Math.floor(Y/256));
      if(!(el instanceof Float32Array)) continue;
      const v = el[(Math.floor(Y)&255)*256 + (Math.floor(X)&255)];
      if(v < -0.5) continue;
      hits[Math.min(ELEV_MAXB-1, Math.floor(v/ELEV_BIN))]++;
      counted++;
    }
  }

  let lastB = 0, totalArea = 0, best = 0;
  const dens = new Float64Array(ELEV_MAXB);
  for(let b=0;b<ELEV_MAXB;b++){
    totalArea += areaKm2[b];
    if(areaKm2[b] < 1) continue;            // too little land to mean anything
    dens[b] = hits[b]/areaKm2[b]*1000;   // strikes per 1000 km²
    if(dens[b] > best) best = dens[b];
    lastB = b;
  }
  if(!counted || !best){
    host.innerHTML = '<p class="cap">No strikes over land in this view, with the current filters.</p>';
    return;
  }

  const rowH = 9, pad = 34, w = 260;
  const h = (lastB+1)*rowH + 14;
  let svg = '<svg viewBox="0 0 '+w+' '+h+'" xmlns="http://www.w3.org/2000/svg">';
  for(let b=lastB;b>=0;b--){
    const y = (lastB-b)*rowH;
    const bw = areaKm2[b] < 1 ? 0 : (dens[b]/best)*(w-pad-4);
    svg += '<rect x="'+pad+'" y="'+y+'" width="'+bw.toFixed(1)+'" height="'+(rowH-2)+'" fill="#e2652f" opacity="0.85"/>';
    if(b % 5 === 0)
      svg += '<text x="'+(pad-4)+'" y="'+(y+rowH-3)+'" text-anchor="end" font-size="8" fill="#93aab5">'+(b*ELEV_BIN)+'</text>';
  }
  svg += '<line x1="'+pad+'" y1="0" x2="'+pad+'" y2="'+((lastB+1)*rowH)+'" stroke="#2e4a58"/>';
  svg += '<text x="'+pad+'" y="'+(h-3)+'" font-size="8" fill="#93aab5">0</text>';
  svg += '<text x="'+(w-2)+'" y="'+(h-3)+'" text-anchor="end" font-size="8" fill="#93aab5">'+
         Math.round(best).toLocaleString('en')+' per 1000 km²</text>';
  svg += '</svg>';

  host.innerHTML = svg +
    '<p class="cap">Metres above sea level on the left. ' + counted.toLocaleString('en') +
    ' strikes over ' + Math.round(totalArea).toLocaleString('en') + ' km² of land in view' +
    '. Bands with under 1 km² of land are left blank.</p>';
}
document.getElementById('elevRun').onclick = elevationResponse;
