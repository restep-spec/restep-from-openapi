// Validador JSON Schema 2020-12 mínimo, sin dependencias. Cubre las palabras clave que usan los
// esquemas de Restep 1 (schema/discovery.json y problem.json): type, enum, const,
// required, properties, patternProperties, additionalProperties, propertyNames, items,
// prefixItems, contains, minItems, maxItems, uniqueItems, minLength, maxLength, pattern, minimum,
// maximum, exclusiveMinimum, exclusiveMaximum, allOf, anyOf, oneOf, not, if/then/else, $ref
// locales (#/…) y format date-time. Las demás palabras clave se ignoran, como manda la norma
// para las anotaciones.

export function validate(schema, value) {
  const errors = [];
  check(schema, value, '', schema, errors);
  return errors;
}

function check(schema, v, at, root, errors) {
  if (schema === true || schema === undefined) return;
  if (schema === false) { errors.push({ at, message: 'no se admite ningún valor aquí' }); return; }
  const err = (message) => errors.push({ at: at || '/', message });

  if (typeof schema.$ref === 'string') {
    if (!schema.$ref.startsWith('#')) err(`$ref externo no admitido: ${schema.$ref}`);
    else check(pointer(root, schema.$ref.slice(1)), v, at, root, errors);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => isType(v, t))) { err(`se esperaba ${types.join(' o ')}`); return; }
  }
  if (schema.enum && !schema.enum.some((e) => equal(e, v))) err(`valor no permitido ${JSON.stringify(v)} (admite ${schema.enum.map((e) => JSON.stringify(e)).join(', ')})`);
  if ('const' in schema && !equal(schema.const, v)) err(`debe valer ${JSON.stringify(schema.const)}`);

  if (typeof v === 'string') {
    const len = [...v].length;
    if (schema.minLength !== undefined && len < schema.minLength) err(`cadena más corta que ${schema.minLength}`);
    if (schema.maxLength !== undefined && len > schema.maxLength) err(`cadena más larga que ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(v)) err(`«${v}» no cumple el patrón ${schema.pattern}`);
    if (schema.format === 'date-time' && !/^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(v)) err(`«${v}» no es un date-time del RFC 3339`);
  }
  if (typeof v === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) err(`menor que el mínimo ${schema.minimum}`);
    if (schema.maximum !== undefined && v > schema.maximum) err(`mayor que el máximo ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === 'number' && v <= schema.exclusiveMinimum) err(`debe ser mayor que ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === 'number' && v >= schema.exclusiveMaximum) err(`debe ser menor que ${schema.exclusiveMaximum}`);
  }
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) err(`menos de ${schema.minItems} elementos`);
    if (schema.maxItems !== undefined && v.length > schema.maxItems) err(`más de ${schema.maxItems} elementos`);
    if (schema.uniqueItems && v.some((x, i) => v.findIndex((y) => equal(x, y)) !== i)) err('hay elementos repetidos');
    const prefix = schema.prefixItems ?? [];
    prefix.forEach((s, i) => { if (i < v.length) check(s, v[i], `${at}/${i}`, root, errors); });
    if (schema.items !== undefined) v.forEach((x, i) => { if (i >= prefix.length) check(schema.items, x, `${at}/${i}`, root, errors); });
    if (schema.contains !== undefined && !v.some((x) => validateSub(schema.contains, x, root))) err('ningún elemento cumple «contains»');
  }
  if (isObject(v)) {
    for (const k of schema.required ?? []) if (!(k in v)) err(`falta el miembro obligatorio «${k}»`);
    for (const [k, x] of Object.entries(v)) {
      const p = `${at}/${escape(k)}`;
      let matched = false;
      if (schema.properties && k in schema.properties) { matched = true; check(schema.properties[k], x, p, root, errors); }
      for (const [re, s] of Object.entries(schema.patternProperties ?? {}))
        if (new RegExp(re, 'u').test(k)) { matched = true; check(s, x, p, root, errors); }
      if (!matched && schema.additionalProperties !== undefined) check(schema.additionalProperties, x, p, root, errors);
      if (schema.propertyNames !== undefined) {
        const sub = [];
        check(schema.propertyNames, k, p, root, sub);
        for (const e of sub) errors.push({ at: p, message: `nombre de miembro no válido: ${e.message}` });
      }
    }
  }
  for (const s of schema.allOf ?? []) check(s, v, at, root, errors);
  if (schema.anyOf && !schema.anyOf.some((s) => validateSub(s, v, root))) err('no cumple ninguna alternativa de anyOf');
  if (schema.oneOf) {
    const n = schema.oneOf.filter((s) => validateSub(s, v, root)).length;
    if (n !== 1) err(n === 0 ? 'no cumple ninguna alternativa de oneOf' : 'cumple más de una alternativa de oneOf');
  }
  if (schema.not !== undefined && validateSub(schema.not, v, root)) err('cumple el esquema de «not»');
  if (schema.if !== undefined) {
    if (validateSub(schema.if, v, root)) { if (schema.then !== undefined) check(schema.then, v, at, root, errors); }
    else if (schema.else !== undefined) check(schema.else, v, at, root, errors);
  }
}

function validateSub(schema, v, root) {
  const e = [];
  check(schema, v, '', root, e);
  return e.length === 0;
}

function pointer(root, p) {
  let cur = root;
  for (const part of p.split('/').slice(1)) {
    const k = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~');
    cur = cur?.[k];
  }
  if (cur === undefined) throw new Error(`$ref sin destino: #${p}`);
  return cur;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const escape = (k) => k.replace(/~/g, '~0').replace(/\//g, '~1');

function isType(v, t) {
  switch (t) {
    case 'object': return isObject(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    default: return false;
  }
}

function equal(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => k in b && equal(a[k], b[k]));
}
