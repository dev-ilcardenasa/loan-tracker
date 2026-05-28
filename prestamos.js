'use strict';

/* ══════════════════════════════════════════════
   CONTROL DE PRÉSTAMOS COP — prestamos.js
   PIN SHA-256 · Interés fijo · Abonos · Estado
══════════════════════════════════════════════ */

const SEC = {
  PIN_HASH: '4d24bf25aea82d0a9091410b3d11f87523d96d0633808ca71b08d8b0638f64ac', // PIN: 7445
  PIN_LEN: 4,
  MAX_ATTEMPTS: 5,
  LOCKOUT_MS: 60_000,
  NAME_MIN: 3,
  NAME_MAX: 50,
  NOTE_MAX: 50,
  ABONO_NOTE_MAX: 50,
  AMOUNT_MAX: 999_999_999,
  PRESTAMOS_MAX: 300,
  ABONOS_MAX: 500,
  TEXT_SAFE: /^[\p{L}\s]+$/u,
  STORAGE_KEY: 'prestamos_cop_v1',
};

/* ─── ESTADO ─── */
let prestamos = [];
let currentId = null;
let currentFilter = 'activos';
let pendingDeleteId = null;
let pendingDeleteAbonoIdx = null;
let editingAbonoIdx = null;
let editingType = null; // 'abono' | 'extra' | 'inicial'

let pinEntry = '';
let pinAttempts = 0;
let pinLockedUntil = 0;

/* ─── UTILIDADES ─── */
async function sha256hex(t) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
  } catch { return ''; }
}

function esc(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
          .replace(/"/g,'&quot;').replace(/'/g,'&#x27;').replace(/\//g,'&#x2F;');
}

function san(raw, max) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  // 1. Quitar todo lo que no sea letra o espacio
  s = s.replace(/[^\p{L}\s]/gu, '');
  // 2. No permitir más de 2 caracteres idénticos seguidos
  s = s.replace(/(.)\1{2,}/gu, '$1$1');
  // 3. No permitir espacios dobles
  s = s.replace(/\s{2,}/g, ' ');
  return s.trim().slice(0, max || SEC.NAME_MAX);
}

function isRealText(s) {
  if (!s || s.length < SEC.NAME_MIN) return false;
  
  const text = s.toLowerCase();
  const words = text.split(/\s+/);
  
  // 1. Cada palabra de más de 2 letras DEBE tener al menos una vocal
  for (const word of words) {
    if (word.length > 2 && !/[aeiouáéíóúü]/.test(word)) return false;
    if (word.length > 15) return false; // Palabra demasiado larga (posible basura)
  }

  // 2. Contar vocales y consonantes para ver la proporción
  const vowels = (text.match(/[aeiouáéíóúü]/g) || []).length;
  const letters = (text.match(/[\p{L}]/gu) || []).length;
  
  if (letters > 0) {
    const ratio = vowels / letters;
    // Un nombre real difícilmente tiene menos del 20% o más del 80% de vocales
    if (ratio < 0.20 || ratio > 0.80) return false;
  }

  // 3. No permitir más de 3 consonantes seguidas (reducido de 4 a 3 para más rigor)
  if (/[bcdfghjklmnpqrstvwxyzñ]{4,}/i.test(text.replace(/\s/g, ''))) return false;

  return true;
}

function isTextSafe(t) { return t && t.length > 0 && SEC.TEXT_SAFE.test(t); }

function parseAmount(raw) {
  const n = parseFloat(raw);
  if (!isFinite(n) || isNaN(n) || n <= 0 || n > SEC.AMOUNT_MAX) return null;
  if (!/^\d+(\.\d+)?$/.test(String(raw).trim())) return null;
  return Math.round(n);
}

function uid() {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return a[0].toString(36) + a[1].toString(36) + Date.now().toString(36);
}

/* ─── FORMATO COP ─── */
function cop(n) {
  return new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',minimumFractionDigits:0,maximumFractionDigits:0}).format(n);
}
function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('es-CO',{day:'2-digit',month:'short',year:'numeric'});
}
function fmtDateShort(ts) {
  return new Date(ts).toLocaleDateString('es-CO',{day:'2-digit',month:'short'});
}

/* ─── CÁLCULOS ─── */
function calcInterest(monto, pct) {
  return Math.round(monto * (pct / 100));
}
function calcExtras(p) {
  return (p.extras || []).reduce((s, x) => s + x.amount, 0);
}
function calcMontoTotal(p) {
  // Sin interés: monto inicial + extras acumulados
  // Con interés: solo monto inicial (fijo)
  return p.interes === 0 ? p.monto + calcExtras(p) : p.monto;
}
function calcTotalDue(p) {
  const base = calcMontoTotal(p);
  return base + calcInterest(base, p.interes);
}
function calcTotalAbonado(p) {
  return p.abonos.reduce((s, a) => s + a.amount, 0);
}
function calcSaldo(p) {
  return Math.max(0, calcTotalDue(p) - calcTotalAbonado(p));
}
function isPagado(p) {
  const totalDue = calcTotalDue(p);
  return totalDue > 0 && calcSaldo(p) === 0 && p.abonos.length > 0;
}

