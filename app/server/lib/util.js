// Small shared utilities — deterministic hashing so enrichment results are
// stable for a given input (no Math.random, which would make the demo flaky).

export function hashString(str) {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// Deterministic float in [0,1) from a seed string.
export function seededUnit(seed) {
  return (hashString(seed) % 100000) / 100000;
}

export function pick(arr, seed) {
  return arr[hashString(seed) % arr.length];
}

// Monotonic timestamp without Date.now() (unavailable in some sandboxes).
// Shared by the store, sequences and analytics so event ordering is consistent.
let _ts = 1751000000000;
export function nextTs() {
  _ts += 37000; // ~37s apart so charts have visible spread
  return _ts;
}

export function slug(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

export function domainFromCompany(company) {
  const s = slug(company);
  return s ? `${s}.com` : '';
}

export function id(prefix = 'id') {
  // Monotonic-ish id without Date.now(): combine a counter + hash.
  id._c = (id._c || 0) + 1;
  return `${prefix}_${(id._c).toString(36)}${hashString(prefix + id._c).toString(36)}`;
}

// Very small CSV parser (handles quoted fields and commas). Good enough for
// the bulk-enrichment upload flow without pulling a dependency.
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (r[idx] || '').trim(); });
    return obj;
  });
}
