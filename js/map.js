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
