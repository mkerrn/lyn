/* The canvas strike layer: points, ellipses, density grid, per-view sampling. */

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
  /* Bins into a lat/lon-independent mercator grid sized so a cell is the
     requested number of kilometres at the centre of the view. Counts every
     strike in the filter, never the drawn sample, so the numbers are real
     totals. Cells are counted in a flat array over the view; when they are
     under a pixel across they are widened until they are not, and the
     caller is told the size used. */
  _drawDensity: function(ctx, S, ox, oy, W, H, alpha){
    let cellKm = +document.getElementById('densCell').value;
    const latR = this._map.getCenter().lat*Math.PI/180;
    let s, px, cx0, cy0, nx, ny;
    for(;;){
      s = cellKm*1000/(40075016.686*Math.cos(latR));      // cell size in world units
      px = s*S;                                           // and in pixels
      cx0 = Math.floor(ox/px); cy0 = Math.floor(oy/px);
      nx = Math.floor((ox+W)/px) - cx0 + 1; ny = Math.floor((oy+H)/px) - cy0 + 1;
      if(nx*ny <= W*H) break;
      cellKm *= 2;
    }
    const grid = new Int32Array(nx*ny);
    for(let k=0;k<NCLASS;k++){
      const g = groups[k]; if(!g) continue;
      for(let j=0;j<g.length;j++){
        const i = g[j];
        const cx = Math.floor(D.wx[i]/s) - cx0; if(cx < 0 || cx >= nx) continue;
        const cy = Math.floor(D.wy[i]/s) - cy0; if(cy < 0 || cy >= ny) continue;
        grid[cy*nx + cx]++;
      }
    }
    let hi = 0;
    for(let c=0;c<grid.length;c++) if(grid[c] > hi) hi = grid[c];
    const hiD = hi/(cellKm*cellKm);
    document.getElementById('densHi').textContent =
      hiD >= 10 ? Math.round(hiD) + ' /km²' : hiD.toFixed(hiD >= 1 ? 1 : 2) + ' /km²';
    if(!hi) return cellKm;

    /* Log scale: lightning density spans orders of magnitude, and a linear
       ramp shows one bright cell over a storm track and nothing else. */
    const lmax = Math.log1p(hi), side = Math.ceil(px);
    for(let c=0;c<grid.length;c++){
      const v = grid[c]; if(!v) continue;
      const cx = c % nx, cy = (c - cx)/nx;
      const t = lmax > 0 ? Math.log1p(v)/lmax : 1;
      ctx.fillStyle = CLASSES[Math.min(4, Math.floor(t*4.999))].color;
      ctx.globalAlpha = alpha*(0.18 + 0.82*t);
      ctx.fillRect((cx0+cx)*px - ox, (cy0+cy)*px - oy, side, side);
    }
    ctx.globalAlpha = 1;
    return cellKm;
  },

  /* What is in the view, plus a margin so an ellipse centred just off screen
     still shows its edge, thinned to the draw cap. The cap is against the
     strikes on screen, not the whole filter: zoom into one valley and every
     strike there is drawn, whatever the date range.

     The sample keeps a strike when a hash of its index falls under the
     fraction. That spreads it evenly through time and over the map, thins
     each current class by the same fraction, and is stable: a strike drawn
     at one zoom is still drawn when you zoom in. */
  _collect: function(S, ox, oy, W, H){
    const M = 60, wx = D.wx, wy = D.wy;
    this._bufs = this._bufs || [];
    const near = [];
    let onScreen = 0;
    for(let k=0;k<NCLASS;k++){
      const g = groups[k] || new Int32Array(0);
      let b = this._bufs[k];
      if(!b || b.length < g.length) b = this._bufs[k] = new Int32Array(g.length);
      let n = 0;
      for(let j=0;j<g.length;j++){
        const i = g[j];
        const x = wx[i]*S - ox; if(x < -M || x > W+M) continue;
        const y = wy[i]*S - oy; if(y < -M || y > H+M) continue;
        b[n++] = i;
        if(x >= 0 && x <= W && y >= 0 && y <= H) onScreen++;
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

    /* Kilometres to pixels depends on latitude. One factor for the whole
       view, taken at the centre: across a screenful the error is small,
       and when it is not you are zoomed far enough out that the ellipses
       are sub-pixel and switched off anyway. */
    const kmPx = 1000 * Math.pow(2,z) / (156543.03392 * Math.cos(m.getCenter().lat*Math.PI/180));

    const {near, onScreen, frac} = this._collect(S, ox, oy, W, H);
    this._shown = near;
    const shown = Math.round(onScreen*frac);
    const dens = document.getElementById('densOn').checked;

    let visible = 0, ellDrawn = 0, ellTiny = 0;
    const drawEll = document.getElementById('ellOn').checked;
    const ellStride = Math.max(1, Math.ceil(shown/ELLIPSE_BUDGET));
    const ellA = +document.getElementById('ellOpacity').value/100;
    const ptA  = +document.getElementById('ptOpacity').value/100;
    const r = z < 7 ? 1 : z < 10 ? 1.4 : z < 13 ? 2 : 2.6;
    const squares = shown > 60000;
    const bright = +document.getElementById('ptBright').value;
    const paint = CLASSES.map((c,k)=> shade(classColor(k), bright));

    const wx = D.wx, wy = D.wy, smaj = D.smaj, smin = D.smin, ang = D.ang;

    document.getElementById('sampleNote').textContent = !onScreen || dens ? ''
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
    }

    if(dens){
      const used = this._drawDensity(ctx, S, ox, oy, W, H, ptA);
      document.getElementById('sampleNote').textContent =
        'The density grid counts every strike in the filter, not a sample.' +
        (used !== +document.getElementById('densCell').value
          ? ' Cells widened to ' + used + ' km at this zoom; zoom in for smaller ones.' : '');
      updateReadout(onScreen, 1);
      document.getElementById('ellNote').textContent = '';
      return;
    }

    ctx.globalAlpha = ptA;
    for(let k=0;k<NCLASS;k++){
      const g = near[k]; if(!g.length) continue;
      ctx.fillStyle = paint[k];
      if(squares){
        const d = r*1.7;
        for(let j=0;j<g.length;j++){
          const i = g[j];
          const x = wx[i]*S - ox; if(x < 0 || x > W) continue;
          const y = wy[i]*S - oy; if(y < 0 || y > H) continue;
          visible++;
          ctx.fillRect(x-d/2, y-d/2, d, d);
        }
      }else{
        ctx.beginPath();
        for(let j=0;j<g.length;j++){
          const i = g[j];
          const x = wx[i]*S - ox; if(x < 0 || x > W) continue;
          const y = wy[i]*S - oy; if(y < 0 || y > H) continue;
          visible++;
          ctx.moveTo(x+r, y);
          ctx.arc(x, y, r, 0, 6.28318530718);
        }
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

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
