#!/usr/bin/env node
/**
 * Resumen de resultados de pruebas para GitHub Actions (Prácticas 13 y 14).
 *
 *   node .github/scripts/ci_report.js flutter test-results.json "Pruebas de la app"
 *   node .github/scripts/ci_report.js junit   test-results.xml  "Pruebas de la API"
 *
 * Lee la salida de `flutter test --machine` (un JSON por línea) o un reporte JUnit
 * (`node --test --test-reporter=junit`) y:
 *  - imprime cada prueba con su resultado y tiempo en el log del job;
 *  - agrega una tabla al resumen del run ($GITHUB_STEP_SUMMARY);
 *  - crea una anotación ::error con archivo y línea por cada prueba fallida y una
 *    ::notice con los totales (se ven en el commit y en el pull request).
 * No cambia el código de salida: el paso de pruebas es el que decide si el job falla.
 * Solo usa módulos de Node, así funciona igual en Linux y en un runner de Windows.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const esc = s => String(s).replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
const rel = p => (p ? path.relative(process.cwd(), p.replace(/^file:\/\/\/?/, '')).split(path.sep).join('/') : '');

function fromFlutter(file) {
  const raw = fs.readFileSync(file);
  // PowerShell 5 escribe UTF-16; cmd y bash, UTF-8
  const text = raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8');
  const suites = {}, tests = {}, errors = {}, results = [];
  let total = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'suite') suites[e.suite.id] = e.suite.path || '';
    else if (e.type === 'testStart') tests[e.test.id] = { ...e.test, t0: e.time || 0 };
    else if (e.type === 'error') (errors[e.testID] ||= []).push(e.error || '');
    else if (e.type === 'print' && e.testID != null) (errors[e.testID] ||= []).push(e.message || ''); // excepciones de Flutter
    else if (e.type === 'testDone' && !e.hidden) {
      const t = tests[e.testID] || {};
      results.push({
        file: rel(suites[t.suiteID]), line: t.root_line || t.line, name: t.name || '?',
        status: e.skipped ? 'omitida' : e.result === 'success' ? 'aprobada' : 'fallida',
        ms: Math.max(0, (e.time || 0) - (t.t0 || 0)), error: (errors[e.testID] || []).filter(x => !/^Test failed\. See exception logs above/.test(x)).join('\n'),
      });
    } else if (e.type === 'done') total = e.time;
  }
  return { results, total };
}

function fromJunit(file) {
  const xml = fs.readFileSync(file, 'utf8');
  const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`)); return m ? m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : ''; };
  const results = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const head = m[1], inner = m[3] || '';
    const fail = inner.match(/<(failure|error)\b([^>]*)>?([\s\S]*?)(<\/\1>|$)/);
    results.push({
      file: rel(attr(head, 'file')), line: attr(head, 'line'), name: attr(head, 'name') || '?',
      status: /<skipped\b/.test(inner) ? 'omitida' : fail ? 'fallida' : 'aprobada',
      ms: Math.round(Number(attr(head, 'time') || 0) * 1000),
      error: fail ? (attr(fail[0], 'message') || fail[3] || '').trim() : '',
    });
  }
  const d = [...xml.matchAll(/duration_ms ([\d.]+)/g)].reduce((a, x) => a + Number(x[1]), 0);
  return { results, total: d || null };
}

const [kind, file, title = 'Pruebas'] = process.argv.slice(2);
if (!fs.existsSync(file)) {
  console.log(`::error::No se generó ${file}: las pruebas no llegaron a ejecutarse (revisa el paso anterior).`);
  process.exit(0);
}
const { results, total } = kind === 'flutter' ? fromFlutter(file) : fromJunit(file);
const by = s => results.filter(r => r.status === s);
const ok = by('aprobada'), bad = by('fallida'), skip = by('omitida');
const secs = total ? `${(total / 1000).toFixed(1)} s` : 'n/d';

console.log(`== ${title}: ${results.length} ejecutadas · ${ok.length} aprobadas · ${bad.length} fallidas · ${skip.length} omitidas · ${secs} ==`);
for (const r of bad) { console.log(`---- ${r.name}`); console.log(r.error.slice(0, 4000)); }
for (const r of results) console.log(`  ${{ aprobada: 'OK   ', fallida: 'FALLA', omitida: 'OMIT ' }[r.status]} ${String(r.ms).padStart(6)} ms  ${r.file}  ${r.name}`);
for (const r of bad) {
  const loc = r.file ? `file=${r.file},${r.line ? `line=${r.line},` : ''}` : '';
  console.log(`::error ${loc}title=${esc('Falla: ' + r.name.slice(0, 120))}::${esc(r.error.slice(0, 3000) || 'Prueba fallida')}`);
}
console.log(`::${bad.length ? 'error' : 'notice'} title=${esc(title)}::${ok.length} aprobadas, ${bad.length} fallidas, ${skip.length} omitidas de ${results.length} en ${secs}`);

if (process.env.GITHUB_STEP_SUMMARY) {
  let md = `### ${title}\n\n| Ejecutadas | Aprobadas | Fallidas | Omitidas | Tiempo |\n|---|---|---|---|---|\n| ${results.length} | ${ok.length} | ${bad.length} | ${skip.length} | ${secs} |\n\n`;
  if (bad.length) md += '**Pruebas fallidas**\n\n' + bad.map(r => `- \`${r.file}:${r.line}\` ${r.name} — ${(r.error.trim().split('\n')[0] || '').slice(0, 200)}`).join('\n') + '\n\n';
  md += '<details><summary>Detalle de todas las pruebas</summary>\n\n| Resultado | Archivo | Prueba | ms |\n|---|---|---|---|\n';
  md += results.map(r => `| ${r.status} | ${r.file} | ${r.name.replace(/\|/g, '/')} | ${r.ms} |`).join('\n') + '\n\n</details>\n\n';
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}
