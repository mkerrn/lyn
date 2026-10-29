/* Filters (months, type, current, legend) into per-class index lists. */

/* ---------- filtering ---------- */
let groups = [];   // per current class: Int32Array of every index passing the filter
let filtered = 0;  // how many that is, over all classes
let groupTiles = []; // per class: groupTiles[k][t] is where tile t starts in groups[k]
let filterGen = 0;   // bumped on every refilter, so derived tables know when to rebuild

/* The years are chosen by which files are loaded, so this is one pass
   that buckets the survivors by current class, which lets the draw loop
   set a colour once per class instead of once per strike. */
function typeMode(){
  return document.getElementById('t-cg').checked ? 'cg'
       : document.getElementById('t-cc').checked ? 'cc' : 'all';
}
function refilter(){
  if(!isLightning()){ wxRefresh(); return; }
  if(!D) return;
  const i0 = 0, i1 = D.n;
  const mode = typeMode();
  const iMinV = parseFloat(document.getElementById('iMin').value);
  const iMaxV = parseFloat(document.getElementById('iMax').value);
  const iMin = isNaN(iMinV) ? 0 : iMinV;
  const iMax = isNaN(iMaxV) ? Infinity : iMaxV;
  const pol  = document.getElementById('pol').value;
  const dr = dayRange();

  const counts = new Int32Array(NCLASS);
  const cls = new Uint8Array(i1-i0);
  for(let i=i0;i<i1;i++){
    if(dr){
      const k = D.md[i];
      if(dr.lo <= dr.hi ? (k < dr.lo || k > dr.hi) : (k < dr.lo && k > dr.hi)){ cls[i-i0]=255; continue; }
    } else if(!monthOn[D.mon[i]]){ cls[i-i0]=255; continue; }
    const cloud = D.flag[i] & 1;
    if(mode==='cg' && cloud) { cls[i-i0]=255; continue; }
    if(mode==='cc' && !cloud){ cls[i-i0]=255; continue; }
    const pk = D.peak[i];
    if(pol==='neg' && pk >= 0){ cls[i-i0]=255; continue; }
    if(pol==='pos' && pk <= 0){ cls[i-i0]=255; continue; }
    const a = pk < 0 ? -pk : pk;
    if(a < iMin || a > iMax){ cls[i-i0]=255; continue; }
    const k = classOf(pk);
    cls[i-i0] = k; counts[k]++;
  }
  filtered = 0;
  for(let k=0;k<NCLASS;k++) if(classOn[k]) filtered += counts[k];

  /* Every survivor is kept here. The draw cap is applied later, to what is
     on screen, so zooming into one valley shows all of its strikes. */
  /* D is sorted by tile, so walking it tile by tile keeps each class list
     in tile order too, and the draw can take the strikes of a row of tiles
     as one slice. */
  groups = [];
  for(let k=0;k<NCLASS;k++) groups.push(new Int32Array(classOn[k] ? counts[k] : 0));
  const T = D.tiles, nt = T.ntx*T.nty;
  groupTiles = groups.map(()=> new Int32Array(nt+1));
  const fill = new Int32Array(NCLASS);
  for(let t=0;t<nt;t++){
    for(let k=0;k<NCLASS;k++) groupTiles[k][t] = fill[k];
    for(let i=T.start[t], e=T.start[t+1]; i<e; i++){
      const k = cls[i-i0];
      if(k===255 || !classOn[k]) continue;
      groups[k][fill[k]++] = i;
    }
  }
  for(let k=0;k<NCLASS;k++) groupTiles[k][nt] = fill[k];
  filterGen++;

  renderLegend(counts);
  strikes.redraw();
  regionHours();
}

