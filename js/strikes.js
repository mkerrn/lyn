/* The canvas strike layer: points, ellipses, density grid, per-view sampling. */

/* ---------- density pyramid ---------- */
/* A fixed grid in web mercator, power-of-two cells like map tiles, so a
   cell stays put when you pan. Level 14 is about 1 km across at 65°N.
   Every strike in the filter is counted once into the finest level when
   the filter changes, and each coarser level adds up 2×2 cells of the one
   below; a draw only reads cells. Mercator cells shrink towards the pole,
   so each row keeps its true area in km² and densities are divided by it. */
const DENS_FINE = 14, DENS_COARSE = 4;
const EARTH_KM = 40075.016686;
const REF_COS = Math.cos(65*Math.PI/180);
let pyramid = null, pyramidGen = -1;

function cellLabel(L){
  return '≈ ' + Math.round(EARTH_KM*REF_COS/Math.pow(2, L)) + ' km';
}

function densityPyramid(){
  if(pyramid && pyramidGen === filterGen) return pyramid;
  const T = D.tiles;
  let L = DENS_FINE, f, nx, ny;
  for(;;){
    f = L - T.L; nx = T.ntx << f; ny = T.nty << f;
    if(nx*ny <= 1<<23 || L === T.L) break;
    L--;
  }
  const N = Math.pow(2, L), cx0 = T.tx0 << f, cy0 = T.ty0 << f;
  const grid = new Int32Array(nx*ny), wx = D.wx, wy = D.wy;
  for(let k=0;k<NCLASS;k++){
    const g = groups[k]; if(!g) continue;
    for(let j=0;j<g.length;j++){
      const i = g[j];
      const cx = Math.min(nx-1, Math.max(0, Math.floor(wx[i]*N) - cx0));
      const cy = Math.min(ny-1, Math.max(0, Math.floor(wy[i]*N) - cy0));
      grid[cy*nx + cx]++;
    }
  }
  const levels = [];
  let lv = {cx0, cy0, nx, ny, grid};
  for(let l=L;;l--){
    finishLevel(lv, l);
    levels[l] = lv;
    if(l <= DENS_COARSE) break;
    const px0 = lv.cx0 >> 1, py0 = lv.cy0 >> 1;
    const pnx = ((lv.cx0 + lv.nx - 1) >> 1) - px0 + 1, pny = ((lv.cy0 + lv.ny - 1) >> 1) - py0 + 1;
    const pg = new Int32Array(pnx*pny);
    for(let y=0;y<lv.ny;y++){
      const row = (((lv.cy0 + y) >> 1) - py0)*pnx - px0;
      for(let x=0;x<lv.nx;x++){
        const v = lv.grid[y*lv.nx + x];
        if(v) pg[row + ((lv.cx0 + x) >> 1)] += v;
      }
    }
    lv = {cx0:px0, cy0:py0, nx:pnx, ny:pny, grid:pg};
  }
  pyramid = {levels, max:L, min:Math.min(L, DENS_COARSE)};
  pyramidGen = filterGen;
  return pyramid;
}

/* Area of each row in km², the reference area at 65°N, and the busiest
   cell anywhere, for the fixed colour scale. */
function finishLevel(lv, L){
  const N = Math.pow(2, L), side = EARTH_KM/N;
  lv.ref = Math.pow(side*REF_COS, 2);
  lv.area = new Float64Array(lv.ny);
  let hi = 0;
  for(let y=0;y<lv.ny;y++){
    const lat = Math.atan(Math.sinh(Math.PI*(1 - 2*(lv.cy0 + y + 0.5)/N)));
    lv.area[y] = Math.pow(side*Math.cos(lat), 2);
    const f = lv.ref/lv.area[y], row = y*lv.nx;
    for(let x=0;x<lv.nx;x++){ const v = lv.grid[row+x]*f; if(v > hi) hi = v; }
  }
  lv.hi = hi;
}

/* '#rrggbb' or 'rgb(r,g,b)' as the low 24 bits of a little-endian RGBA
   pixel, ready to have an alpha byte put on top. */
