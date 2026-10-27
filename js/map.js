/* Map setup, base layers, current classes and small shared helpers. */

/* A rotated ellipse costs many times what a dot does, so ellipses are
   thinned further than the points are, and the panel says by how much. */
const ELLIPSE_BUDGET = 60000;

/* ---------- peak current classes ---------- */
const CLASSES = [
  {max:10,   color:'#f2c14e', label:'under 10 kA'},
  {max:25,   color:'#f09030', label:'10 – 25 kA'},
  {max:50,   color:'#e2652f', label:'25 – 50 kA'},
  {max:100,  color:'#cf3038', label:'50 – 100 kA'},
  {max:1e9,  color:'#8f1d4e', label:'100 kA and up'}
];
const NCLASS = CLASSES.length;
const classOn = CLASSES.map(()=>true);

/* Colour presets, weakest class first. Whatever the viewer picks, preset or
   one swatch at a time, is kept in localStorage for the next visit. */
const PALETTES = {
  fire:    ['#f2c14e','#f09030','#e2652f','#cf3038','#8f1d4e'],
  viridis: ['#fde725','#5ec962','#21918c','#3b528b','#440154'],
  ice:     ['#c6f0ff','#6baed6','#2171b5','#08519c','#08306b'],
  neon:    ['#39ff14','#00e5ff','#ff00e5','#ff2a2a','#ffffff']
};
const COLOR_KEY = 'lyn.colors';
function saveColors(){
  try{ localStorage.setItem(COLOR_KEY, JSON.stringify(CLASSES.map(c=>c.color))); }catch(e){}
}
function paletteName(){
  const cur = CLASSES.map(c=>c.color).join();
  for(const k in PALETTES) if(PALETTES[k].join() === cur) return k;
  return 'custom';
}
try{
  const saved = JSON.parse(localStorage.getItem(COLOR_KEY));
  if(Array.isArray(saved) && saved.length === NCLASS && saved.every(c=>/^#[0-9a-f]{6}$/i.test(c)))
    saved.forEach((c,k)=> CLASSES[k].color = c);
}catch(e){}

/* One colour for every strike instead of one per class. The classes still
   filter; only the paint is shared. Kept for the next visit like the rest. */
const SINGLE_KEY = 'lyn.single';
const single = {on:false, color:'#f2c14e'};
try{
  const saved = JSON.parse(localStorage.getItem(SINGLE_KEY));
  if(saved && /^#[0-9a-f]{6}$/i.test(saved.color)){ single.on = !!saved.on; single.color = saved.color; }
}catch(e){}
function saveSingle(){
  try{ localStorage.setItem(SINGLE_KEY, JSON.stringify(single)); }catch(e){}
}
function classColor(k){ return single.on ? single.color : CLASSES[k].color; }

/* Brightness slider: mix each class colour toward white or black. Done once
   per class per frame, not per strike. */
function shade(hex, amt){
  if(!amt) return hex;
  let r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  const f = Math.abs(amt)/100, to = amt > 0 ? 255 : 0;
  r = Math.round(r + (to-r)*f); g = Math.round(g + (to-g)*f); b = Math.round(b + (to-b)*f);
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

function classOf(kA){
  const a = Math.abs(kA);
  for(let i=0;i<NCLASS;i++) if(a < CLASSES[i].max) return i;
  return NCLASS-1;
}

/* ---------- map ---------- */
/* Kartverket's tiles are transparent outside Norway, and the network
   reaches well into Sweden and Finland, so the Kartverket base sits on
   top of OpenTopoMap, which fills in everything across the border.
   Explicit z-indexes keep both under the altitude layer. */
const OTM_URL = 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png';
const OTM_OPTS = {maxZoom:18, maxNativeZoom:17, zIndex:-2,
                  attribution:'© OpenTopoMap, OpenStreetMap contributors'};
const bases = {
  kv: L.layerGroup([
    L.tileLayer(OTM_URL, OTM_OPTS),
    L.tileLayer('https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png',
        {maxZoom:18, zIndex:-1, attribution:'© Kartverket'})
  ]),
  otm: L.tileLayer(OTM_URL, OTM_OPTS)
};
const map = L.map('map', {center:[64.2, 12.0], zoom:5, layers:[bases.kv], zoomControl:true,
                          preferCanvas:true, attributionControl:true});
map.attributionControl.addAttribution('Lightning © MET Norway');

function pct(f){
  const p = f*100;
  return (p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : p.toFixed(2)) + ' %';
}
