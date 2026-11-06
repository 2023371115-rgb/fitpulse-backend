/**
 * Motor de búsqueda de texto completo al estilo Elasticsearch, en memoria.
 *
 *  - Índice invertido: término → documentos y frecuencia por campo.
 *  - Análisis: minúsculas, sin acentos, sin palabras vacías, raíz simple en español
 *    ("caminatas" → "caminat") para que plural y singular coincidan.
 *  - Puntuación BM25 (la misma familia de fórmula que usa Elasticsearch) con
 *    "boost" por campo (el título pesa más que la descripción).
 *  - Coincidencia por prefijo mientras se escribe ("corr" → "correr")
 *    y difusa (fuzzy) por distancia de Levenshtein para errores de dedo ("bisicleta").
 *  - Resaltado (<em>…</em>), agregaciones (facetas por índice) y sugerencia
 *    "¿Quisiste decir…?" cuando no hay resultados exactos.
 *
 * Los documentos de cada usuario son pocos (cientos), así que el índice se construye
 * por petición en milisegundos y siempre está al día con la base de datos.
 */

const STOPWORDS = new Set(
  'a al ante con contra de del desde el en entre es la las lo los mi mis o para por que se sin sobre su sus te tu un una unos unas y ya the of and'.split(' ')
);

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** Quita acentos y pasa a minúsculas: "Natación" → "natacion". */
function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Igual que fold() pero conserva la longitud del texto, para poder resaltar sobre el original. */
function foldKeepLength(text) {
  const s = String(text ?? '');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const f = c.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    out += f.length === 1 ? f : (c.toLowerCase().length === 1 ? c.toLowerCase() : c);
  }
  return out;
}

/** Raíz muy simple para español: quita plurales y terminaciones frecuentes. */
function stem(token) {
  if (token.length <= 4 || /^\d/.test(token)) return token;
  for (const suf of ['aciones', 'iciones', 'mente', 'ciones', 'cion', 'es', 's']) {
    if (token.endsWith(suf) && token.length - suf.length >= 4) return token.slice(0, -suf.length);
  }
  return token;
}

/** Texto → lista de términos analizados (con su posición original para resaltar). */
function analyze(text) {
  const out = [];
  const re = /[\p{L}\p{N}]+/gu;
  const folded = foldKeepLength(text);
  let m;
  while ((m = re.exec(folded))) {
    const raw = m[0];
    if (STOPWORDS.has(raw)) continue;
    out.push({ term: stem(raw), raw, start: m.index, end: m.index + raw.length });
  }
  return out;
}