function rgbOf(css){
  let r, g, b;
  if(css[0] === '#'){
    r = parseInt(css.slice(1,3),16); g = parseInt(css.slice(3,5),16); b = parseInt(css.slice(5,7),16);
  }else [r, g, b] = css.match(/\d+/g).map(Number);
  return (b<<16) | (g<<8) | r;
}

/* ---------- the strike layer ---------- */
/* One canvas over the map pane. Leaflet's own vector layers make a DOM
   object per feature and fall over somewhere around ten thousand; this
   draws straight to a bitmap, so the cost is the loop, not the DOM. */
const StrikeLayer = L.Layer.extend({
  onAdd: function(map){
    this._map = map;
    const c = this._canvas = L.DomUtil.create('canvas', 'leaflet-zoom-animated');
    c.style.pointerEvents = 'none';
    map.getPanes().overlayPane.appendChild(c);
    map.on('moveend zoomend resize', this._reset, this);
    if(map.options.zoomAnimation && L.Browser.any3d) map.on('zoomanim', this._animateZoom, this);
    this._reset();
  },
  onRemove: function(map){
    L.DomUtil.remove(this._canvas);
    map.off('moveend zoomend resize', this._reset, this);
    map.off('zoomanim', this._animateZoom, this);
  },
  _animateZoom: function(e){
    const scale = this._map.getZoomScale(e.zoom);
    const off = this._map._latLngBoundsToNewLayerBounds(this._map.getBounds(), e.zoom, e.center).min;
    L.DomUtil.setTransform(this._canvas, off, scale);
  },
  _reset: function(){
    const m = this._map, size = m.getSize(), c = this._canvas;
    const dpr = window.devicePixelRatio || 1;
    L.DomUtil.setTransform(this._canvas, L.point(0,0), 1);
    L.DomUtil.setPosition(c, m.containerPointToLayerPoint([0,0]));
    if(c.width !== Math.round(size.x*dpr) || c.height !== Math.round(size.y*dpr)){
      c.width = Math.round(size.x*dpr); c.height = Math.round(size.y*dpr);
      c.style.width = size.x+'px'; c.style.height = size.y+'px';
    }
    this.redraw();
  },
  redraw: function(){
    if(!this._canvas) return;
    if(this._frame) return;
    this._frame = requestAnimationFrame(()=>{ this._frame = null; this._draw(); });
  },
  /* Draws one level of the density pyramid: only the cells in view are
     read, so panning costs nothing like a pass over the strikes. Each cell
     becomes one pixel of a small image that is scaled up unsmoothed, rather
     than a rectangle of its own. Returns the level used and how many
     strikes fall in the cells on screen. */
  _drawDensity: function(ctx, S, ox, oy, W, H, alpha){
    const P = densityPyramid();
    const want = +document.getElementById('densCell').value;
    const L = Math.max(P.min, Math.min(want, P.max, Math.floor(Math.log2(S) + 1e-9)));  // a cell at least a pixel across
    const lv = P.levels[L], px = S/Math.pow(2, L);
    const a = Math.max(0, Math.floor(ox/px) - lv.cx0), b = Math.min(lv.nx-1, Math.floor((ox+W)/px) - lv.cx0);
    const c = Math.max(0, Math.floor(oy/px) - lv.cy0), d = Math.min(lv.ny-1, Math.floor((oy+H)/px) - lv.cy0);
    const hiEl = document.getElementById('densHi');
    if(a > b || c > d){ hiEl.textContent = '—'; return {L, total:0}; }

    /* Cells are compared as counts per reference area, which keeps the log
       ramp looking the same at every level and every latitude. */
    let hi = 0, total = 0;
    for(let y=c;y<=d;y++){
      const f = lv.ref/lv.area[y], row = y*lv.nx;
      for(let x=a;x<=b;x++){
        const v = lv.grid[row+x]; if(!v) continue;
        total += v;
        if(v*f > hi) hi = v*f;
      }
    }
    if(document.getElementById('densFixed').checked) hi = lv.hi;
    const hiD = hi/lv.ref;
    hiEl.textContent = !hi ? '—'
      : hiD >= 10 ? Math.round(hiD) + ' /km²' : hiD.toFixed(hiD >= 1 ? 1 : 2) + ' /km²';
    if(!hi) return {L, total};

    /* Log scale: lightning density spans orders of magnitude, and a linear
       ramp shows one bright cell over a storm track and nothing else. */
    const vw = b-a+1, vh = d-c+1, lmax = Math.log1p(hi);
    const ramp = CLASSES.map(k=> rgbOf(k.color));
    const img = new ImageData(vw, vh), u32 = new Uint32Array(img.data.buffer);
    for(let y=c;y<=d;y++){
      const f = lv.ref/lv.area[y], row = y*lv.nx, o = (y-c)*vw - a;
      for(let x=a;x<=b;x++){
        const v = lv.grid[row+x]; if(!v) continue;
        const t = Math.min(1, Math.log1p(v*f)/lmax);
        const A = Math.round(255*alpha*(0.18 + 0.82*t));
        u32[o+x] = ((A<<24) | ramp[Math.min(4, Math.floor(t*4.999))]) >>> 0;
      }
    }
    const off = this._densCanvas = this._densCanvas || document.createElement('canvas');
    off.width = vw; off.height = vh;
    off.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, (lv.cx0+a)*px - ox, (lv.cy0+c)*px - oy, vw*px, vh*px);
    ctx.imageSmoothingEnabled = true;
    return {L, total};
  },

  /* The rows of tiles that cover the view plus a margin, as index ranges
     into each class list. D is sorted by tile and the tiles are numbered
     row by row, so one row of tiles is one contiguous slice. */
  _spans: function(S, ox, oy, W, H, M){
    const T = D.tiles, tpx = S/Math.pow(2, T.L), out = [];
    const a = Math.max(0, Math.floor((ox-M)/tpx) - T.tx0), b = Math.min(T.ntx-1, Math.floor((ox+W+M)/tpx) - T.tx0);
    const c = Math.max(0, Math.floor((oy-M)/tpx) - T.ty0), d = Math.min(T.nty-1, Math.floor((oy+H+M)/tpx) - T.ty0);
    for(let y=c; a<=b && y<=d; y++) out.push(y*T.ntx + a, y*T.ntx + b + 1);
    return out;
  },

  /* Roughly how many strikes are on screen, from the tile counts alone:
     whole tiles at the edges are counted, so it errs high. Enough to choose
     between points and the grid without touching a single strike. */
  _countView: function(S, ox, oy, W, H){
    const sp = this._spans(S, ox, oy, W, H, 0);
    let n = 0;
    for(let k=0;k<NCLASS;k++){
      const gt = groupTiles[k]; if(!gt) continue;
      for(let s=0;s<sp.length;s+=2) n += gt[sp[s+1]] - gt[sp[s]];
    }
    return n;
  },

  /* What is in the view, plus a margin so an ellipse centred just off screen
     still shows its edge, thinned to the draw cap. The cap is against the
     strikes on screen, not the whole filter: zoom into one valley and every
     strike there is drawn, whatever the date range. Only the tiles in view
     are read.

     The sample keeps a strike when a hash of its index falls under the
     fraction. That spreads it evenly through time and over the map, thins
     each current class by the same fraction, and is stable: a strike drawn
     at one zoom is still drawn when you zoom in. */
  _collect: function(S, ox, oy, W, H){
    const M = 60, wx = D.wx, wy = D.wy;
    const sp = this._spans(S, ox, oy, W, H, M);
    this._bufs = this._bufs || [];
    const near = [];
    let onScreen = 0;
    for(let k=0;k<NCLASS;k++){
      const g = groups[k] || new Int32Array(0), gt = groupTiles[k];
      let b = this._bufs[k];
      if(!b || b.length < g.length) b = this._bufs[k] = new Int32Array(g.length);
      let n = 0;
      for(let s=0; gt && s<sp.length; s+=2){
        for(let j=gt[sp[s]], e=gt[sp[s+1]]; j<e; j++){
          const i = g[j];
          const x = wx[i]*S - ox; if(x < -M || x > W+M) continue;
          const y = wy[i]*S - oy; if(y < -M || y > H+M) continue;
          b[n++] = i;
          if(x >= 0 && x <= W && y >= 0 && y <= H) onScreen++;
        }
      }
      near.push(b.subarray(0, n));
    }
    const cap = +document.getElementById('cap').value || Infinity;
    const frac = onScreen > cap ? cap/onScreen : 1;
    if(frac < 1){
      const lim = frac*4294967296;
      for(let k=0;k<NCLASS;k++){
        const b = near[k];
        let m = 0;
        for(let j=0;j<b.length;j++) if((Math.imul(b[j], 2654435761)>>>0) < lim) b[m++] = b[j];
        near[k] = b.subarray(0, m);
      }
    }
    return {near, onScreen, frac};
  },

  /* Many dots: written straight into a pixel buffer, a disc stamped per
     strike, then put on the map in one go with the point opacity. A canvas
     path of a few hundred thousand arcs takes far longer to fill. Where
     dots of two classes overlap the later, stronger class wins outright
     instead of the two blending; at these numbers that is not visible. */
  _drawPixels: function(ctx, near, S, ox, oy, W, H, r, paint, alpha){
    const c = this._canvas, cw = c.width, ch = c.height, dpr = cw/W;
    let img = this._img;
    if(!img || img.width !== cw || img.height !== ch) img = this._img = new ImageData(cw, ch);
    const u32 = new Uint32Array(img.data.buffer);
    u32.fill(0);

    const R = r*dpr, Ri = Math.ceil(R - 0.5), offs = [], dxs = [], dys = [];
    for(let dy=-Ri;dy<=Ri;dy++) for(let dx=-Ri;dx<=Ri;dx++)
      if(dx*dx + dy*dy <= R*R + 0.25){ offs.push(dy*cw + dx); dxs.push(dx); dys.push(dy); }
    const ns = offs.length;

    const wx = D.wx, wy = D.wy;
    for(let k=0;k<NCLASS;k++){
      const g = near[k]; if(!g.length) continue;
      const col = ((255<<24) | rgbOf(paint[k])) >>> 0;
      for(let j=0;j<g.length;j++){
        const i = g[j];
        const x = wx[i]*S - ox; if(x < 0 || x > W) continue;
        const y = wy[i]*S - oy; if(y < 0 || y > H) continue;
        const X = Math.floor(x*dpr), Y = Math.floor(y*dpr);
        if(X >= Ri && X < cw-Ri && Y >= Ri && Y < ch-Ri){
          const o = Y*cw + X;
          for(let s=0;s<ns;s++) u32[o + offs[s]] = col;
        }else{
          for(let s=0;s<ns;s++){
            const px = X + dxs[s], py = Y + dys[s];
            if(px >= 0 && px < cw && py >= 0 && py < ch) u32[py*cw + px] = col;
          }
        }
      }
    }
    const off = this._ptCanvas = this._ptCanvas || document.createElement('canvas');
    if(off.width !== cw || off.height !== ch){ off.width = cw; off.height = ch; }
    off.getContext('2d').putImageData(img, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.drawImage(off, 0, 0, W, H);
    ctx.globalAlpha = 1;
  },

  _draw: function(){
    const m = this._map, c = this._canvas, ctx = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const size = m.getSize();
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,size.x,size.y);
    this._shown = null;
    if(!D) return;

    const z = m.getZoom();
    const S = 256 * Math.pow(2, z);                 // world width in pixels
    const origin = m.getPixelOrigin();
    const topLeft = m.containerPointToLayerPoint([0,0]);
    const ox = origin.x + topLeft.x, oy = origin.y + topLeft.y;
    const W = size.x, H = size.y;
    const ptA  = +document.getElementById('ptOpacity').value/100;

    /* Points or the grid. Automatic switches to the grid when there are
       more strikes on screen than the draw cap, judged from tile counts
       before any strike is read. */
    const mode = document.getElementById('drawMode').value;
    const cap = +document.getElementById('cap').value || Infinity;
    const dens = mode === 'density' || (mode === 'auto' && this._countView(S, ox, oy, W, H) > cap);
    if(dens){
      const {L, total} = this._drawDensity(ctx, S, ox, oy, W, H, ptA);
      const want = +document.getElementById('densCell').value;
      document.getElementById('sampleNote').textContent =
        (mode === 'auto' ? 'More than ' + cap.toLocaleString('en') + ' strikes on screen, so this is the density grid; zoom in or narrow the filter for points. ' : '') +
        'The grid counts every strike in the filter, not a sample.' +
        (L < want ? ' Cells widened to ' + cellLabel(L) + ' at this zoom; zoom in for smaller ones.' : '');
      updateReadout(total, 1);
      document.getElementById('ellNote').textContent = '';
      return;
    }

    /* Kilometres to pixels depends on latitude. One factor for the whole
       view, taken at the centre: across a screenful the error is small,
       and when it is not you are zoomed far enough out that the ellipses
       are sub-pixel and switched off anyway. */
    const kmPx = 1000 * Math.pow(2,z) / (156543.03392 * Math.cos(m.getCenter().lat*Math.PI/180));

    const {near, onScreen, frac} = this._collect(S, ox, oy, W, H);
    this._shown = near;
    const shown = Math.round(onScreen*frac);

    let ellDrawn = 0, ellTiny = 0;
    const drawEll = document.getElementById('ellOn').checked;
    const ellStride = Math.max(1, Math.ceil(shown/ELLIPSE_BUDGET));
    const ellA = +document.getElementById('ellOpacity').value/100;
    const r = z < 7 ? 1 : z < 10 ? 1.4 : z < 13 ? 2 : 2.6;
    const bright = +document.getElementById('ptBright').value;
    const paint = CLASSES.map((c,k)=> shade(classColor(k), bright));

    const wx = D.wx, wy = D.wy, smaj = D.smaj, smin = D.smin, ang = D.ang;

    document.getElementById('sampleNote').textContent = !onScreen ? ''
      : frac < 1
        ? 'Showing a ' + pct(frac) + ' sample of the ' + onScreen.toLocaleString('en') +
          ' strikes on screen, spread evenly through them. Zoom in or narrow the filter to see every one.'
        : 'Showing all ' + onScreen.toLocaleString('en') + ' strikes on screen.';

    /* ellipses underneath, all classes, then the points on top */
    let ellSeen = 0;
    if(drawEll){
      ctx.globalAlpha = ellA;
      ctx.lineWidth = 1;
      for(let k=0;k<NCLASS;k++){
        const g = near[k]; if(!g.length) continue;
        ctx.strokeStyle = paint[k];
        for(let j=0;j<g.length;j++){
          const i = g[j];
          if(ellStride > 1 && (ellSeen++ % ellStride)) continue;
          const rx = smaj[i]*0.1*kmPx, ry = smin[i]*0.1*kmPx;
          if(rx < 1.2){ ellTiny++; continue; }
          ellDrawn++;
          ctx.beginPath();
          ctx.ellipse(wx[i]*S - ox, wy[i]*S - oy, rx, Math.max(ry,0.4), (ang[i]-90)*Math.PI/180, 0, 6.28318530718);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    /* A few thousand dots look best as smooth canvas arcs; past that the
       pixel buffer is many times faster. */
    if(shown > 30000) this._drawPixels(ctx, near, S, ox, oy, W, H, r, paint, ptA);
    else{
      ctx.globalAlpha = ptA;
      for(let k=0;k<NCLASS;k++){
        const g = near[k]; if(!g.length) continue;
        ctx.fillStyle = paint[k];
        ctx.beginPath();
        for(let j=0;j<g.length;j++){
          const i = g[j];
          const x = wx[i]*S - ox; if(x < 0 || x > W) continue;
          const y = wy[i]*S - oy; if(y < 0 || y > H) continue;
          ctx.moveTo(x+r, y);
          ctx.arc(x, y, r, 0, 6.28318530718);
        }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    updateReadout(onScreen, frac);
    let en = '';
    if(drawEll && ellDrawn === 0 && ellTiny > 0)
      en = 'Nothing to see yet: at this zoom the ellipses are under a pixel across. ' +
           'A typical error is a few hundred metres, so they appear around zoom 10 and ' +
           'are unmistakable past 12. The scale bar is your guide — zoom until it reads 1 km.';
    else if(drawEll && ellStride > 1)
      en = 'Too many on screen to outline them all: showing every ' + ellStride +
           'th. Zoom in and the rest appear.';
    document.getElementById('ellNote').textContent = en;
  }
});
const strikes = new StrikeLayer();
strikes.addTo(map);
