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
    if (/(accepted|completed|dispatched|loaded)\b/.test(s) && !/partial/.test(s)) return 'ok';
    if (/(rejected|failed)\b/.test(s)) return 'err';
    if (/(reworked|partial|on hold|in progress|re-coated|recoated|touch-up)/.test(s)) return 'warn';
    return 'neutral';
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
    STORE_KEYS
  };
})(window);
