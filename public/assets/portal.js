// DSI Internal Operations Portal — shared client utilities
// Used by Loading, Painting, Robotic Welding, and Manager Dashboard pages.
// QC (public/index.html) is independent and untouched.

(function (global) {
  'use strict';

  const STORE_KEYS = {
    loading: 'dsi_rows_loading',
    painting: 'dsi_rows_painting',
    welding: 'dsi_rows_welding',
    qc: 'dsi_rows_qc' // reserved for future QC sync; not written by QC today
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function loadProjects() {
    try {
      const res = await fetch('/projects.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      return Array.isArray(data.projects) ? data.projects : [];
    } catch (e) {
      console.error('Failed to load projects.json', e);
      return [];
    }
  }

  function populateProjectSelect(select, projects, placeholder) {
    if (!select) return;
    select.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = '';
    opt.disabled = true;
    opt.selected = true;
    opt.textContent = placeholder || 'Select project number…';
    select.appendChild(opt);
    projects.forEach(p => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name || p.id;
      o.dataset.airtable = p.airtableUrl || '';
      o.dataset.excel = p.excelUrl || '';
      select.appendChild(o);
    });
  }

  function readRows(section) {
    const key = STORE_KEYS[section];
    if (!key) return [];
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.warn('Storage read failed for', section, e);
      return [];
    }
  }

  function writeRows(section, rows) {
    const key = STORE_KEYS[section];
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify(rows));
    } catch (e) {
      console.warn('Storage write failed', e);
    }
  }

  function addRow(section, row) {
    const rows = readRows(section);
    rows.unshift(row);
    writeRows(section, rows);
    return rows;
  }

  function readAllSections() {
    return {
      loading: readRows('loading'),
      painting: readRows('painting'),
      welding: readRows('welding')
    };
  }

  function toast(msg, type) {
    let t = document.getElementById('dsi-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'dsi-toast';
      t.className = 'dsi-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'dsi-toast show ' + (type || 'success');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.className = 'dsi-toast'; }, 3500);
  }

  // Image preview — matches the QC pattern (Cloudinary upload optional;
  // here we keep it purely client-side preview so the new sections stay
  // session-based, with no server writes).
  function bindImageUpload(opts) {
    const drop = document.getElementById(opts.dropId);
    const input = document.getElementById(opts.inputId);
    const preview = document.getElementById(opts.previewId);
    const thumb = document.getElementById(opts.thumbId);
    const nameEl = document.getElementById(opts.nameId);
    if (!drop || !input || !preview || !thumb) return;

    function onPick() {
      const file = input.files && input.files[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        toast('Please choose an image file', 'error');
        input.value = '';
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        toast('Image must be under 5MB', 'error');
        input.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = e => {
        thumb.src = e.target.result;
        if (nameEl) nameEl.textContent = file.name + ' (' + Math.round(file.size / 1024) + ' KB)';
        preview.style.display = 'block';
        drop.style.display = 'none';
      };
      reader.readAsDataURL(file);
    }

    drop.addEventListener('click', () => input.click());
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.background = '#202832'; });
    drop.addEventListener('dragleave', () => { drop.style.background = ''; });
    drop.addEventListener('drop', e => {
      e.preventDefault();
      drop.style.background = '';
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      const dt = new DataTransfer();
      dt.items.add(f);
      input.files = dt.files;
      onPick();
    });
    input.addEventListener('change', onPick);

    const clearBtn = preview.querySelector('button');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        input.value = '';
        preview.style.display = 'none';
        drop.style.display = 'block';
      });
    }
  }

  function statusClass(status) {
    if (!status) return 'neutral';
    const s = String(status).toLowerCase();
    if (/^(accepted|completed|delivered|dispatched)$/.test(s)) return 'ok';
    if (/^(loaded)$/.test(s)) return 'info';
    if (/^(rejected|failed|returned|rework)$/.test(s)) return 'err';
    if (/^(reworked|pending|partial|on hold|in progress|not started|re-coated|recoated|touch-up)$/.test(s)) return 'warn';
    if (/completed|delivered|dispatched|accepted/.test(s) && !/partial/.test(s)) return 'ok';
    if (/loaded/.test(s)) return 'info';
    if (/rejected|failed|returned|rework/.test(s)) return 'err';
    if (/reworked|pending|partial|on hold|in progress|not started/.test(s)) return 'warn';
    return 'neutral';
  }

  // ─── Batch parser ─────────────────────────────────────────────────────────
  // Accepts a multi-line worker entry and returns a normalised list.
  // Supported per-line formats:
  //   RF1(12)         RF1 (12)         RF1 [12]
  //   RF1 x 12        RF1 X 12         RF1*12
  //   RF1, 12         RF1 - 12
  //   RF1             (defaults qty=1)
  // Commas, semicolons, and newlines all separate entries. Whitespace and
  // empty lines are ignored. A bare quantity number after a UID (eg "RF1 12")
  // is also accepted.
  function parseBatch(text) {
    const items = [];
    const errors = [];
    if (!text || typeof text !== 'string') {
      return { items, totalQty: 0, errors };
    }
    // Normalise separators: comma, semicolon, newline → newline.
    const lines = text.replace(/[;]/g, ',')
                      .split(/[\r\n]+/)
                      .flatMap(l => l.split(/,(?![^()]*\))/)) // split on commas not inside ()
                      .map(s => s.trim())
                      .filter(Boolean);

    // Regex covers all the accepted shapes; quantity defaults to 1.
    const re = /^([A-Za-z0-9][A-Za-z0-9_\-./]*)\s*(?:[\(\[]\s*(\d+)\s*[\)\]]|\s*[x\*]\s*(\d+)|\s*[-]\s*(\d+)|\s+(\d+))?$/i;

    lines.forEach((line, idx) => {
      const m = line.match(re);
      if (!m) { errors.push({ line: idx + 1, text: line, reason: 'unrecognised format' }); return; }
      const uid = m[1].toUpperCase();
      const qtyRaw = m[2] || m[3] || m[4] || m[5];
      const qty = qtyRaw ? parseInt(qtyRaw, 10) : 1;
      if (!Number.isFinite(qty) || qty < 1 || qty > 9999) {
        errors.push({ line: idx + 1, text: line, reason: 'quantity must be 1–9999' });
        return;
      }
      items.push({ uid, qty });
    });

    const totalQty = items.reduce((s, it) => s + it.qty, 0);
    return { items, totalQty, errors };
  }

  // Serialise a parsed batch back into a canonical multi-line "UID x QTY" form
  // for storage in the "Parsed UIDs" Airtable column.
  function serialiseBatch(items) {
    if (!Array.isArray(items)) return '';
    return items.map(it => `${it.uid} x ${it.qty}`).join('\n');
  }

  // ─── JSON helper ──────────────────────────────────────────────────────────
  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* ignore */ }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  async function getJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    let data = null;
    try { data = await res.json(); } catch (e) { /* ignore */ }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  // ─── Cloudinary unsigned upload (same preset used by the QC page) ────────
  const CLOUDINARY_CLOUD = 'dfex176he';
  const CLOUDINARY_PRESET = 'umwnwbli';
  function uploadImage(file) {
    return new Promise(function (resolve, reject) {
      if (!file) return resolve(null);
      const form = new FormData();
      form.append('file', file);
      form.append('upload_preset', CLOUDINARY_PRESET);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD + '/image/upload');
      xhr.timeout = 30000;
      xhr.onload = function () {
        if (xhr.status === 200) {
          try { resolve(JSON.parse(xhr.responseText).secure_url); }
          catch (e) { reject(new Error('Image upload returned invalid JSON')); }
        } else { reject(new Error('Image upload failed: ' + xhr.status)); }
      };
      xhr.onerror = function () { reject(new Error('Image upload network error')); };
      xhr.ontimeout = function () { reject(new Error('Image upload timed out — try a smaller image')); };
      xhr.send(form);
    });
  }

  // Generate a date-based batch id, e.g. LD-20260520-XKJ4
  function genBatchId(prefix) {
    const d = new Date();
    const ymd = d.getFullYear().toString() +
                String(d.getMonth() + 1).padStart(2, '0') +
                String(d.getDate()).padStart(2, '0');
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `${prefix}-${ymd}-${rand}`;
  }

  function formatDate(d) {
    if (!d) return '';
    return String(d);
  }

  function genId(prefix) {
    return prefix + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  }

  function shortTime(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      const opts = { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' };
      return d.toLocaleString(undefined, opts);
    } catch (e) { return iso; }
  }

  global.DSI = {
    esc,
    loadProjects,
    populateProjectSelect,
    readRows,
    writeRows,
    addRow,
    readAllSections,
    toast,
    bindImageUpload,
    statusClass,
    formatDate,
    genId,
    shortTime,
    STORE_KEYS,
    // batch + server helpers
    parseBatch,
    serialiseBatch,
    postJson,
    getJson,
    uploadImage,
    genBatchId
  };
})(window);