/* ─── TOAST ─── */
function showToast(msg, type = 'ok') {
  const old = document.getElementById('app-toast');
  if (old) old.remove();
  const t = document.createElement('div');
  t.id = 'app-toast';
  t.style.cssText = `background:${type==='error'?'#ff5757':'#c8ff57'};color:${type==='error'?'#fff':'#0c0c0c'}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

/* ─── PERSISTENCIA ─── */
function loadData() {
  try {
    const raw = localStorage.getItem(SEC.STORAGE_KEY);
    if (!raw) { prestamos = []; return; }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) { prestamos = []; return; }
    prestamos = parsed
      .filter(p => p && typeof p.id === 'string' && typeof p.nombre === 'string')
      .slice(0, SEC.PRESTAMOS_MAX)
      .map(p => ({
        id: san(p.id, 40),
        nombre: san(p.nombre, SEC.NAME_MAX),
        monto: Math.min(Math.max(parseInt(p.monto)||0, 0), SEC.AMOUNT_MAX),
        interes: Math.min(Math.max(parseFloat(p.interes)||0, 0), 999),
        nota: san(p.nota||'', SEC.NOTE_MAX),
        createdAt: Number(p.createdAt) || Date.now(),
        abonos: Array.isArray(p.abonos)
          ? p.abonos.filter(a => a && a.amount > 0).slice(0, SEC.ABONOS_MAX).map(a => ({
              id: san(a.id||uid(), 40),
              amount: Math.min(Math.max(parseInt(a.amount)||0, 0), SEC.AMOUNT_MAX),
              note: san(a.note||'', SEC.ABONO_NOTE_MAX),
              date: Number(a.date) || Date.now(),
            }))
          : [],
        extras: Array.isArray(p.extras)
          ? p.extras.filter(x => x && x.amount > 0).slice(0, 200).map(x => ({
              id: san(x.id||uid(), 40),
              amount: Math.min(Math.max(parseInt(x.amount)||0, 0), SEC.AMOUNT_MAX),
              note: san(x.note||'', SEC.ABONO_NOTE_MAX),
              date: Number(x.date) || Date.now(),
            }))
          : [],
      }));
  } catch(e) {
    console.error('[Préstamos] Error al cargar:', e.message);
    prestamos = [];
  }
}

function saveData() {
  try { localStorage.setItem(SEC.STORAGE_KEY, JSON.stringify(prestamos)); }
  catch(e) { showToast('Error al guardar datos.', 'error'); }
}

/* ════════════════════════════════
   PIN / LOGIN
════════════════════════════════ */
function initPinState() {
  try {
    const d = JSON.parse(sessionStorage.getItem('pin_lock') || '{}');
    pinAttempts = d.attempts || 0;
    pinLockedUntil = d.until || 0;
  } catch { pinAttempts = 0; pinLockedUntil = 0; }
  updateLockUI();
}

function savePinLock() {
  try { sessionStorage.setItem('pin_lock', JSON.stringify({attempts:pinAttempts,until:pinLockedUntil})); } catch {}
}

function isLocked() { return pinLockedUntil > Date.now(); }

function updateLockUI() {
  const att = document.getElementById('login-attempts');
  const btn = document.getElementById('btn-locked');
  if (!att) return;
  if (isLocked()) {
    const rem = Math.ceil((pinLockedUntil - Date.now()) / 1000);
    att.textContent = `Sistema bloqueado. Intenta en ${rem}s`;
    if (btn) btn.style.display = 'block';
    setTimeout(updateLockUI, 1000);
  } else {
    if (pinLockedUntil > 0) { pinAttempts = 0; pinLockedUntil = 0; savePinLock(); }
    if (btn) btn.style.display = 'none';
    att.textContent = pinAttempts > 0 ? `Intentos restantes: ${SEC.MAX_ATTEMPTS - pinAttempts}` : '';
  }
}

function pinPress(digit) {
  if (isLocked() || !/^[0-9]$/.test(digit) || pinEntry.length >= SEC.PIN_LEN) return;
  pinEntry += digit;
  updateDots();
  if (pinEntry.length === SEC.PIN_LEN) setTimeout(checkPin, 120);
}

function pinDel() {
  if (isLocked() || pinEntry.length === 0) return;
  pinEntry = pinEntry.slice(0,-1);
  updateDots();
  clearLoginError();
}

function updateDots(state) {
  for (let i = 0; i < SEC.PIN_LEN; i++) {
    const d = document.getElementById('dot-'+i);
    if (!d) continue;
    d.className = 'pin-dot';
    if (state === 'error') d.classList.add('error');
    else if (i < pinEntry.length) d.classList.add('filled');
  }
}

async function checkPin() {
  const hash = await sha256hex(pinEntry);
  if (hash === SEC.PIN_HASH) {
    pinAttempts = 0; pinLockedUntil = 0; savePinLock();
    const loginEl = document.getElementById('login');
    loginEl.style.transition = 'opacity 0.35s';
    loginEl.style.opacity = '0';
    setTimeout(() => {
      loginEl.classList.remove('active');
      loginEl.style.opacity = '';
      loadData();
      renderHome();
      document.getElementById('home').classList.add('active');
    }, 350);
  } else {
    pinAttempts++;
    savePinLock();
    updateDots('error');
    document.getElementById('login-error').classList.add('visible');
    if (pinAttempts >= SEC.MAX_ATTEMPTS) { pinLockedUntil = Date.now() + SEC.LOCKOUT_MS; savePinLock(); }
    setTimeout(() => {
      pinEntry = '';
      updateDots();
      document.getElementById('login-error').classList.remove('visible');
      updateLockUI();
    }, 900);
  }
}

/* ════════════════════════════════
   HOME
════════════════════════════════ */
function toggleNewCard() {
  const card = document.getElementById('new-prestamo-card');
  const btn = document.getElementById('btn-toggle-new');
  if (!card || !btn) return;
  card.classList.toggle('open');
  btn.classList.toggle('active');
  if (card.classList.contains('open')) {
    setTimeout(() => document.getElementById('new-name').focus(), 400);
  }
}

function setFilter(f) {
  currentFilter = f;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.filter === f));
  renderHome();
}

function renderHome() {
  const list = document.getElementById('prestamos-list');
  const empty = document.getElementById('empty-home');
  if (!list) return;
  list.innerHTML = '';

  let filtered = prestamos;
  if (currentFilter === 'activos') filtered = prestamos.filter(p => !isPagado(p));
  else if (currentFilter === 'pagados') filtered = prestamos.filter(p => isPagado(p));

  if (filtered.length === 0) { empty.style.display = 'block'; return; }
  empty.style.display = 'none';

  filtered.forEach(p => {
    const saldo = calcSaldo(p);
    const totalDue = calcTotalDue(p);
    const pagado = isPagado(p);
    const pct = totalDue > 0 ? Math.min(100, Math.round((calcTotalAbonado(p) / totalDue) * 100)) : 0;

    const card = document.createElement('div');
    card.className = 'prestamo-card' + (pagado ? ' pagado' : '');
    card.setAttribute('role','listitem');

    card.innerHTML = `
      <button class="card-delete" data-id="${esc(p.id)}" title="Eliminar" aria-label="Eliminar préstamo">✕</button>
      <div class="card-top">
        <div class="card-name">${esc(p.nombre)}</div>
        <span class="card-badge ${pagado?'pagado':'activo'}">${pagado?'✓ Pagado':'Activo'}</span>
      </div>
      <div class="card-saldo ${saldo===0?'zero':''}">${saldo===0?'¡Saldado!':cop(saldo)}</div>
      <div class="card-prog-bar"><div class="card-prog-fill${pagado?' done':''}" style="width:${pct}%"></div></div>
      <div class="card-meta">
        <span>Prestado: ${cop(p.monto)}</span>
        ${p.interes > 0 ? `<span>Interés: ${p.interes}%</span>` : ''}
        <span>${p.abonos.length} abono${p.abonos.length!==1?'s':''}</span>
        <span>${fmtDate(p.createdAt)}</span>
      </div>
    `;
    card.querySelector('.card-delete').addEventListener('click', e => { e.stopPropagation(); promptDelete(p.id); });
    card.addEventListener('click', () => openPrestamo(p.id));
    list.appendChild(card);
  });
}

/* ─── CREAR PRÉSTAMO ─── */
function getInterestValue() {
  const sel = document.getElementById('new-interest-sel');
  const custom = document.getElementById('new-interest-custom');
  if (sel.value === 'custom') {
    const v = parseFloat(custom.value);
    return isFinite(v) && v >= 0 ? v : null;
  }
  return parseFloat(sel.value) || 0;
}

function onInterestChange() {
  const sel = document.getElementById('new-interest-sel');
  const custom = document.getElementById('new-interest-custom');
  custom.style.display = sel.value === 'custom' ? 'block' : 'none';
  updateInterestPreview();
}

function updateInterestPreview() {
  const preview = document.getElementById('interest-preview');
  const ptotal = document.getElementById('preview-total');
  const pbreak = document.getElementById('preview-breakdown');
  const rawAmount = document.getElementById('new-amount').value;
  const monto = parseAmount(rawAmount);
  const pct = getInterestValue();

  if (!monto || monto <= 0 || pct === null || pct === 0) { preview.style.display = 'none'; return; }
  const intVal = calcInterest(monto, pct);
  const total = monto + intVal;
  preview.style.display = 'block';
  ptotal.textContent = cop(total);
  pbreak.textContent = `${cop(monto)} + ${pct}% de interés = ${cop(intVal)}`;
}

function createPrestamo() {
  const nameEl   = document.getElementById('new-name');
  const amountEl = document.getElementById('new-amount');
  const noteEl   = document.getElementById('new-note');

  const nombre = san(nameEl.value, SEC.NAME_MAX);
  const monto  = parseAmount(amountEl.value);
  const interes = getInterestValue();
  const nota   = san(noteEl.value, SEC.NOTE_MAX);

  if (!nombre || !isRealText(nombre)) { flash(nameEl); showToast('El nombre no parece ser real', 'error'); return; }
  if (!monto) { flash(amountEl); showToast('Ingresa un monto válido', 'error'); return; }
  if (interes === null) { flash(document.getElementById('new-interest-custom')); showToast('Porcentaje de interés inválido', 'error'); return; }
  if (!nota || !isRealText(nota)) { flash(noteEl); showToast('La descripción no parece ser real', 'error'); return; }
  if (prestamos.length >= SEC.PRESTAMOS_MAX) { showToast('Límite de préstamos alcanzado', 'error'); return; }

  const p = { id: uid(), nombre, monto, interes, nota, createdAt: Date.now(), abonos: [], extras: [] };
  prestamos.unshift(p);
  saveData();

  nameEl.value = '';
  amountEl.value = '';
  noteEl.value = '';
  document.getElementById('new-interest-sel').value = '0';
  document.getElementById('new-interest-custom').style.display = 'none';
  document.getElementById('interest-preview').style.display = 'none';
  updateCharCounter('new-name', 'new-name-counter', SEC.NAME_MAX);

  toggleNewCard(); // Cerrar el formulario tras crear
  renderHome();
  openPrestamo(p.id);
}

/* ─── DELETE PRÉSTAMO ─── */
function promptDelete(id) {
  const p = prestamos.find(x => x.id === id);
  if (!p) return;
  pendingDeleteId = id;
  document.getElementById('del-modal-text').textContent = `Se eliminará el préstamo de "${p.nombre}". Esta acción no se puede deshacer.`;
  document.getElementById('del-modal').classList.add('open');
}
function closeModal() { pendingDeleteId = null; document.getElementById('del-modal').classList.remove('open'); }
function confirmDelete() {
  if (!pendingDeleteId) return;
  prestamos = prestamos.filter(p => p.id !== pendingDeleteId);
  saveData(); closeModal();
  if (currentId === pendingDeleteId) goHome(); else renderHome();
}

/* ═══════════════════════════════
   DETAIL
═══════════════════════════════ */
function openPrestamo(id) {
  currentId = id;
  document.getElementById('home').classList.remove('active');
  document.getElementById('detail').classList.add('active');
  renderDetail();
  window.scrollTo(0, 0);
}

function getP() { return prestamos.find(p => p.id === currentId) || null; }

function goHome() {
  currentId = null;
  document.getElementById('detail').classList.remove('active');
  document.getElementById('home').classList.add('active');
  renderHome();
}

function renderDetail() {
  const p = getP();
  if (!p) { goHome(); return; }

  const totalDue  = calcTotalDue(p);
  const abonado   = calcTotalAbonado(p);
  const saldo     = calcSaldo(p);
  const pagado    = isPagado(p);
  const intVal    = calcInterest(p.monto, p.interes);
  const pct       = totalDue > 0 ? Math.min(100, Math.round((abonado / totalDue) * 100)) : 0;

  // Título
  document.getElementById('detail-title').textContent = p.nombre;
  document.getElementById('detail-title-input').value = p.nombre;

  // Badge
  const badge = document.getElementById('d-badge');
  badge.textContent = pagado ? '✓ Pagado' : 'Activo';
  badge.className = 'status-badge ' + (pagado ? 'pagado' : 'activo');
  document.getElementById('d-meta').textContent = 'Desde ' + fmtDate(p.createdAt);

  // Progress
  const fill = document.getElementById('d-prog-fill');
  fill.style.width = pct + '%';
  fill.className = 'progress-fill' + (pagado ? ' done' : '');
  document.getElementById('d-prog-lbl').textContent = `${pct}% pagado`;

  // Saldo rápido bajo la barra
  const saldoEl = document.getElementById('d-saldo');
  if (saldoEl) {
    saldoEl.textContent = pagado ? '¡Saldado! ✓' : cop(saldo);
    saldoEl.className = 'qs-val bold' + (pagado ? ' blue' : '');
  }
  const abonadoEl = document.getElementById('d-abonado');
  if (abonadoEl) abonadoEl.textContent = cop(abonado);

  // Resumen financiero completo (solo con interés)
  const summaryCard = document.getElementById('d-summary-card');
  const montoTotal = calcMontoTotal(p);
  if (p.interes > 0) {
    if (summaryCard) summaryCard.style.display = '';
    document.getElementById('d-prestado').textContent = cop(montoTotal);
    document.getElementById('d-int-row').style.display = '';
    document.getElementById('d-int-lbl').textContent = `Interés (${p.interes}%)`;
    document.getElementById('d-int-val').textContent = cop(calcInterest(montoTotal, p.interes));
    document.getElementById('d-total-due').textContent = cop(totalDue);
    const s2 = document.getElementById('d-saldo2');
    if (s2) { s2.textContent = pagado ? '¡Saldado! ✓' : cop(saldo); s2.className = 'sum-val bold' + (pagado ? ' blue' : ''); }
    const a2 = document.getElementById('d-abonado2');
    if (a2) a2.textContent = cop(abonado);
  } else {
    if (summaryCard) summaryCard.style.display = 'none';
  }

  // Etiqueta dinámica del historial
  const histLabel = document.getElementById('d-historial-label');
  if (histLabel) histLabel.textContent = p.interes === 0 ? 'Movimientos' : 'Historial de abonos';

  // Abonos (y extras unificados para préstamos sin interés)
  const abonosList = document.getElementById('d-abonos-list');
  const emptyEl    = document.getElementById('d-empty');
  abonosList.innerHTML = '';

  if (p.interes === 0) {
    // ── Línea de tiempo unificada: préstamo inicial + extras + abonos ──
    const timeline = [];
    timeline.push({ type: 'inicial', data: { amount: p.monto, note: p.nota || '', date: p.createdAt }, origIdx: -1 });
    (p.extras || []).forEach((x, i) => timeline.push({ type: 'extra', data: x, origIdx: i }));
    p.abonos.forEach((a, i) => timeline.push({ type: 'abono', data: a, origIdx: i }));
    timeline.sort((a, b) => b.data.date - a.data.date);

    emptyEl.style.display = 'none';
    timeline.forEach(entry => {
      const { type, data, origIdx } = entry;
      const div = document.createElement('div');
      div.setAttribute('role', 'listitem');
      let label, amountHtml, delBtn = '', clickFn = null;
      if (type === 'inicial') {
        div.className = 'abono-item inicial-item';
        label = data.note ? esc(data.note) : 'Préstamo inicial';
        amountHtml = `<span class="abono-amount inicial-amount">+${cop(data.amount)}</span>`;
        delBtn = `<button class="abono-del" title="Eliminar préstamo" aria-label="Eliminar préstamo">✕</button>`;
        clickFn = () => openEditInicialModal();
      } else if (type === 'extra') {
        div.className = 'abono-item extra-item';
        label = data.note ? esc(data.note) : 'Préstamo adicional #' + (origIdx + 1);
        amountHtml = `<span class="abono-amount extra-amount">+${cop(data.amount)}</span>`;
        delBtn = `<button class="abono-del" title="Eliminar" aria-label="Eliminar">✕</button>`;
        clickFn = () => openEditExtraModal(origIdx);
      } else {
        div.className = 'abono-item';
        label = data.note ? esc(data.note) : 'Abono #' + (origIdx + 1);
        amountHtml = `<span class="abono-amount">−${cop(data.amount)}</span>`;
        delBtn = `<button class="abono-del" title="Eliminar abono" aria-label="Eliminar abono">✕</button>`;
        clickFn = () => openEditAbonoModal(origIdx);
      }
      div.innerHTML = `
        <div class="abono-info">
          <div class="abono-label">${label}</div>
          <div class="abono-date">${fmtDate(data.date)}</div>
        </div>
        ${amountHtml}
        ${delBtn}
      `;
      if (clickFn) div.addEventListener('click', clickFn);
      if (type === 'inicial') div.querySelector('.abono-del').addEventListener('click', e => { e.stopPropagation(); promptDelete(currentId); });
      else if (type === 'extra') div.querySelector('.abono-del').addEventListener('click', e => { e.stopPropagation(); promptDeleteExtra(origIdx); });
      else if (type === 'abono') div.querySelector('.abono-del').addEventListener('click', e => { e.stopPropagation(); promptDeleteAbono(origIdx); });
      abonosList.appendChild(div);
    });
  } else {
    // ── Préstamo con interés: solo abonos (comportamiento original) ──
    if (p.abonos.length === 0) {
      emptyEl.style.display = 'block';
    } else {
      emptyEl.style.display = 'none';
      [...p.abonos].reverse().forEach((a, ri) => {
        const realIdx = p.abonos.length - 1 - ri;
        const div = document.createElement('div');
        div.className = 'abono-item';
        div.setAttribute('role','listitem');
        div.innerHTML = `
          <div class="abono-info">
            <div class="abono-label">${a.note ? esc(a.note) : 'Abono #' + (realIdx + 1)}</div>
            <div class="abono-date">${fmtDate(a.date)}</div>
          </div>
          <span class="abono-amount">−${cop(a.amount)}</span>
          <button class="abono-del" title="Eliminar abono" aria-label="Eliminar abono">✕</button>
        `;
        div.addEventListener('click', () => openEditAbonoModal(realIdx));
        div.querySelector('.abono-del').addEventListener('click', e => { e.stopPropagation(); promptDeleteAbono(realIdx); });
        abonosList.appendChild(div);
      });
    }
  }

  // Manejo de FABs
  const fabGroup = document.getElementById('d-fab-group');
  const fabExtra = document.getElementById('fab-extra');
  const fabAbono = document.getElementById('fab-abono');

  if (fabGroup) {
    if (pagado) {
      fabGroup.style.display = 'none';
    } else {
      fabGroup.style.display = 'flex';
      if (fabExtra) fabExtra.style.display = p.interes === 0 ? 'flex' : 'none';
      if (fabAbono) fabAbono.style.display = 'flex';
    }
  }

  // Banner pagado
  const banner = document.getElementById('d-paid-banner');
  if (banner) banner.style.display = pagado ? 'block' : 'none';
}

/* ─── MODALES FAB ─── */
function openExtraModal() {
  document.getElementById('extra-modal').classList.add('open');
  document.getElementById('d-extra-amount').value = '';
  document.getElementById('d-extra-note').value = '';
  setTimeout(() => document.getElementById('d-extra-amount').focus(), 100);
}
function closeExtraModal() {
  document.getElementById('extra-modal').classList.remove('open');
  document.getElementById('d-extra-err').textContent = '';
  document.getElementById('d-extra-amount').classList.remove('error');
}
function openAbonoModal() {
  document.getElementById('abono-modal').classList.add('open');
  document.getElementById('d-abono-amount').value = '';
  setTimeout(() => document.getElementById('d-abono-amount').focus(), 100);
}
function closeAbonoModal() {
  document.getElementById('abono-modal').classList.remove('open');
  document.getElementById('d-abono-err').textContent = '';
  document.getElementById('d-abono-amount').classList.remove('error');
}

/* ─── EXTRAS (préstamos adicionales sin interés) ─── */
function renderExtrasList(p) {
  const list = document.getElementById('d-extras-list');
  if (!list) return;
  list.innerHTML = '';
  if (!p.extras || p.extras.length === 0) return;
  [...p.extras].reverse().forEach((x, ri) => {
    const realIdx = p.extras.length - 1 - ri;
    const div = document.createElement('div');
    div.className = 'abono-item extra-item';
    div.innerHTML = `
      <div class="abono-info">
        <div class="abono-label">${x.note ? esc(x.note) : 'Préstamo adicional #' + (realIdx + 1)}</div>
        <div class="abono-date">${fmtDate(x.date)}</div>
      </div>
      <span class="abono-amount extra-amount">+${cop(x.amount)}</span>
      <button class="abono-del" title="Eliminar" aria-label="Eliminar préstamo adicional">✕</button>
    `;
    div.querySelector('.abono-del').addEventListener('click', e => { e.stopPropagation(); promptDeleteExtra(realIdx); });
    list.appendChild(div);
  });
}

let pendingDeleteExtraIdx = null;
function promptDeleteExtra(idx) {
  const p = getP(); if (!p || idx < 0 || idx >= p.extras.length) return;
  const x = p.extras[idx];
  pendingDeleteExtraIdx = idx;
  document.getElementById('del-abono-text').textContent = `Préstamo adicional de ${cop(x.amount)} — ${fmtDate(x.date)}. Esta acción no se puede deshacer.`;
  document.getElementById('del-abono-modal').classList.add('open');
}

function addExtra() {
  const p = getP(); if (!p || p.interes !== 0) return;
  const amountEl = document.getElementById('d-extra-amount');
  const noteEl   = document.getElementById('d-extra-note');
  const errEl    = document.getElementById('d-extra-err');

  amountEl.classList.remove('error');
  if (errEl) errEl.textContent = '';

  const amount = parseAmount(amountEl.value);
  const note   = san(noteEl.value, SEC.ABONO_NOTE_MAX);

  if (!amount) {
    amountEl.classList.add('error');
    if (errEl) errEl.textContent = 'Ingresa un valor válido';
    amountEl.focus();
    return;
  }

  if (!note || !isRealText(note)) {
    noteEl.classList.add('error');
    showToast('La descripción no parece ser real', 'error');
    noteEl.focus();
    return;
  }

  if (!p.extras) p.extras = [];
  p.extras.push({ id: uid(), amount, note, date: Date.now() });
  saveData();
  
  closeExtraModal();
  renderDetail();
  showToast(`Préstamo adicional de ${cop(amount)} registrado ✓`);
}

/* ─── ABONOS ─── */
function addAbono() {
  const p = getP(); if (!p) return;
  const amountEl = document.getElementById('d-abono-amount');
  const errEl    = document.getElementById('d-abono-err');

  amountEl.classList.remove('error');
  errEl.textContent = '';

  const amount = parseAmount(amountEl.value);

  if (!amount) {
    amountEl.classList.add('error');
    errEl.textContent = 'Ingresa un valor válido';
    amountEl.focus();
    return;
  }

  const saldoActual = calcSaldo(p);
  if (amount > saldoActual) {
    amountEl.classList.add('error');
    errEl.textContent = `El abono no puede ser mayor al saldo (${cop(saldoActual)})`;
    showToast('El abono supera el saldo pendiente', 'error');
    amountEl.focus();
    return;
  }

  if (p.abonos.length >= SEC.ABONOS_MAX) { showToast('Límite de abonos alcanzado', 'error'); return; }

  p.abonos.push({ id: uid(), amount, note: '', date: Date.now() });
  saveData();

  closeAbonoModal();

  const wasPagado = isPagado(p);
  renderDetail();
  if (wasPagado) showToast('🎉 ¡Préstamo completamente pagado!');
  else showToast(`Abono de ${cop(amount)} registrado ✓`);
}

function promptDeleteAbono(idx) {
  const p = getP(); if (!p || idx < 0 || idx >= p.abonos.length) return;
  const a = p.abonos[idx];
  pendingDeleteAbonoIdx = idx;
  document.getElementById('del-abono-text').textContent = `Abono de ${cop(a.amount)} — ${fmtDate(a.date)}. Esta acción no se puede deshacer.`;
  document.getElementById('del-abono-modal').classList.add('open');
}
function closeDelAbonoModal() { pendingDeleteAbonoIdx = null; pendingDeleteExtraIdx = null; document.getElementById('del-abono-modal').classList.remove('open'); }
function confirmDeleteAbono() {
  const p = getP(); if (!p) return;
  if (pendingDeleteExtraIdx !== null) {
    p.extras.splice(pendingDeleteExtraIdx, 1);
    pendingDeleteExtraIdx = null;
  } else if (pendingDeleteAbonoIdx !== null) {
    p.abonos.splice(pendingDeleteAbonoIdx, 1);
    pendingDeleteAbonoIdx = null;
  }
  saveData(); closeDelAbonoModal(); renderDetail();
}

function openEditInicialModal() {
  const p = getP(); if (!p) return;
  editingType = 'inicial';
  editingAbonoIdx = null;
  document.getElementById('edit-abono-amount').value = p.monto;
  document.getElementById('edit-abono-note').value = p.nota || '';
  document.getElementById('edit-abono-note-wrap').style.display = 'block';
  document.getElementById('edit-abono-modal').classList.add('open');
  setTimeout(() => document.getElementById('edit-abono-amount').focus(), 80);
}

function openEditExtraModal(idx) {
  const p = getP(); if (!p || idx < 0 || idx >= (p.extras||[]).length) return;
  const x = p.extras[idx];
  editingType = 'extra';
  editingAbonoIdx = idx;
  document.getElementById('edit-abono-amount').value = x.amount;
  document.getElementById('edit-abono-note').value = x.note || '';
  document.getElementById('edit-abono-note-wrap').style.display = 'block';
  document.getElementById('edit-abono-modal').classList.add('open');
  setTimeout(() => document.getElementById('edit-abono-amount').focus(), 80);
}

function openEditAbonoModal(idx) {
  const p = getP(); if (!p || idx < 0 || idx >= p.abonos.length) return;
  const a = p.abonos[idx];
  editingAbonoIdx = idx;
  editingType = 'abono';
  document.getElementById('edit-abono-amount').value = a.amount;
  document.getElementById('edit-abono-note').value = a.note || '';
  document.getElementById('edit-abono-note-wrap').style.display = 'none';
  document.getElementById('edit-abono-modal').classList.add('open');
  setTimeout(() => document.getElementById('edit-abono-amount').focus(), 80);
}
function closeEditAbonoModal() { editingAbonoIdx = null; editingType = null; document.getElementById('edit-abono-modal').classList.remove('open'); }
function saveEditAbono() {
  const p = getP(); if (!p) return;
  const amountInp = document.getElementById('edit-abono-amount');
  const amount = parseAmount(amountInp.value);
  const noteEl = document.getElementById('edit-abono-note');
  const note   = san(noteEl.value, SEC.ABONO_NOTE_MAX);
  
  if (!amount) { flash(amountInp); return; }
  
  // La nota es obligatoria para Préstamo Inicial y Préstamos Extras, pero ya no existe para Abonos
  const isAbono = (editingType === 'abono');
  
  if (!isAbono) {
    if (!note || !isRealText(note)) {
      noteEl.classList.add('error');
      showToast('La descripción no parece ser real', 'error');
      noteEl.focus();
      return;
    }
  } else {
    // Validar que el nuevo monto del abono no supere el saldo (sin contar el abono actual)
    const abonoActual = p.abonos[editingAbonoIdx];
    const saldoSinEsteAbono = calcSaldo(p) + abonoActual.amount;
    if (amount > saldoSinEsteAbono) {
      amountInp.classList.add('error');
      showToast(`El abono no puede superar el saldo (${cop(saldoSinEsteAbono)})`, 'error');
      amountInp.focus();
      return;
    }
  }

  if (editingType === 'inicial') {
    p.monto = amount;
    p.nota  = note;
  } else if (editingType === 'extra') {
    if (editingAbonoIdx === null || editingAbonoIdx >= (p.extras||[]).length) return;
    p.extras[editingAbonoIdx] = { ...p.extras[editingAbonoIdx], amount, note };
  } else {
    // abono
    if (editingAbonoIdx === null || editingAbonoIdx >= p.abonos.length) return;
    p.abonos[editingAbonoIdx] = { ...p.abonos[editingAbonoIdx], amount, note };
  }
  saveData(); closeEditAbonoModal(); renderDetail();
}

/* ─── EDITAR TÍTULO ─── */
function startEditTitle() {
  document.getElementById('detail-title').style.display = 'none';
  const inp = document.getElementById('detail-title-input');
  inp.style.display = 'block'; inp.focus(); inp.select();
}
function saveTitle() {
  const p = getP(); if (!p) return;
  const inp = document.getElementById('detail-title-input');
  const val = san(inp.value, SEC.NAME_MAX);
  if (isRealText(val)) { 
    p.nombre = val; 
    saveData(); 
  } else {
    showToast('El nombre no parece ser real', 'error');
  }
  document.getElementById('detail-title').textContent = p.nombre;
  inp.style.display = 'none';
  document.getElementById('detail-title').style.display = '';
}

/* ─── COMPARTIR / PDF ─── */
async function shareFactura() {
  const p = getP(); if (!p) return;

  // Esperar a que jsPDF esté disponible
  if (typeof window.jspdf === 'undefined') {
    showToast('Cargando generador PDF…');
    await new Promise(res => setTimeout(res, 800));
    if (typeof window.jspdf === 'undefined') { showToast('No se pudo cargar jsPDF', 'error'); return; }
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, margin = 18;
  const col = margin, colR = W - margin;
  const contentW = W - margin * 2;
  let y = 0;

  // ── Paleta ──
  const C = {
    bg:      [18, 18, 18],
    surface: [26, 26, 26],
    surface2:[32, 32, 32],
    border:  [44, 44, 44],
    accent:  [200, 255, 87],
    blue:    [87, 200, 255],
    red:     [255, 87, 87],
    text:    [239, 239, 239],
    muted:   [120, 120, 120],
    muted2:  [68, 68, 68],
    white:   [255, 255, 255],
  };

  // ── Helpers ──
  function setFill(rgb) { doc.setFillColor(...rgb); }
  function setTxt(rgb)  { doc.setTextColor(...rgb); }
  function setDraw(rgb) { doc.setDrawColor(...rgb); }
  function rect(x, yy, w, h, style='F') { doc.rect(x, yy, w, h, style); }
  function line(x1, y1, x2, y2) { doc.line(x1, y1, x2, y2); }
  function txt(text, x, yy, opts={}) {
    doc.text(String(text), x, yy, opts);
  }
  function rowPair(label, value, yy, labelColor, valueColor, bold=false) {
    setTxt(labelColor); doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    txt(label, col, yy);
    setTxt(valueColor); doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(bold ? 10 : 9);
    txt(value, colR, yy, { align: 'right' });
  }

  // ── Fondo página completo ──
  setFill(C.bg); rect(0, 0, W, 297);

  // ── HEADER ──
  setFill(C.surface); rect(0, 0, W, 42);
  // Línea accent izquierda
  setFill(C.accent); rect(0, 0, 4, 42);
  // Título
  setTxt(C.accent); doc.setFont('helvetica', 'bold'); doc.setFontSize(22);
  txt('Control de Préstamos', col + 6, 16);
  setTxt(C.muted); doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  txt('Pesos colombianos · ' + new Date().toLocaleDateString('es-CO', {day:'2-digit',month:'long',year:'numeric'}), col + 6, 23);
  // Nombre deudor (derecha)
  setTxt(C.white); doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
  txt(p.nombre, colR, 15, { align: 'right' });
  setTxt(C.muted); doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  txt('Desde ' + fmtDate(p.createdAt), colR, 22, { align: 'right' });
  // Badge estado
  const pagado = isPagado(p);
  const badgeColor = pagado ? C.blue : C.accent;
  const badgeTxt = pagado ? 'PAGADO' : 'ACTIVO';
  setFill(badgeColor); rect(colR - 22, 27, 22, 8, 'F');
  setTxt(C.bg); doc.setFont('helvetica', 'bold'); doc.setFontSize(7);
  txt(badgeTxt, colR - 11, 32.5, { align: 'center' });

  y = 52;

  // ── SECCIÓN RESUMEN ──
  const totalDue = calcTotalDue(p);
  const abonado  = calcTotalAbonado(p);
  const saldo    = calcSaldo(p);
  const pct      = totalDue > 0 ? Math.min(100, Math.round((abonado / totalDue) * 100)) : 0;

  // Card resumen
  setFill(C.surface); rect(margin, y, contentW, p.interes > 0 ? 46 : 30, 'F');
  setDraw(C.border); doc.setLineWidth(0.3); rect(margin, y, contentW, p.interes > 0 ? 46 : 30, 'S');
  // Borde izquierdo accent
  setFill(C.accent); rect(margin, y, 3, p.interes > 0 ? 46 : 30);

  const ry = y + 9;
  if (p.interes > 0) {
    rowPair('Monto prestado', cop(p.monto), ry, C.muted, C.text);
    setTxt(C.muted); doc.setFont('helvetica','normal'); doc.setFontSize(8);
    txt(`Interes (${p.interes}%)`, col + 4, ry+9);
    setTxt(C.red); doc.setFont('helvetica','normal'); doc.setFontSize(9);
    txt(cop(calcInterest(p.monto, p.interes)), colR, ry+9, {align:'right'});
    // Línea divisoria
    setDraw(C.border); doc.setLineWidth(0.2); line(margin+4, ry+14, colR, ry+14);
    rowPair('Total a pagar', cop(totalDue), ry+21, C.muted, C.accent, true);
    y += 46;
  } else {
    rowPair('Monto total prestado', cop(calcMontoTotal(p)), ry, C.muted, C.text);
    y += 30;
  }
  y += 6;

  // ── BARRA DE PROGRESO ──
  setFill(C.surface); rect(margin, y, contentW, 16, 'F');
  setDraw(C.border); doc.setLineWidth(0.3); rect(margin, y, contentW, 16, 'S');
  const barX = margin + 4, barY = y + 5, barW = contentW - 8, barH = 4;
  setFill(C.muted2); rect(barX, barY, barW, barH);
  const fillW = Math.max(0, barW * pct / 100);
  setFill(pagado ? C.blue : C.accent); rect(barX, barY, fillW, barH);
  setTxt(C.muted); doc.setFont('helvetica','normal'); doc.setFontSize(7.5);
  txt(`${pct}% pagado`, barX, y + 13);
  setTxt(pagado ? C.blue : C.accent); doc.setFont('helvetica','bold'); doc.setFontSize(7.5);
  txt(`Saldo: ${cop(saldo)}`, colR, y + 13, {align:'right'});
  y += 22;

  // ── TOTALES RÁPIDOS ──
  const halfW = (contentW - 4) / 2;
  // Card saldo pendiente
  setFill(C.surface); rect(margin, y, halfW, 20, 'F');
  setDraw(C.border); doc.setLineWidth(0.3); rect(margin, y, halfW, 20, 'S');
  setFill(pagado ? C.blue : C.accent); rect(margin, y, 3, 20);
  setTxt(C.muted); doc.setFont('helvetica','normal'); doc.setFontSize(7.5);
  txt('Saldo pendiente', margin + 6, y + 7);
  setTxt(pagado ? C.blue : C.text); doc.setFont('helvetica','bold'); doc.setFontSize(11);
  txt(pagado ? 'Saldado' : cop(saldo), margin + 6, y + 16);
  // Card total abonado
  const cx = margin + halfW + 4;
  setFill(C.surface); rect(cx, y, halfW, 20, 'F');
  setDraw(C.border); doc.setLineWidth(0.3); rect(cx, y, halfW, 20, 'S');
  setFill(C.blue); rect(cx, y, 3, 20);
  setTxt(C.muted); doc.setFont('helvetica','normal'); doc.setFontSize(7.5);
  txt('Total abonado', cx + 6, y + 7);
  setTxt(C.blue); doc.setFont('helvetica','bold'); doc.setFontSize(11);
  txt(cop(abonado), cx + 6, y + 16);
  y += 26;

  // ── MOVIMIENTOS ──
  setTxt(C.accent); doc.setFont('helvetica','bold'); doc.setFontSize(8);
  txt('MOVIMIENTOS', col, y); y += 5;
  setDraw(C.accent); doc.setLineWidth(0.4); line(col, y, col + 28, y); y += 5;

  // Construir timeline
  const timeline = [];
  timeline.push({ type:'inicial', data:{ amount:p.monto, note:p.nota||'', date:p.createdAt } });
  (p.extras||[]).forEach((x,i) => timeline.push({ type:'extra', data:x, num:i+1 }));
  p.abonos.forEach((a,i) => timeline.push({ type:'abono', data:a, num:i+1 }));
  timeline.sort((a,b) => b.data.date - a.data.date);

  const rowH = 10;
  timeline.forEach((entry, i) => {
    if (y > 270) { doc.addPage(); setFill(C.bg); rect(0,0,W,297); y = 18; }
    const { type, data } = entry;
    const isEven = i % 2 === 0;

    // Fondo alternado
    setFill(isEven ? C.surface : C.surface2);
    rect(margin, y, contentW, rowH);
    // Borde izquierdo según tipo
    const lineColor = type === 'abono' ? C.blue : type === 'extra' ? C.accent : C.muted;
    setFill(lineColor); rect(margin, y, 3, rowH);

    // Fecha
    setTxt(C.muted); doc.setFont('helvetica','normal'); doc.setFontSize(7.5);
    txt(fmtDateShort(data.date), col + 5, y + 6.5);

    // Etiqueta
    const label = data.note
      ? data.note
      : type === 'inicial' ? 'Prestamo inicial'
      : type === 'extra'   ? `Prestamo adicional #${entry.num}`
      : `Abono #${entry.num}`;
    setTxt(C.text); doc.setFont('helvetica', type==='abono'?'normal':'bold'); doc.setFontSize(8.5);
    // Truncar si es muy largo
    const maxLabelW = contentW - 52;
    let labelStr = label;
    while (doc.getTextWidth(labelStr) > maxLabelW && labelStr.length > 4) labelStr = labelStr.slice(0,-1);
    if (labelStr !== label) labelStr += '…';
    txt(labelStr, col + 26, y + 6.5);

    // Monto (derecha)
    const sign = type === 'abono' ? '-' : '+';
    setTxt(type==='abono' ? C.blue : type==='extra' ? C.accent : C.muted);
    doc.setFont('helvetica','bold'); doc.setFontSize(8.5);
    txt(sign + cop(data.amount), colR, y + 6.5, { align:'right' });

    y += rowH;
  });

  // ── FOOTER ──
  if (y > 260) { doc.addPage(); setFill(C.bg); rect(0,0,W,297); y = 18; }
  y += 6;
  setDraw(C.border); doc.setLineWidth(0.3); line(col, y, colR, y); y += 6;
  setTxt(C.muted); doc.setFont('helvetica','normal'); doc.setFontSize(7);
  txt('Generado con Control de Prestamos COP', col, y);
  txt(new Date().toLocaleString('es-CO'), colR, y, {align:'right'});

  // ── GUARDAR / COMPARTIR ──
  const filename = `prestamo_${p.nombre.replace(/\s+/g,'_')}_${Date.now()}.pdf`;
  const blob = doc.output('blob');
  const file = new File([blob], filename, { type: 'application/pdf' });

  if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ title: 'Préstamo: ' + p.nombre, files: [file] }); return; }
    catch(e) { if (e.name === 'AbortError') return; }
  }
  // Fallback: descarga directa
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  showToast('PDF generado y descargado ✓');
}

