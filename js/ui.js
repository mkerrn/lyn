/* Scale bar, readout, click popup, panel control wiring, and boot. */

/* ---------- scale bar ---------- */
/* Snaps to one of five round distances: the largest that still fits inside
   the readout box below it. */
const SCALE_STEPS = [10, 100, 1000, 10000, 100000];
const scaleBar = document.getElementById('scaleBar');
const scaleLabel = document.getElementById('scaleLabel');
function updateScale(){
  const mpp = 156543.03392 * Math.cos(map.getCenter().lat*Math.PI/180) / Math.pow(2, map.getZoom());
  const box = document.getElementById('readout').offsetWidth || 220;
  const maxW = Math.max(40, box - 20);          // room for the chip's own padding
  let pick = SCALE_STEPS[0];
  for(const s of SCALE_STEPS) if(s/mpp <= maxW) pick = s;
  scaleBar.style.width = Math.round(Math.min(maxW, pick/mpp)) + 'px';
  scaleLabel.textContent = pick >= 1000 ? (pick/1000) + ' km' : pick + ' m';
}
map.on('move zoomend resize', updateScale);
updateScale();

/* ---------- readout ---------- */
const readout = document.getElementById('readout');
function updateReadout(visible, frac){
  if(!D){ readout.textContent = 'Choose a data file in the panel'; return; }
  readout.innerHTML = '<b>' + visible.toLocaleString('en') + '</b> on screen · <b>' +
    filtered.toLocaleString('en') + '</b> in filter' +
    (frac < 1 ? ' · showing a <b>' + pct(frac) + '</b> sample' : '') +
    ' · tap a strike';
  updateScale();
}

/* ---------- click to inspect ---------- */
map.on('click', e=>{
  if(!D) return;
  const z = map.getZoom(), S = 256*Math.pow(2,z);
  const p = map.project(e.latlng, z);
  let best = -1, bestD = 12*12;
  const shown = strikes._shown || [];
  for(let k=0;k<shown.length;k++){
    const g = shown[k];
    for(let j=0;j<g.length;j++){
      const i = g[j];
      const dx = D.wx[i]*S - p.x; if(dx > 12 || dx < -12) continue;
      const dy = D.wy[i]*S - p.y; if(dy > 12 || dy < -12) continue;
      const d2 = dx*dx + dy*dy;
      if(d2 < bestD){ bestD = d2; best = i; }
    }
  }
  if(best < 0) return;
  const i = best;
  const when = new Date((D.t0 + D.t[i])*1000);
  const ms = String(when.getUTCMilliseconds()).padStart(3,'0');
  L.popup({closeButton:true})
    .setLatLng([D.lat[i]/1e5, D.lon[i]/1e5])
    .setContent(
      '<b>' + when.toISOString().slice(0,19).replace('T',' ') + '.' + ms + '</b> UTC<br>' +
      (D.peak[i] < 0 ? 'Negative ' : 'Positive ') + '<b>' + Math.abs(D.peak[i]) + ' kA</b> · ' +
      ((D.flag[i]&1) ? 'cloud to cloud' : 'cloud to ground') + '<br>' +
      'Error ellipse <b>' + (D.smaj[i]/10).toFixed(1) + ' × ' + (D.smin[i]/10).toFixed(1) +
      ' km</b> at <b>' + D.ang[i] + '°</b><br>' +
      D.lat[i]/1e5 + ', ' + D.lon[i]/1e5
    ).openOn(map);
});

/* ---------- controls ---------- */
document.getElementById('panelHead').onclick = ()=>{
  const p = document.getElementById('panel');
  p.classList.toggle('closed');
  document.getElementById('toggleHint').textContent = p.classList.contains('closed') ? 'show' : 'hide';
};
document.getElementById('dFrom').onchange = refilter;
document.getElementById('dTo').onchange = refilter;
document.getElementById('allTime').onclick = ()=>{
  if(!D) return;
  document.getElementById('dFrom').value = new Date((D.t0+D.t[0])*1000).toISOString().slice(0,10);
  document.getElementById('dTo').value   = new Date((D.t0+D.t[D.n-1])*1000).toISOString().slice(0,10);
  refilter();
};
document.getElementById('lastYear').onclick = ()=>{
  if(!D) return;
  const end = new Date((D.t0+D.t[D.n-1])*1000);
  const start = new Date(end); start.setUTCFullYear(end.getUTCFullYear()-1);
  document.getElementById('dFrom').value = start.toISOString().slice(0,10);
  document.getElementById('dTo').value   = end.toISOString().slice(0,10);
  refilter();
};
['t-all','t-cg','t-cc'].forEach(id=> document.getElementById(id).onchange = refilter);
document.getElementById('cap').onchange = refilter;
['iMin','iMax'].forEach(id=>{
  const el = document.getElementById(id);
  el.onchange = refilter;
  el.oninput = ()=>{ clearTimeout(el._t); el._t = setTimeout(refilter, 350); };
});
document.getElementById('pol').onchange = refilter;
document.getElementById('ellOn').onchange = ()=> strikes.redraw();
document.getElementById('ellOpacity').oninput = ()=> strikes.redraw();
document.getElementById('ptOpacity').oninput = ()=> strikes.redraw();
document.getElementById('densOn').onchange = ()=> strikes.redraw();
document.getElementById('densCell').onchange = ()=> strikes.redraw();
document.getElementById('ptBright').oninput = ()=>{
  strikes.redraw();
  const b = +document.getElementById('ptBright').value;
  [...legendEl.querySelectorAll('.sw')].forEach((el,k)=> el.style.background = shade(CLASSES[k].color, b));
};

function setBase(key){
  Object.values(bases).forEach(l=>{ if(map.hasLayer(l)) map.removeLayer(l); });
  bases[key].addTo(map);
}
document.getElementById('b-kv').onchange = ()=>setBase('kv');
document.getElementById('b-otm').onchange = ()=>setBase('otm');

(async function boot(){
  try{
    const r = await fetch(INDEX_URL);
    if(!r.ok) throw new Error(r.status + ' ' + r.statusText);
    manifest = await r.json();
    buildYearList();
    await syncYears();
  }catch(err){
    dataStatus.textContent = 'No ' + INDEX_URL + ' found (' + err.message +
      '). Pick a .bin or .bin.gz file below instead.';
    readout.textContent = 'Choose a data file in the panel';
  }
})();