/** Distancia de Levenshtein con corte temprano (máximo `max`). */
function levenshtein(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Errores permitidos según la longitud, como el "fuzziness: AUTO" de Elasticsearch. */
function autoFuzziness(term) {
  if (term.length <= 3) return 0;
  if (term.length <= 6) return 1;
  return 2;
}

class SearchIndex {
  /**
   * @param {Record<string, number>} boosts peso de cada campo, p. ej. { title: 3, body: 1 }
   */
  constructor(boosts) {
    this.boosts = boosts;
    this.docs = [];
    this.postings = new Map(); // term → Map(docIdx → { field: tf })
    this.fieldLength = {}; // field → longitud total, para el promedio de BM25
  }

  /** @param {{ _index: string, _id: string, fields: Record<string,string>, source: object }} doc */
  add(doc) {
    const idx = this.docs.length;
    const lengths = {};
    for (const [field, text] of Object.entries(doc.fields)) {
      const tokens = analyze(text);
      lengths[field] = tokens.length;
      this.fieldLength[field] = (this.fieldLength[field] || 0) + tokens.length;
      for (const { term } of tokens) {
        if (!this.postings.has(term)) this.postings.set(term, new Map());
        const perDoc = this.postings.get(term);
        const tf = perDoc.get(idx) || {};
        tf[field] = (tf[field] || 0) + 1;
        perDoc.set(idx, tf);
      }
    }
    this.docs.push({ ...doc, lengths });
  }

  /** Términos del índice que corresponden a un término de la consulta (exacto, prefijo o difuso). */
  expand(qTerm, isLast) {
    const out = [];
    const exact = this.postings.has(qTerm.term);
    if (exact) out.push({ term: qTerm.term, weight: 1, kind: 'exact' });
    const fuzz = autoFuzziness(qTerm.raw);
    for (const term of this.postings.keys()) {
      if (term === qTerm.term) continue;
      if (isLast && qTerm.raw.length >= 2 && term.startsWith(qTerm.raw)) {
        out.push({ term, weight: 0.8, kind: 'prefix' });
      } else if (fuzz > 0) {
        const d = levenshtein(qTerm.term, term, fuzz);
        if (d <= fuzz) out.push({ term, weight: d === 1 ? 0.6 : 0.4, kind: 'fuzzy' });
      }
    }
    return out;
  }

  /**
   * @param {string} q consulta
   * @param {{ size?: number, indices?: string[] }} opts
   */
  search(q, { size = 20, indices } = {}) {
    const t0 = process.hrtime.bigint();
    const qTerms = analyze(q);
    const N = this.docs.length || 1;
    const scores = new Map(); // docIdx → { score, matched: Set(qTermIdx), terms: Set }
    const fuzzyUsed = [];

    qTerms.forEach((qt, qi) => {
      const variants = this.expand(qt, qi === qTerms.length - 1);
      if (!variants.some(v => v.kind === 'exact') && variants.length) fuzzyUsed.push({ from: qt.raw, to: variants[0].term });
      for (const v of variants) {
        const perDoc = this.postings.get(v.term);
        const idf = Math.log(1 + (N - perDoc.size + 0.5) / (perDoc.size + 0.5));
        for (const [docIdx, tfByField] of perDoc) {
          const doc = this.docs[docIdx];
          if (indices && !indices.includes(doc._index)) continue;
          let s = 0;
          for (const [field, tf] of Object.entries(tfByField)) {
            const avg = (this.fieldLength[field] || 1) / N;
            const len = doc.lengths[field] || 1;
            const norm = tf * (BM25_K1 + 1) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * len / avg));
            s += idf * norm * (this.boosts[field] || 1);
          }
          const cur = scores.get(docIdx) || { score: 0, matched: new Set(), terms: new Set() };
          cur.score += s * v.weight;
          cur.matched.add(qi);
          cur.terms.add(v.term);
          scores.set(docIdx, cur);
        }
      }
    });

    // Operador "and" suave: los documentos que contienen todos los términos van primero.
    const ranked = [...scores.entries()]
      .map(([docIdx, s]) => ({ docIdx, ...s, score: s.score * (s.matched.size / (qTerms.length || 1)) ** 2 }))
      .sort((a, b) => b.score - a.score);

    const aggregations = {};
    for (const r of ranked) {
      const index = this.docs[r.docIdx]._index;
      aggregations[index] = (aggregations[index] || 0) + 1;
    }

    const hits = ranked.slice(0, size).map(r => {
      const doc = this.docs[r.docIdx];
      return {
        _index: doc._index,
        _id: doc._id,
        _score: Math.round(r.score * 1000) / 1000,
        _source: doc.source,
        highlight: highlight(doc.fields, r.terms),
      };
    });

    let suggestion = null;
    if (!ranked.length && qTerms.length) suggestion = this.suggest(qTerms);
    const took = Number(process.hrtime.bigint() - t0) / 1e6;

    return {
      took: Math.round(took * 100) / 100,
      query: q,
      hits: { total: ranked.length, max_score: hits[0]?._score ?? null, hits },
      aggregations: { by_index: aggregations },
      suggestion,
      fuzzy: fuzzyUsed.length ? fuzzyUsed : undefined,
    };
  }

  /** "¿Quisiste decir…?": el término del índice más parecido a cada palabra. */
  suggest(qTerms) {
    const words = qTerms.map(qt => {
      let best = null;
      for (const term of this.postings.keys()) {
        const d = levenshtein(qt.term, term, 3);
        if (d <= 3 && (!best || d < best.d)) best = { term, d };
      }
      return best ? best.term : qt.raw;
    });
    const s = words.join(' ');
    return s === qTerms.map(q => q.raw).join(' ') ? null : s;
  }
}

/** Envuelve en <em> las palabras que coincidieron (sobre el texto original, con acentos). */
function highlight(fields, terms) {
  const out = {};
  for (const [field, text] of Object.entries(fields)) {
    const original = String(text ?? '');
    const tokens = analyze(original).filter(t => terms.has(t.term));
    if (!tokens.length) continue;
    let html = '';
    let pos = 0;
    for (const t of tokens) {
      html += escapeHtml(original.slice(pos, t.start)) + '<em>' + escapeHtml(original.slice(t.start, t.end)) + '</em>';
      pos = t.end;
    }
    html += escapeHtml(original.slice(pos));
    out[field] = [html.length > 220 ? snippet(html) : html];
  }
  return out;
}

function snippet(html) {
  const i = html.indexOf('<em>');
  const start = Math.max(0, i - 80);
  return (start > 0 ? '…' : '') + html.slice(start, start + 220) + '…';
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

module.exports = { SearchIndex, analyze, fold, stem, levenshtein };