/* ─── HELPERS UI ─── */
function flash(el) {
  if (!el) return;
  el.style.borderColor = '#ff5757';
  setTimeout(() => el.style.borderColor = '', 800);
}

function updateCharCounter(inputId, counterId, max) {
  const inp = document.getElementById(inputId);
  const ctr = document.getElementById(counterId);
  if (!inp || !ctr) return;
  const len = inp.value.length;
  ctr.textContent = `${len}/${max}`;
  ctr.className = 'char-counter' + (len >= max ? ' limit' : len >= max*0.85 ? ' warn' : '');
}

/* ─── EVENTOS MODALES (click fuera) ─── */
['del-modal','del-abono-modal','edit-abono-modal','extra-modal','abono-modal'].forEach(id => {
  document.getElementById(id)?.addEventListener('click', e => {
    if (e.target === e.currentTarget) {
      if (id === 'del-modal') closeModal();
      else if (id === 'del-abono-modal') closeDelAbonoModal();
      else if (id === 'edit-abono-modal') closeEditAbonoModal();
      else if (id === 'extra-modal') closeExtraModal();
      else if (id === 'abono-modal') closeAbonoModal();
    }
  });
});

/* ─── TECLADO ─── */
document.addEventListener('keydown', e => {
  if (document.getElementById('login').classList.contains('active')) {
    if (e.key >= '0' && e.key <= '9') pinPress(e.key);
    if (e.key === 'Backspace') pinDel();
    return;
  }
  if (e.key === 'Enter') {
    const a = document.activeElement;
    if (a && (a.id === 'd-abono-amount' || a.id === 'd-abono-note')) { e.preventDefault(); addAbono(); }
    if (a && (a.id === 'd-extra-amount' || a.id === 'd-extra-note')) { e.preventDefault(); addExtra(); }
    if (a && a.id === 'new-name') { e.preventDefault(); createPrestamo(); }
    if (a && (a.id === 'edit-abono-amount' || a.id === 'edit-abono-note')) { e.preventDefault(); saveEditAbono(); }
  }
  if (e.key === 'Escape') { 
    closeModal(); 
    closeDelAbonoModal(); 
    closeEditAbonoModal(); 
    closeExtraModal();
    closeAbonoModal();
  }
});

