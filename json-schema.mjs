// Minimal JSON Schema 2020-12 validator, no dependencies. It covers the keywords that the Restep 1
// schemas use (schema/discovery.json and problem.json): type, enum, const,
// required, properties, patternProperties, additionalProperties, propertyNames, items,
// prefixItems, contains, minItems, maxItems, uniqueItems, minLength, maxLength, pattern, minimum,
// maximum, exclusiveMinimum, exclusiveMaximum, allOf, anyOf, oneOf, not, if/then/else, $ref
// local (#/…) and the date-time format. Other keywords are ignored, as the standard requires
// for annotations.

export function validate(schema, value) {
  const errors = [];
  check(schema, value, '', schema, errors);
  return errors;
}

function check(schema, v, at, root, errors) {
  if (schema === true || schema === undefined) return;
  if (schema === false) { errors.push({ at, message: 'no value is allowed here' }); return; }
  const err = (message) => errors.push({ at: at || '/', message });

  if (typeof schema.$ref === 'string') {
    if (!schema.$ref.startsWith('#')) err(`external $ref not supported: ${schema.$ref}`);
    else check(pointer(root, schema.$ref.slice(1)), v, at, root, errors);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => isType(v, t))) { err(`expected ${types.join(' or ')}`); return; }
  }
  if (schema.enum && !schema.enum.some((e) => equal(e, v))) err(`value not allowed ${JSON.stringify(v)} (allowed: ${schema.enum.map((e) => JSON.stringify(e)).join(', ')})`);
  if ('const' in schema && !equal(schema.const, v)) err(`must be ${JSON.stringify(schema.const)}`);

  if (typeof v === 'string') {
    const len = [...v].length;
    if (schema.minLength !== undefined && len < schema.minLength) err(`string shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && len > schema.maxLength) err(`string longer than ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(v)) err(`"${v}" does not match pattern ${schema.pattern}`);
    if (schema.format === 'date-time' && !/^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(v)) err(`"${v}" is not an RFC 3339 date-time`);
  }
  if (typeof v === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) err(`less than minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && v > schema.maximum) err(`greater than maximum ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === 'number' && v <= schema.exclusiveMinimum) err(`must be greater than ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === 'number' && v >= schema.exclusiveMaximum) err(`must be less than ${schema.exclusiveMaximum}`);
  }
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) err(`fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && v.length > schema.maxItems) err(`more than ${schema.maxItems} items`);
    if (schema.uniqueItems && v.some((x, i) => v.findIndex((y) => equal(x, y)) !== i)) err('duplicate items');
    const prefix = schema.prefixItems ?? [];
    prefix.forEach((s, i) => { if (i < v.length) check(s, v[i], `${at}/${i}`, root, errors); });
    if (schema.items !== undefined) v.forEach((x, i) => { if (i >= prefix.length) check(schema.items, x, `${at}/${i}`, root, errors); });
    if (schema.contains !== undefined && !v.some((x) => validateSub(schema.contains, x, root))) err('no item matches "contains"');
  }
  if (isObject(v)) {
    for (const k of schema.required ?? []) if (!(k in v)) err(`missing required member "${k}"`);
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
        for (const e of sub) errors.push({ at: p, message: `invalid member name: ${e.message}` });
      }
    }
  }
  for (const s of schema.allOf ?? []) check(s, v, at, root, errors);
  if (schema.anyOf && !schema.anyOf.some((s) => validateSub(s, v, root))) err('matches no anyOf alternative');
  if (schema.oneOf) {
    const n = schema.oneOf.filter((s) => validateSub(s, v, root)).length;
    if (n !== 1) err(n === 0 ? 'matches no oneOf alternative' : 'matches more than one oneOf alternative');
  }
  if (schema.not !== undefined && validateSub(schema.not, v, root)) err('matches the "not" schema');
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
  if (cur === undefined) throw new Error(`$ref has no target: #${p}`);
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