/* ---------- legend ---------- */
const legendEl = document.getElementById('legend');
function renderLegend(counts){
  legendEl.innerHTML = '';
  CLASSES.forEach((c,k)=>{
    const d = document.createElement('div');
    d.className = 'k' + (classOn[k] ? '' : ' off');
    d.innerHTML = '<label class="sw" title="Change colour" style="background:'+
                  shade(classColor(k), +document.getElementById('ptBright').value)+'">' +
                  '<input type="color" value="'+classColor(k)+'"></label>' +
                  '<label>'+c.label+'</label>' +
                  '<span class="n">'+(counts ? counts[k].toLocaleString('en') : '')+'</span>';
    d.onclick = ()=>{
      classOn[k] = !classOn[k];
      refilter();
    };
    /* The swatch opens the colour picker instead of hiding the class. */
    d.querySelector('.sw').onclick = e=> e.stopPropagation();
    d.querySelector('input').oninput = e=> setClassColor(k, e.target.value);
    legendEl.appendChild(d);
  });
  updateColorUI();
}

function setClassColor(k, hex){
  if(single.on){ single.color = hex; saveSingle(); }
  else{ CLASSES[k].color = hex; saveColors(); }
  updateColorUI();
  strikes.redraw();
}

/* Swatches, the density ramp and the preset menu all follow CLASSES. */
function updateColorUI(){
  const b = +document.getElementById('ptBright').value;
  [...legendEl.querySelectorAll('.sw')].forEach((el,k)=>{
    el.style.background = shade(classColor(k), b);
    el.firstChild.value = classColor(k);
  });
  const c = CLASSES.map(c=>c.color);
  document.getElementById('densRamp').style.background =
    'linear-gradient(to right,' + c[0] + '26,' + c.join(',') + ')';
  document.getElementById('palette').value = single.on ? 'single' : paletteName();
  document.getElementById('singleRow').style.display = single.on ? '' : 'none';
  document.getElementById('singleColor').value = single.color;
}
renderLegend(null);

/* ---------- months ---------- */
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const monthOn = MONTHS.map(()=> true);
const monthsEl = document.getElementById('months');
function renderMonths(){
  monthsEl.innerHTML = '';
  MONTHS.forEach((name,m)=>{
    const b = document.createElement('button');
    b.textContent = name;
    b.className = monthOn[m] ? '' : 'off';
    b.onclick = ()=>{ clearDayRange(); monthOn[m] = !monthOn[m]; renderMonths(); refilter(); };
    monthsEl.appendChild(b);
  });
}
function setMonths(list){
  clearDayRange();
  for(let m=0;m<12;m++) monthOn[m] = list.includes(m);
  renderMonths(); refilter();
}
renderMonths();
/* All, or none when all are on already. */
document.getElementById('mAll').onclick    = ()=> setMonths(monthOn.every(Boolean) && !dayRange() ? [] : [0,1,2,3,4,5,6,7,8,9,10,11]);
document.getElementById('mSummer').onclick = ()=> setMonths([5,6,7]);
document.getElementById('mWinter').onclick = ()=> setMonths([10,11,0,1]);

/* ---------- days of the year ---------- */
/* A from–to pair like 15/8 – 15/9, applied to every year. When both ends are
   filled in it replaces the month toggles, which are dimmed to say so. A
   range that runs past New Year, 15/11 – 15/2, wraps. */
const dayFromEl = document.getElementById('dayFrom'), dayToEl = document.getElementById('dayTo');
function parseDay(el){
  const v = el.value.trim();
  if(!v){ el.classList.remove('bad'); return null; }
  const m = v.match(/^(\d{1,2})\s*[\/.\-]\s*(\d{1,2})$/);
  const d = m ? +m[1] : 0, mo = m ? +m[2] : 0;
  const ok = mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(2024, mo, 0)).getUTCDate();
  el.classList.toggle('bad', !ok);
  return ok ? (mo-1)*32 + d : null;
}
function dayRange(){
  const lo = parseDay(dayFromEl), hi = parseDay(dayToEl);
  const on = lo !== null && hi !== null;
  monthsEl.classList.toggle('ignored', on);
  return on ? {lo, hi} : null;
}
function clearDayRange(){
  dayFromEl.value = dayToEl.value = '';
  dayFromEl.classList.remove('bad'); dayToEl.classList.remove('bad');
  monthsEl.classList.remove('ignored');
}
[dayFromEl, dayToEl].forEach(el=> el.onchange = refilter);
document.getElementById('dayClear').onclick = ()=>{ clearDayRange(); refilter(); };