/* ─── INIT ─── */
document.addEventListener('DOMContentLoaded', () => {
  // Vincular teclado PIN
  document.querySelectorAll('.pin-key').forEach(btn => {
    const digit = btn.textContent.trim();
    btn.addEventListener('click', () => pinPress(digit));
  });
  document.querySelector('.pin-key-del')?.addEventListener('click', pinDel);

  // Inputs: límites y contadores
  document.getElementById('new-name')?.addEventListener('input', () => {
    updateCharCounter('new-name', 'new-name-counter', SEC.NAME_MAX);
  });

  // Validar solo letras en campos de nota/nombre
  ['new-name', 'new-note', 'd-extra-note', 'd-abono-note', 'edit-abono-note', 'detail-title-input'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;

    el.addEventListener('keydown', e => {
      // Bloquear números del teclado principal y del teclado numérico
      if ((e.key >= '0' && e.key <= '9')) {
        e.preventDefault();
      }
    });

    el.addEventListener('keypress', e => {
      // Bloquear números explícitamente (0-9)
      if (/[0-9]/.test(e.key)) {
        e.preventDefault();
        return;
      }
      // Solo permitir letras y espacios (bloquea símbolos y emojis al escribir)
      if (!/[\p{L}\s]/u.test(e.key)) {
        // Permitir teclas de control (Backspace, Delete, ArrowKeys, etc. - aunque keypress no suele disparar para estas)
        if (e.key.length > 1) return; 
        e.preventDefault();
      }
    });

    el.addEventListener('input', function() {
      // Guardar posición del cursor
      const start = this.selectionStart;
      
      // Aplicar limpieza en tiempo real:
      // 1. Quitar lo que no sea letra o espacio
      let val = this.value.replace(/[^\p{L}\s]/gu, '');
      // 2. No permitir más de 2 caracteres idénticos seguidos
      val = val.replace(/(.)\1{2,}/gu, '$1$1');
      // 3. No permitir espacios dobles
      val = val.replace(/\s{2,}/g, ' ');

      if (this.value !== val) {
        this.value = val;
        // Restaurar posición del cursor (aproximada)
        this.setSelectionRange(start, start);
      }
      
      // Actualizar contadores si existen
      if (id === 'new-name') updateCharCounter('new-name', 'new-name-counter', SEC.NAME_MAX);
    });

    el.addEventListener('paste', e => {
      const pasteData = e.clipboardData.getData('text');
      // Limpiar el texto pegado antes de insertarlo
      let clean = pasteData.replace(/[^\p{L}\s]/gu, '')
                           .replace(/(.)\1{2,}/gu, '$1$1')
                           .replace(/\s{2,}/g, ' ');
      
      if (clean !== pasteData) {
        e.preventDefault();
        const start = el.selectionStart;
        const end = el.selectionEnd;
        const text = el.value;
        el.value = text.slice(0, start) + clean + text.slice(end);
        el.setSelectionRange(start + clean.length, start + clean.length);
      }
    });
  });

  document.getElementById('new-amount')?.addEventListener('input', updateInterestPreview);
  document.getElementById('new-interest-custom')?.addEventListener('input', updateInterestPreview);

  // Cortar monto si supera máximo y solo números
  ['new-amount','d-abono-amount','edit-abono-amount','d-extra-amount'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', function() {
      if (parseFloat(this.value) > SEC.AMOUNT_MAX) this.value = SEC.AMOUNT_MAX;
    });
    el.addEventListener('keypress', e => {
      if (!/[\d]/.test(e.key)) e.preventDefault();
    });
    // Prevenir pegar texto no numérico
    el.addEventListener('paste', e => {
      const pasteData = e.clipboardData.getData('text');
      if (!/^\d+$/.test(pasteData)) e.preventDefault();
    });
  });

  initPinState();
});