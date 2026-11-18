#!/usr/bin/env python3
"""Resumen de resultados de pruebas para GitHub Actions (Prácticas 13 y 14).

    python3 ci_report.py flutter test-results.json "Pruebas de la app"
    python3 ci_report.py junit   test-results.xml  "Pruebas de la API"

Lee la salida de `flutter test --machine` (JSON por línea) o un reporte JUnit XML
(`node --test --test-reporter=junit`) y:
  - imprime cada prueba con su resultado y tiempo en el log del job;
  - agrega una tabla al resumen del run ($GITHUB_STEP_SUMMARY);
  - crea anotaciones ::error con archivo y línea por cada prueba fallida y una
    ::notice con los totales, visibles en la pestaña del commit y del pull request.
No cambia el código de salida: el paso de pruebas es el que decide si el job falla.
"""
import json
import os
import sys
import xml.etree.ElementTree as ET


def esc(s):
    return str(s).replace('%', '%25').replace('\r', '').replace('\n', '%0A')


def from_flutter(path):
    suites, tests, results, errors = {}, {}, [], {}
    total_ms = None
    for line in open(path, encoding='utf-8', errors='replace'):
        line = line.strip()
        if not line.startswith('{'):
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        t = e.get('type')
        if t == 'suite':
            suites[e['suite']['id']] = e['suite'].get('path') or ''
        elif t == 'testStart':
            tests[e['test']['id']] = dict(e['test'], _t=e.get('time', 0))
        elif t == 'error':
            errors.setdefault(e['testID'], []).append(e.get('error', ''))
        elif t == 'testDone' and not e.get('hidden'):
            info = tests.get(e['testID'], {})
            start = info.get('_t', 0)
            results.append({
                'file': os.path.relpath(suites.get(info.get('suiteID'), ''), os.getcwd()) if suites.get(info.get('suiteID')) else '',
                'line': info.get('root_line') or info.get('line'),
                'name': info.get('name', '?'),
                'status': 'omitida' if e.get('skipped') else ('aprobada' if e.get('result') == 'success' else 'fallida'),
                'ms': max(0, e.get('time', 0) - start),
                'error': '\n'.join(errors.get(e['testID'], [])),
            })
        elif t == 'done':
            total_ms = e.get('time')
    return results, total_ms


def from_junit(path):
    root = ET.parse(path).getroot()
    results = []
    for case in root.iter('testcase'):
        fail = case.find('failure')
        if fail is None:
            fail = case.find('error')
        skipped = case.find('skipped') is not None
        results.append({
            'file': case.get('file', '').replace(os.getcwd() + '/', ''),
            'line': case.get('line'),
            'name': case.get('name', '?'),
            'status': 'omitida' if skipped else ('fallida' if fail is not None else 'aprobada'),
            'ms': round(float(case.get('time') or 0) * 1000),
            'error': '' if fail is None else (fail.get('message') or fail.text or ''),
        })
    import re
    m = re.findall(r'duration_ms ([\d.]+)', open(path, encoding='utf-8').read())  # comentario que agrega node --test
    return results, (round(sum(float(x) for x in m)) if m else None)


def main():
    kind, path, title = sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else 'Pruebas'
    if not os.path.exists(path):
        print(f'::error::No se generó {path}: las pruebas no llegaron a ejecutarse (revisa el paso anterior).')
        return
    results, total_ms = from_flutter(path) if kind == 'flutter' else from_junit(path)
    ok = [r for r in results if r['status'] == 'aprobada']
    bad = [r for r in results if r['status'] == 'fallida']
    skip = [r for r in results if r['status'] == 'omitida']
    secs = f'{total_ms / 1000:.1f} s' if total_ms else 'n/d'

    print(f'== {title}: {len(results)} ejecutadas · {len(ok)} aprobadas · {len(bad)} fallidas · {len(skip)} omitidas · {secs} ==')
    for r in results:
        mark = {'aprobada': 'OK  ', 'fallida': 'FALLA', 'omitida': 'OMIT'}[r['status']]
        print(f"  {mark} {r['ms']:>6} ms  {r['file']}  {r['name']}")
    for r in bad:
        loc = f"file={r['file']},line={r['line']}," if r['file'] and r['line'] else (f"file={r['file']}," if r['file'] else '')
        print(f"::error {loc}title={esc('Falla: ' + r['name'][:120])}::{esc(r['error'][:1500] or 'Prueba fallida')}")
    level = 'error' if bad else 'notice'
    print(f'::{level} title={esc(title)}::{len(ok)} aprobadas, {len(bad)} fallidas, {len(skip)} omitidas de {len(results)} en {secs}')

    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as f:
            f.write(f'### {title}\n\n| Ejecutadas | Aprobadas | Fallidas | Omitidas | Tiempo |\n|---|---|---|---|---|\n')
            f.write(f'| {len(results)} | {len(ok)} | {len(bad)} | {len(skip)} | {secs} |\n\n')
            if bad:
                f.write('**Pruebas fallidas**\n\n')
                for r in bad:
                    first = (r['error'].strip().splitlines() or [''])[0][:200]
                    f.write(f"- `{r['file']}:{r['line']}` {r['name']} — {first}\n")
                f.write('\n')
            f.write('<details><summary>Detalle de todas las pruebas</summary>\n\n| Resultado | Archivo | Prueba | ms |\n|---|---|---|---|\n')
            for r in results:
                f.write(f"| {r['status']} | {r['file']} | {r['name'].replace('|', '/')} | {r['ms']} |\n")
            f.write('\n</details>\n\n')


if __name__ == '__main__':
    main()
