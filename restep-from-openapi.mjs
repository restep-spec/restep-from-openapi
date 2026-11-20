#!/usr/bin/env node
// restep-from-openapi: lee una API descrita en OpenAPI 3.0, 3.1 o 3.2 y dice qué le falta para
// cumplir Restep 1 (https://restep.wubytes.com/es/1/), perfil a perfil, y escribe un borrador de su
// documento de descubrimiento (§4.2). Node 18 o posterior, sin dependencias.
//
// Uso:
//   restep-from-openapi <openapi.json|openapi.yaml|URL> [--out discovery.json] [--report informe.md]
//                       [--json] [--no-schemas] [--no-annotations]
//
// Solo lee la descripción: no llama a la API. Para comprobar un servidor de verdad está restep-check.
import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseYaml } from './yaml.mjs';
import { validate } from './json-schema.mjs';

export { parseYaml, validate };

const VERSION = '0.1.0';
const SPEC = 'https://restep.wubytes.com/es/1/';
const SCHEMA_URL = 'https://restep.wubytes.com/1/schema/discovery.json';
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace', 'query'];
const PROFILES = ['core', 'query', 'writes', 'relations', 'sync'];

// Apartado de la spec → ancla de la página en español.
const ANCHORS = {
  '1.2': 'dependencias', '3': 'datos', '6': 'query', '7': 'writes', '10': 'extensiones', '4.1': 'cabecera-perfil', '4.2': 'descubrimiento', '4.3': 'describir', '4.4': 'salud',
  '5.1': 'recursos', '5.2': 'colecciones', '5.3': 'reservados', '5.4': 'errores', '5.5': 'versiones', '5.6': 'idioma',
  '6.1': 'filtros', '6.2': 'orden', '6.3': 'campos', '6.4': 'paginacion', '6.5': 'recuento',
  '7.1': 'idempotencia', '7.2': 'concurrencia', '7.3': 'cache', '7.4': 'respuesta-minima',
  '8': 'relations', '9': 'sync', '10.1': 'actions', '10.2': 'batch', '10.3': 'filter-expr', '10.4': 'query-method', '10.5': 'oauth',
};
export const sectionLink = (s) => `[§${s}](${SPEC}#${ANCHORS[s] ?? ''})`;

// ── Carga ───────────────────────────────────────────────────────────────────

export async function loadDocument(src) {
  let text;
  if (/^https?:\/\//i.test(src)) {
    let res;
    try { res = await fetch(src, { headers: { accept: 'application/json, application/yaml, text/yaml, */*' }, signal: AbortSignal.timeout(20000) }); }
    catch (e) { throw new Error(`No se pudo descargar ${src}: ${e.cause?.message ?? e.message}`); }
    if (!res.ok) throw new Error(`No se pudo descargar ${src}: respuesta ${res.status}.`);
    text = await res.text();
  } else {
    try { text = await readFile(src, 'utf8'); }
    catch (e) { throw new Error(e.code === 'ENOENT' ? `No existe el archivo ${src}.` : `No se pudo leer ${src}: ${e.message}`); }
  }
  return parseDocument(text, src);
}

export function parseDocument(text, name = 'documento') {
  const t = text.replace(/^﻿/, '').trimStart();
  let doc;
  if (t.startsWith('{')) {
    try { doc = JSON.parse(t); } catch (e) { throw new Error(`${name} no es JSON válido: ${e.message}`); }
  } else {
    try { doc = parseYaml(t); } catch (e) { throw new Error(`${name} no se puede leer como YAML: ${e.message}`); }
  }
  if (!isObject(doc)) throw new Error(`${name} no es un objeto OpenAPI.`);
  if (doc.swagger) throw new Error(`${name} es Swagger ${doc.swagger}; esta herramienta lee OpenAPI 3. Conviértelo antes (por ejemplo con https://converter.swagger.io/ o «npx swagger2openapi»).`);
  if (!/^3\.[0-2]/.test(String(doc.openapi ?? ''))) throw new Error(`${name} no declara «openapi: 3.x» (lleva ${JSON.stringify(doc.openapi ?? null)}).`);
  if (!isObject(doc.paths) && !isObject(doc.webhooks)) throw new Error(`${name} no tiene «paths».`);
  return doc;
}

// ── Utilidades ──────────────────────────────────────────────────────────────

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isParam = (seg) => /^\{[^}]+\}$/.test(seg);
const lc = (s) => String(s).toLowerCase();
const words = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s.]+/g, '_').toLowerCase();
const snake = (s) => words(s).replace(/[^a-z0-9_]/g, '').replace(/^[^a-z]+/, '').replace(/_+/g, '_').replace(/_$/, '');
const plural = (s) => (/(s|x|z|ch|sh)$/.test(s) ? s + 'es' : /[^aeiou]y$/.test(s) ? s.slice(0, -1) + 'ies' : s + 's');
const singular = (s) => (/ies$/.test(s) ? s.slice(0, -3) + 'y' : /(ses|xes|zes|ches|shes)$/.test(s) ? s.slice(0, -2) : /s$/.test(s) && !/ss$/.test(s) ? s.slice(0, -1) : s);
const firstSentence = (s) => {
  if (typeof s !== 'string') return null;
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  const out = m ? m[1] : t;
  return out.length > 240 ? out.slice(0, 237) + '…' : out;
};
const isJsonMedia = (m) => /^application\/(.+\+)?json\b/i.test(m) || m === '*/*';

const VERBS = new Set(['activate', 'add', 'adopt', 'apply', 'approve', 'archive', 'assign', 'authorize', 'block', 'book', 'calculate',
  'cancel', 'capture', 'charge', 'checkout', 'clone', 'close', 'complete', 'compute', 'confirm', 'convert', 'copy', 'deactivate',
  'decline', 'disable', 'dispatch', 'download', 'duplicate', 'enable', 'execute', 'export', 'finalize', 'fulfill', 'generate',
  'import', 'invite', 'lock', 'login', 'logout', 'mark', 'merge', 'move', 'notify', 'open', 'pause', 'pay', 'preview', 'print',
  'process', 'publish', 'purchase', 'reactivate', 'refresh', 'refund', 'register', 'reject', 'release', 'remove', 'rename', 'renew',
  'reopen', 'reserve', 'reset', 'resend', 'restore', 'resume', 'retry', 'return', 'revoke', 'run', 'schedule', 'send', 'ship',
  'sign', 'start', 'stop', 'submit', 'subscribe', 'suspend', 'test', 'transfer', 'trigger', 'unarchive', 'unblock', 'unlock',
  'unpublish', 'unsubscribe', 'upload', 'validate', 'verify', 'void', 'search', 'query', 'find', 'count', 'bulk', 'batch']);
const MONEY = /(price|amount|total|cost|balance|fee|subtotal|tax|vat|importe|precio|discount|payment|salary)/i;
const RESERVED_FIX = 'filter, sort, fields, include, count, limit, cursor, since y languages significan lo que dice Restep (5.3): sort lleva campos con «-» para descendente, '
  + 'count=true pide el total, limit es el tamaño de página, since es de sync y languages no se usa. Renombra el parámetro propio o dale el significado de Restep.';
const RPC_PREFIX = /^(get|list|fetch|create|update|delete|remove|set|add|do|find|search)[A-Z_]/;

// ── Análisis ────────────────────────────────────────────────────────────────

export function analyze(doc, options = {}) {
  const ctx = new Context(doc, options);
  ctx.run();
  return ctx.result();
}

class Context {
  constructor(doc, options) {
    this.doc = doc;
    this.options = options;
    this.findings = new Map();
    this.passes = [];
    this.unresolved = new Set();
    this.allFields = new Map(); // nombre de campo → dónde
  }

  // Un hallazgo: se agrupan los del mismo id y los lugares se acumulan.
  add(profile, id, severity, section, where, title, fix) {
    const key = id;
    let f = this.findings.get(key);
    if (!f) { f = { id, profile, severity, section, title, fix, where: [] }; this.findings.set(key, f); }
    for (const w of [].concat(where)) if (w && !f.where.includes(w)) f.where.push(w);
  }

  // Algo que ya cumple; se descarta al final si hay un hallazgo de alguno de los ids de `unless`.
  pass(profile, section, text, unless = []) {
    if (!this.passes.some((p) => p.profile === profile && p.text === text)) this.passes.push({ profile, section, text, unless });
  }

  // $ref locales (#/…). Los externos se anotan y se tratan como un esquema vacío.
  resolve(x, seen = new Set()) {
    while (isObject(x) && typeof x.$ref === 'string') {
      const ref = x.$ref;
      if (!ref.startsWith('#')) { this.unresolved.add(ref); return {}; }
      if (seen.has(ref)) return {};
      seen.add(ref);
      let cur = this.doc;
      for (const part of ref.slice(1).split('/').slice(1)) {
        const k = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~');
        cur = isObject(cur) || Array.isArray(cur) ? cur[k] : undefined;
      }
      if (cur === undefined) { this.unresolved.add(ref); return {}; }
      const { $ref, ...siblings } = x;
      x = Object.keys(siblings).length && isObject(cur) ? { ...cur, ...siblings } : cur;
    }
    return x;
  }

  refName(x) {
    const m = isObject(x) && typeof x.$ref === 'string' ? /^#\/components\/schemas\/(.+)$/.exec(x.$ref) : null;
    return m ? decodeURIComponent(m[1]).replace(/~1/g, '/').replace(/~0/g, '~') : null;
  }

  // Propiedades de un esquema de objeto, juntando allOf (y, con menos confianza, oneOf/anyOf).
  props(schema, depth = 0) {
    const s = this.resolve(schema);
    const out = {};
    if (!isObject(s) || depth > 8) return out;
    for (const part of s.allOf ?? []) Object.assign(out, this.props(part, depth + 1));
    for (const part of [...(s.oneOf ?? []), ...(s.anyOf ?? [])]) for (const [k, v] of Object.entries(this.props(part, depth + 1))) if (!(k in out)) out[k] = v;
    for (const [k, v] of Object.entries(s.properties ?? {})) out[k] = v;
    return out;
  }

  typeOf(schema) {
    const s = this.resolve(schema);
    if (!isObject(s)) return null;
    let t = s.type;
    if (Array.isArray(t)) t = t.find((x) => x !== 'null') ?? null;
    if (!t && s.properties) t = 'object';
    if (!t && s.items) t = 'array';
    if (!t && s.enum) t = typeof s.enum[0] === 'number' ? 'number' : 'string';
    if (!t && s.allOf) for (const p of s.allOf) { const x = this.typeOf(p); if (x) return x; }
    return t ?? null;
  }

  // El esquema JSON de una respuesta correcta, y su tipo de medio.
  successSchema(op, codes = ['200', '201', '2XX', '2xx', 'default']) {
    const responses = op.responses ?? {};
    for (const code of codes) {
      const r = this.resolve(responses[code]);
      if (!isObject(r)) continue;
      const content = r.content ?? {};
      const media = Object.keys(content).find(isJsonMedia);
      if (media) return { code, media, schema: content[media].schema, response: r };
      if (code !== 'default') return { code, media: null, schema: null, response: r };
    }
    return null;
  }

  headersOf(response) {
    return Object.fromEntries(Object.entries(this.resolve(response)?.headers ?? {}).map(([k, v]) => [lc(k), v]));
  }

  run() {
    const doc = this.doc;
    this.title = doc.info?.title ?? 'API sin título';
    this.apiVersion = doc.info?.version ?? null;
    this.openapi = String(doc.openapi);
    // Los $ref externos no se siguen: se anotan todos para el informe.
    const walk = (v, depth = 0) => {
      if (depth > 64 || v === null || typeof v !== 'object') return;
      if (typeof v.$ref === 'string' && !v.$ref.startsWith('#')) this.unresolved.add(v.$ref);
      for (const x of Object.values(v)) walk(x, depth + 1);
    };
    walk(doc);
    this.collectOperations();
    this.findRoot();
    this.classifyPaths();
    this.checkVersioning();
    this.checkSecurity();
    this.checkOperations();
    this.checkCollections();
    this.checkFields();
    this.checkSync();
    this.buildDiscovery();
  }

  collectOperations() {
    this.ops = [];
    for (const [rawPath, item0] of Object.entries(this.doc.paths ?? {})) {
      const item = this.resolve(item0);
      if (!isObject(item)) continue;
      const shared = (item.parameters ?? []).map((p) => this.resolve(p)).filter(isObject);
      const methods = [...HTTP_METHODS.filter((m) => isObject(item[m])).map((m) => [m.toUpperCase(), item[m]]),
        ...Object.entries(item.additionalOperations ?? {}).map(([m, o]) => [m.toUpperCase(), o])];
      for (const [method, op] of methods) {
        const own = (op.parameters ?? []).map((p) => this.resolve(p)).filter(isObject);
        const params = [...own];
        for (const p of shared) if (!own.some((q) => q.name === p.name && q.in === p.in)) params.push(p);
        this.ops.push({ method, rawPath, op, params, where: `${method} ${rawPath}` });
      }
    }
  }

  // La raíz de la API: servers[0] más un prefijo común con la versión (/api/v1) si todas las rutas lo llevan.
  findRoot() {
    const server = this.doc.servers?.[0];
    let url = server?.url ?? '/';
    for (const [k, v] of Object.entries(server?.variables ?? {})) url = url.replaceAll(`{${k}}`, v.default ?? '');
    const paths = [...new Set(this.ops.map((o) => o.rawPath))];
    let prefix = '';
    if (paths.length) {
      const split = paths.map((p) => p.split('/').filter(Boolean));
      const common = [];
      for (let i = 0; ; i++) {
        const seg = split[0][i];
        if (seg === undefined || isParam(seg) || seg.includes(':') || !split.every((s) => s[i] === seg && s.length > i + 1)) break;
        common.push(seg);
      }
      const v = common.findIndex((s) => /^v\d+([._-]\d+)*$/i.test(s));
      if (v >= 0) prefix = '/' + common.slice(0, v + 1).join('/');
    }
    this.prefix = prefix;
    this.root = url.replace(/\/+$/, '') + prefix + '/';
    for (const o of this.ops) o.path = prefix ? o.rawPath.slice(prefix.length) || '/' : o.rawPath;
    const m = /\/v(\d+)([._-]\d+)*\/$/i.exec(this.root);
    this.majorVersion = m && !m[2] ? m[1] : null;
    if (m && m[2]) this.add('core', 'core.version.path-format', 'warning', '5.5', `raíz ${this.root}`,
      'La versión de la ruta no es «v» seguida de un entero.',
      'Usa solo la versión mayor en la ruta (/v2/); las menores son cambios compatibles y no cambian la URL.');
    else if (this.majorVersion) this.pass('core', '5.5', `La versión mayor va en la ruta (/v${this.majorVersion}/).`);
  }

  // Clasifica cada ruta en colección, elemento, acción o recurso suelto.
  classifyPaths() {
    const byPath = new Map();
    for (const o of this.ops) { if (!byPath.has(o.path)) byPath.set(o.path, []); byPath.get(o.path).push(o); }
    this.byPath = byPath;
    const collections = new Map(); // ruta de colección → colección
    const ensure = (path) => {
      if (!collections.has(path)) collections.set(path, { path, ops: {}, itemPath: null, itemOps: {}, actions: [], children: [] });
      return collections.get(path);
    };
    const actions = [];
    const others = [];
    for (const [path, ops] of byPath) {
      const segs = path.split('/').filter(Boolean);
      const last = segs.at(-1) ?? '';
      const colon = /^(.*?):([A-Za-z][\w-]*)$/.exec(last);
      if (colon && segs.length) {
        const base = '/' + [...segs.slice(0, -1), colon[1]].join('/');
        for (const o of ops) actions.push({ base, name: colon[2], o, style: 'colon' });
        continue;
      }
      if (isParam(last)) {
        const parent = '/' + segs.slice(0, -1).join('/');
        const c = ensure(parent);
        c.itemPath = path;
        for (const o of ops) c.itemOps[o.method] = o;
        continue;
      }
      if (segs.length >= 2 && (VERBS.has(lc(last)) || VERBS.has(lc(words(last).split('_')[0]))) && !this.looksLikeCollection(ops)) {
        const base = '/' + segs.slice(0, -1).join('/');
        for (const o of ops) actions.push({ base, name: last, o, style: 'verb' });
        continue;
      }
      if (RPC_PREFIX.test(last)) {
        for (const o of ops) others.push({ o, rpc: true });
        continue;
      }
      if (segs.length === 0) { for (const o of ops) others.push({ o, root: true }); continue; }
      if (this.looksLikeCollection(ops) || [...byPath.keys()].some((p) => p.startsWith(path + '/{'))) {
        const c = ensure(path);
        for (const o of ops) c.ops[o.method] = o;
      } else for (const o of ops) others.push({ o });
    }
    // Colecciones que solo existen por sus elementos se quedan; las acciones se cuelgan de su base.
    this.collections = [...collections.values()].sort((a, b) => a.path.localeCompare(b.path));
    for (const a of actions) {
      const segs = a.base.split('/').filter(Boolean);
      const onItem = isParam(segs.at(-1));
      const cpath = onItem ? '/' + segs.slice(0, -1).join('/') : a.base;
      const c = collections.get(cpath);
      if (c) c.actions.push({ ...a, on: onItem ? 'item' : 'collection' });
      else others.push({ o: a.o, action: a });
    }
    // Subcolecciones: el padre es el elemento de otra colección.
    for (const c of this.collections) {
      const segs = c.path.split('/').filter(Boolean);
      if (segs.length >= 2 && isParam(segs.at(-2))) {
        const parent = collections.get('/' + segs.slice(0, -2).join('/'));
        if (parent) { c.parent = parent; parent.children.push(c); }
      }
    }
    // Nombres: el último segmento; si se repite, con el del padre delante.
    const used = new Map();
    for (const c of this.collections) {
      const last = c.path.split('/').filter(Boolean).at(-1) ?? 'root';
      c.segment = last;
      used.set(last, (used.get(last) ?? 0) + 1);
    }
    for (const c of this.collections) {
      c.name = used.get(c.segment) > 1 && c.parent ? `${c.parent.segment}_${c.segment}` : c.segment;
    }
    this.others = others;
  }

  looksLikeCollection(ops) {
    for (const o of ops) {
      if (o.method === 'POST') {
        const s = this.successSchema(o.op, ['201']);
        if (s) return true;
      }
      if (o.method === 'GET') {
        const s = this.successSchema(o.op);
        if (s?.schema && this.listShape(s.schema).kind !== 'object') return true;
      }
    }
    return false;
  }

  // Forma de la respuesta de una lista: array suelto, envoltorio con array o un objeto sin más.
  listShape(schema) {
    const s = this.resolve(schema);
    const t = this.typeOf(s);
    if (t === 'array') return { kind: 'array', itemSchema: s.items };
    if (t !== 'object') return { kind: 'object' };
    const props = this.props(s);
    const arrays = Object.keys(props).filter((k) => this.typeOf(props[k]) === 'array');
    if (!arrays.length) return { kind: 'object', props };
    const key = arrays.includes('items') ? 'items' : arrays.find((k) => /^(data|results|records|content|values|entries|list|elements|hits|rows)$/i.test(k)) ?? arrays[0];
    return { kind: 'envelope', key, itemSchema: this.resolve(props[key]).items, props };
  }

  checkVersioning() {
    for (const o of this.ops) {
      for (const p of o.params) {
        const n = lc(p.name ?? '');
        if (p.in === 'header' && /^(x-)?(api-)?version$|^accept-version$|^x-api-version$/.test(n))
          this.add('core', 'core.version.header', 'error', '5.5', `${o.where} (cabecera ${p.name})`,
            'La versión de la API va en una cabecera.', 'Restep pone la versión mayor en la ruta (/v2/), nunca en cabeceras, parámetros ni tipos de medio.');
        if (p.in === 'query' && /^(api[-_]?)?version$|^v$/.test(n))
          this.add('core', 'core.version.query', 'error', '5.5', `${o.where}?${p.name}`,
            'La versión de la API va en un parámetro de consulta.', 'Pon la versión mayor en la ruta (/v2/) y quita el parámetro.');
      }
      for (const r of Object.values(o.op.responses ?? {})) {
        for (const media of Object.keys(this.resolve(r)?.content ?? {}))
          if (/vnd\.[^;]*(\.v\d+|version=)|;\s*version=/i.test(media))
            this.add('core', 'core.version.media', 'error', '5.5', `${o.where} (${media})`,
              'La versión de la API va en el tipo de medio.', 'Usa application/json y pon la versión mayor en la ruta (/v2/).');
      }
    }
  }

  checkSecurity() {
    const schemes = Object.entries(this.doc.components?.securitySchemes ?? {}).map(([k, v]) => [k, this.resolve(v)]);
    this.oauth = schemes.some(([, s]) => s?.type === 'oauth2' || s?.type === 'openIdConnect');
    if (this.oauth) this.add('extensions', 'oauth.metadata', 'info', '10.5', schemes.filter(([, s]) => s?.type === 'oauth2' || s?.type === 'openIdConnect').map(([k]) => `securitySchemes.${k}`),
      'Usa OAuth 2.0: puede anunciar la extensión oauth.',
      'Sirve los metadatos de recurso protegido (RFC 9728) en /.well-known/oauth-protected-resource/<raíz> y pon resource_metadata en el reto de los 401 de la raíz.');
    for (const [k, s] of schemes)
      if (s?.type === 'apiKey' && s.in === 'query')
        this.add('extensions', 'oauth.query-token', 'warning', '10.5', `securitySchemes.${k} (?${s.name})`,
          'Las credenciales van en la query.', 'Mándalas en Authorization: una URL con el token acaba en registros y cachés (RFC 6750, 2.3).');
  }

  checkOperations() {
    let anyErrors = false, problem = false;
    for (const o of this.ops) {
      const { method, op, where } = o;
      if (method === 'PUT') this.add('core', 'core.put', 'error', '5.1', where,
        'Usa PUT para actualizar.', 'PUT queda fuera de Restep 1: ofrece PATCH con JSON Merge Patch (application/merge-patch+json), donde lo ausente no se toca.');
      if (method === 'PATCH') {
        const body = this.resolve(op.requestBody);
        const medias = Object.keys(body?.content ?? {}).map(lc);
        if (medias.includes('application/merge-patch+json')) this.pass('core', '5.1', 'PATCH acepta application/merge-patch+json.', ['core.patch.json-patch', 'core.patch.media']);
        else if (medias.some((m) => m.includes('json-patch'))) this.add('core', 'core.patch.json-patch', 'error', '5.1', where,
          'PATCH usa JSON Patch (RFC 6902) en vez de JSON Merge Patch.', 'Acepta application/merge-patch+json (RFC 7396): un objeto con los campos que cambian; null borra.');
        else this.add('core', 'core.patch.media', 'warning', '5.1', where,
          'PATCH no declara application/merge-patch+json.', 'Declara y acepta application/merge-patch+json; application/json con el mismo significado es opcional.');
      }
      // Errores
      const responses = Object.entries(op.responses ?? {});
      const errs = responses.filter(([code]) => /^[45]/.test(code) || code === 'default');
      if (!errs.length) this.add('core', 'core.error.missing', 'info', '5.4', where,
        'No declara respuestas de error.', 'Documenta al menos los 4xx que puede dar, con application/problem+json.');
      for (const [code, r0] of errs) {
        anyErrors = true;
        const r = this.resolve(r0);
        const content = r?.content ?? {};
        const medias = Object.keys(content);
        if (!medias.length) continue;
        const pj = medias.find((m) => lc(m) === 'application/problem+json');
        if (!pj) this.add('core', 'core.error.media', 'error', '5.4', `${where} → ${code} (${medias.join(', ')})`,
          'Los errores no son application/problem+json.', 'Responde los 4xx y 5xx con application/problem+json (RFC 9457) y los miembros type, title, status y code.');
        else {
          problem = true;
          const props = this.props(content[pj].schema);
          if (Object.keys(props).length && !('code' in props))
            this.add('core', 'core.error.code', 'warning', '5.4', `${where} → ${code}`,
              'El problem+json no tiene «code».', 'Añade code, con los valores de la tabla de 5.4 (not_found, invalid, conflict…).');
        }
      }
      // Errores dentro de un 200
      const ok = this.successSchema(op, ['200']);
      if (ok?.schema) {
        const props = this.props(ok.schema);
        if (('success' in props && this.typeOf(props.success) === 'boolean') || ('ok' in props && this.typeOf(props.ok) === 'boolean') || ('error' in props && 'data' in props))
          this.add('core', 'core.error.in-200', 'warning', '5.4', where,
            'La respuesta 200 lleva un indicador de éxito o error.', 'Un error nunca va en un 200: usa el estado HTTP y problem+json. Quita success/ok/error de los 200.');
      }
      // Credenciales en la query, idempotencia, condicionales
      for (const p of o.params) {
        const n = lc(p.name ?? '');
        if (p.in === 'header' && n === 'idempotency-key') this.pass('writes', '7.1', 'Los POST aceptan Idempotency-Key.', ['writes.idempotency', 'writes.idempotency-name']);
        if (p.in === 'query' && n.startsWith('$')) this.add('core', 'core.reserved.dollar', 'error', '5.3', `${where}?${p.name}`,
          'Usa parámetros que empiezan por «$» (estilo OData).', 'Los nombres con $ son de Restep. Pasa a filter[…], sort, fields y limit (6), o a nombres propios sin $.');
      }
      if (o.path.includes('//') || /\/$/.test(o.path) && o.path !== '/')
        this.add('core', 'core.path.slash', 'warning', '5.1', where, 'La ruta acaba en «/».', 'La ruta de una colección o un elemento no lleva «/» final (5.1).');
    }
    if (problem) this.pass('core', '5.4', 'Los errores van en application/problem+json.', ['core.error.media']);
    this.anyErrors = anyErrors;
    // Rutas que no son colecciones ni elementos
    for (const x of this.others) {
      if (x.root) continue;
      if (x.rpc && x.o.method === 'GET' && /^(find|search|list|get|fetch)/i.test(x.o.path.split('/').at(-1)) && x.o.path.split('/').filter(Boolean).length > 1)
        this.add('query', 'query.search-path', 'warning', '6.1', x.o.where, 'Una búsqueda tiene su propia ruta.',
          'Filtra sobre la propia colección: GET /pets?filter[status]=sold en vez de GET /pets/findByStatus?status=sold, con los filtros declarados en el descubrimiento.');
      else if (x.rpc) this.add('core', 'core.rpc-path', 'warning', '5.1', x.o.where,
        'La ruta es un nombre de procedimiento (estilo RPC).', 'Organiza la API en colecciones y elementos (/users, /users/7) con GET, POST, PATCH y DELETE; lo demás, como acciones (10.1).');
      else if (x.action) this.add('extensions', 'actions.verb-path', 'warning', '10.1', x.o.where,
        'Un verbo en la URL hace de acción.', `Decláralo como acción: ${x.o.method === 'GET' ? 'GET' : 'POST'} ${this.prefix}${x.action.base}:${snake(x.action.name)}.`);
      else if (/^\/?(health|healthz|status|ping|livez|readyz)$/i.test(x.o.path.replace(/^\//, ''))) this.statusPath = x.o.rawPath;
      else this.add('core', 'core.non-resource', 'info', '5.1', x.o.where,
        'Recurso que no es colección ni elemento.', 'Restep solo describe colecciones y sus elementos; un recurso suelto puede quedarse, pero no entra en el descubrimiento. Si es un único objeto (/me, /settings), valora una colección o una acción.');
    }
  }

  checkCollections() {
    const writes = this.ops.some((o) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(o.method));
    this.hasWrites = writes;
    for (const c of this.collections) {
      const get = c.ops.GET;
      // Forma de la lista (§5.2)
      if (get) {
        const s = this.successSchema(get.op);
        const shape = s?.schema ? this.listShape(s.schema) : null;
        c.shape = shape;
        if (!shape) this.add('core', 'core.list.unknown', 'info', '5.2', get.where, 'No se ve la forma de la respuesta de la lista.', 'Documenta el esquema: un objeto con items y next.');
        else if (shape.kind === 'array') this.add('core', 'core.list.array', 'error', '5.2', get.where,
          'La lista responde con un array suelto.', 'Responde con un objeto { "items": [...], "next": null }: así se puede paginar más tarde sin romper a nadie.');
        else if (shape.kind === 'envelope') {
          if (shape.key !== 'items') this.add('core', 'core.list.envelope', 'error', '5.2', `${get.where} (${shape.key})`,
            'La lista no lleva los elementos en «items».', `Renombra «${shape.key}» a «items».`);
          else this.pass('core', '5.2', 'Las listas llevan los elementos en «items».', ['core.list.envelope', 'core.list.array']);
          const p = shape.props;
          if ('next' in p) this.pass('core', '5.2', 'Las listas llevan «next».', ['core.list.next', 'core.list.array']);
          else {
            const alt = Object.keys(p).find((k) => /^(next_?(cursor|page|token|link|url)?|nextpagetoken|cursor|links|_links|pagination|meta|paging)$/i.test(k));
            this.add('core', 'core.list.next', 'error', '5.2', `${get.where}${alt ? ` (${alt})` : ''}`,
              'La lista no lleva «next».', 'Añade next, siempre presente: la URL de la página siguiente (con su cursor) o null.');
          }
          if (['page', 'total_pages', 'totalpages', 'page_count', 'pagecount', 'offset'].some((k) => Object.keys(p).map(lc).includes(k)))
            this.add('query', 'query.pagination.offset', 'error', '6.4', `${get.where} (respuesta)`, 'Pagina por desplazamiento o número de página.',
              'Pagina con un cursor opaco que viaja en next (6.4); el servidor puede guardar un desplazamiento dentro del cursor.');
          const total = Object.keys(p).find((k) => /^(total|total_?count|count|total_?items|total_?results)$/i.test(k));
          if (total) c.countField = total;
        }
        c.listItemSchema = shape?.itemSchema;
      }
      // POST
      const post = c.ops.POST;
      if (post) {
        const codes = Object.keys(post.op.responses ?? {});
        if (codes.includes('201')) {
          const h = this.headersOf(post.op.responses['201']);
          if (!h.location) this.add('core', 'core.post.location', 'warning', '5.1', post.where, 'El 201 no declara Location.', 'Un POST que crea responde 201 con Location y la representación del elemento.');
          else this.pass('core', '5.1', 'Los POST que crean responden 201 con Location.', ['core.post.status', 'core.post.location']);
        } else this.add('core', 'core.post.status', 'warning', '5.1', `${post.where} (${codes.join(', ')})`, 'Crear no responde 201.', 'Responde 201 con Location y la representación del elemento creado.');
        const body = this.resolve(post.op.requestBody)?.content;
        const bm = body && Object.keys(body).find(isJsonMedia);
        const bodyProps = bm ? this.props(body[bm].schema) : {};
        if ('id' in bodyProps && !this.resolve(bodyProps.id)?.readOnly)
          this.add('core', 'core.post.id', 'warning', '5.1', `${post.where} (${this.refName(body[bm].schema) ? `esquema ${this.refName(body[bm].schema)}` : 'cuerpo'})`,
            'El cuerpo de creación admite id.', 'El servidor asigna el id y responde 422 invalid a un POST que lo trae: quítalo del esquema del cuerpo o márcalo readOnly.');
        const h = post.params.find((p) => p.in === 'header' && /idempoten/i.test(p.name));
        if (!h) this.add('writes', 'writes.idempotency', 'warning', '7.1', post.where, 'Los POST no aceptan Idempotency-Key.',
          'Acepta Idempotency-Key (una cadena de Structured Fields) y devuelve la misma respuesta al repetir la petición.');
        else if (lc(h.name) !== 'idempotency-key') this.add('writes', 'writes.idempotency-name', 'warning', '7.1', `${post.where} (${h.name})`,
          'La clave de idempotencia no se llama Idempotency-Key.', 'Usa la cabecera Idempotency-Key, la del borrador del IETF.');
      }
      // Elemento
      const iget = c.itemOps.GET;
      if (iget) {
        const s = this.successSchema(iget.op, ['200']);
        const h = s ? this.headersOf(s.response) : {};
        c.itemSchema = s?.schema;
        if (h.etag) this.pass('writes', '7.2', 'El GET de un elemento declara ETag.', ['writes.etag']);
        else if (writes) this.add('writes', 'writes.etag', 'error', '7.2', iget.where, 'El GET del elemento no declara ETag.',
          'Devuelve una ETag fuerte de la representación completa; es lo que permite If-Match.');
        if (!h['cache-control']) this.add('writes', 'writes.cache-control', 'info', '7.3', iget.where, 'No se documenta Cache-Control en las lecturas.',
          'Toda respuesta a GET o HEAD lleva Cache-Control explícito (private o no-store si depende de las credenciales).');
        else this.pass('writes', '7.3', 'Las lecturas documentan Cache-Control.', ['writes.cache-control']);
      }
      if (get && !this.headersOf(this.successSchema(get.op)?.response)['cache-control'])
        this.add('writes', 'writes.cache-control', 'info', '7.3', get.where, 'No se documenta Cache-Control en las lecturas.',
          'Toda respuesta a GET o HEAD lleva Cache-Control explícito (private o no-store si depende de las credenciales).');
      for (const m of ['PATCH', 'PUT', 'DELETE']) {
        const o = c.itemOps[m];
        if (!o) continue;
        const ifMatch = o.params.some((p) => p.in === 'header' && lc(p.name) === 'if-match') || '412' in (o.op.responses ?? {});
        if (ifMatch) this.pass('writes', '7.2', 'Las escrituras aceptan If-Match.', ['writes.if-match']);
        else this.add('writes', 'writes.if-match', 'warning', '7.2', o.where, 'Las escrituras no aceptan If-Match.',
          'Evalúa If-Match contra la ETag del elemento en PATCH y DELETE, y responde 412 precondition_failed si no coincide.');
      }
      if (c.itemOps.POST) this.add('core', 'core.item-post', 'warning', '5.1', c.itemOps.POST.where, 'Un POST sobre un elemento.',
        'Para cambiar un elemento, PATCH con JSON Merge Patch; para una operación que no es actualizar, una acción declarada (POST /pets/{id}:nombre).');
      const del = c.itemOps.DELETE;
      if (del) {
        const codes = Object.keys(del.op.responses ?? {});
        if (!codes.includes('204')) this.add('core', 'core.delete.status', 'warning', '5.1', `${del.where} (${codes.filter((k) => /^2/.test(k)).join(', ') || 'sin 2xx'})`,
          'Borrar no responde 204.', 'DELETE responde 204 sin cuerpo.');
      }
      c.itemSchema ??= c.listItemSchema ?? (post && this.successSchema(post.op, ['201'])?.schema);
      if (c.itemPath) {
        const pname = c.itemPath.split('/').filter(Boolean).at(-1).slice(1, -1);
        const pp = c.itemOps.GET?.params.find((p) => p.in === 'path' && p.name === pname) ?? Object.values(c.itemOps)[0]?.params.find((p) => p.in === 'path' && p.name === pname);
        const t = pp ? this.typeOf(pp.schema) : null;
        if (t === 'integer' || t === 'number') this.add('core', 'data.id.type', 'error', '3', `${c.itemPath} ({${pname}}: ${t})`,
          'El identificador es un número.', 'El id es una cadena ("7"), siempre: así se puede cambiar de generador de ids sin romper a los clientes.');
      }
      this.checkQueryParams(c);
      // Acciones
      for (const a of c.actions) {
        if (a.style === 'colon') this.pass('extensions', '10.1', 'Las acciones usan la forma con dos puntos (/orders/{id}:cancel).');
        else this.add('extensions', 'actions.verb-path', 'warning', '10.1', a.o.where,
          'Un verbo en la URL hace de acción.', 'Decláralo como acción con dos puntos: POST /orders/{id}:cancel en vez de POST /orders/{id}/cancel.');
        if (lc(a.name) === 'search' && a.o.method === 'POST') this.add('extensions', 'query-method.search', 'info', '10.4', a.o.where,
          'Una búsqueda por POST.', 'Si es para consultas que no caben en la URL, Restep tiene QUERY (extensión query-method) con los mismos filtros que GET; si no, usa GET con filter[…].');
      }
      if (c.ops.QUERY) this.pass('extensions', '10.4', 'Usa el método QUERY.');
    }
    // Lotes
    for (const o of this.ops) if (/\/(batch|bulk)(\/|$|:)/i.test(o.path) || /:(batch|bulk)\w*$/i.test(o.path))
      this.add('extensions', 'batch.bulk', 'info', '10.2', o.where, 'Hay operaciones por lotes.',
        'Restep tiene la extensión batch: un único POST con operaciones en orden, referencias entre ellas y modo atómico.');
    if (!this.collections.length) this.add('core', 'core.no-collections', 'error', '5.2', 'todo el documento',
      'No se reconoce ninguna colección.', 'Restep organiza la API en colecciones (/books) y elementos (/books/7).');
  }

  // Parámetros de consulta de la lista (§5.3, §6) y lo que se puede inferir para el descubrimiento.
  checkQueryParams(c) {
    const get = c.ops.GET;
    c.filters = {};
    c.sort = [];
    c.sortConfidence = 'high';
    if (!get) return;
    const itemProps = this.props(c.itemSchema ?? c.listItemSchema);
    const fieldNames = Object.keys(itemProps);
    const matchField = (base) => {
      if (!base) return null;
      const cands = [base, words(base), base.replace(/_([a-z])/g, (_, x) => x.toUpperCase())];
      return fieldNames.find((f) => cands.includes(f)) ?? fieldNames.find((f) => lc(f) === lc(base) || words(f) === words(base)) ?? null;
    };
    const addFilter = (field, op, schema, confidence, source) => {
      const fname = field;
      const f = (c.filters[fname] ??= { ops: [], schema, confidence, sources: [] });
      if (!f.ops.includes(op)) f.ops.push(op);
      if (confidence === 'low') f.confidence = 'low';
      f.sources.push(source);
      f.schema ??= schema;
    };
    let anyQuery = false;
    for (const p of get.params) {
      if (p.in !== 'query') continue;
      anyQuery = true;
      const name = p.name ?? '';
      const n = lc(name);
      const where = `${get.where}?${name}`;
      const schema = this.resolve(p.schema ?? Object.values(p.content ?? {})[0]?.schema ?? {});
      const t = this.typeOf(schema);
      const bracket = /^filter\[([^\]]+)\](?:\[([a-z]+)\])?$/.exec(name);
      if (bracket) {
        addFilter(bracket[1], bracket[2] ?? 'eq', schema, 'high', where);
        this.pass('query', '6.1', 'Los filtros usan filter[campo][op].', ['query.filter.name']);
        continue;
      }
      if (n.startsWith('$')) continue; // ya avisado
      switch (n) {
        case 'limit':
          if (t === 'integer' || t === 'number') { this.pass('query', '6.4', 'El tamaño de página se pide con limit.', ['query.limit.name']); c.maxLimit = schema.maximum; }
          else this.add('core', 'core.reserved.conflict', 'error', '5.3', where, 'Usa un parámetro reservado con otro significado.', RESERVED_FIX);
          if (schema.maximum === undefined) this.add('query', 'query.limit.max', 'info', '6.4', where, 'limit no declara un máximo.', 'Declara el máximo (maximum en OpenAPI, max_limit en el descubrimiento); fuera de rango, invalid_parameter.');
          continue;
        case 'cursor': this.pass('query', '6.4', 'Pagina con cursor.', ['query.pagination.offset', 'query.pagination.cursor-param']); continue;
        case 'fields': this.pass('query', '6.3', 'Admite fields.'); c.fields = true; continue;
        case 'include': c.includeValues = this.enumOf(schema) ?? []; this.pass('relations', '8', 'Las relaciones se expanden con include.', ['relations.expand']); continue;
        case 'count':
          if (t === 'boolean') { c.count = true; this.pass('query', '6.5', 'Admite count=true.'); }
          else if (t === 'integer') this.add('query', 'query.limit.name', 'warning', '6.4', where, 'El tamaño de página no se llama limit.', 'Llámalo limit; count es reservado y en Restep pide el total (count=true, 6.5).');
          else this.add('core', 'core.reserved.conflict', 'error', '5.3', where, 'Usa un parámetro reservado con otro significado.', RESERVED_FIX);
          continue;
        case 'sort': {
          const vals = this.enumOf(schema);
          if (vals && vals.every((v) => /^(asc|desc|ascending|descending)$/i.test(v)))
            this.add('core', 'core.reserved.conflict', 'error', '5.3', where, 'Usa un parámetro reservado con otro significado.', RESERVED_FIX);
          else {
            this.pass('query', '6.2', 'El orden se pide con sort.', ['query.sort.name']);
            if (vals) c.sort.push(...vals.map((v) => String(v).replace(/^[-+]/, '').replace(/[:.](asc|desc)$/i, '')));
            else c.sortConfidence = 'low';
          }
          continue;
        }
        case 'filter':
          if (t === 'object') {
            for (const [field, fs0] of Object.entries(this.props(schema))) {
              const fs = this.resolve(fs0);
              const opsProps = this.props(fs);
              const ops = Object.keys(opsProps).filter((k) => ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'in', 'null'].includes(k));
              if (ops.length) for (const op of ops) addFilter(field, op, this.resolve(opsProps[op]), 'high', where);
              else addFilter(field, 'eq', fs, 'high', where);
            }
            this.pass('query', '6.1', 'Los filtros usan filter[campo][op].', ['query.filter.name']);
          } else this.add('extensions', 'filter-expr.string', 'warning', '10.3', where, 'filter es una expresión de texto.',
            'Con filter=<expresión> Restep pide la extensión filter-expr (sintaxis de la AIP-160 con paréntesis obligatorios); declara además los campos en filter.');
          continue;
        case 'since':
        case 'languages':
          this.add('core', 'core.reserved.conflict', 'error', '5.3', where, 'Usa un parámetro reservado con otro significado.', RESERVED_FIX);
          continue;
      }
      if (/^(offset|skip|start|page|page_?number|pagenumber|page_?index|pageno|from_?index)$/i.test(n)) {
        this.add('query', 'query.pagination.offset', 'error', '6.4', where, 'Pagina por desplazamiento o número de página.',
          'Pagina con un cursor opaco que viaja en next (6.4); el cliente sigue next tal cual. El servidor puede guardar el desplazamiento dentro del cursor.');
        continue;
      }
      if (/^(page_?token|after|before|starting_?after|ending_?before|next_?token|next_?cursor|continuation(_?token)?|marker|page_?cursor|cursor_?\w+|\w+_cursor)$/i.test(n)) {
        this.add('query', 'query.pagination.cursor-param', 'warning', '6.4', where, 'El cursor no se llama cursor.', 'Llámalo cursor, opaco, y ponlo en next; el cliente no lo construye.');
        continue;
      }
      if (/^(page_?size|per_?page|size|top|take|max_?results|max_?items|maxpagesize|max|n)$/i.test(n)) {
        this.add('query', 'query.limit.name', 'warning', '6.4', where, 'El tamaño de página no se llama limit.', 'Llámalo limit, con máximo declarado (max_limit).');
        if (t === 'integer') c.maxLimit = schema.maximum;
        continue;
      }
      if (/^(sort_?by|order_?by|ordering|order|sort_?order|sort_?dir(ection)?|direction|dir|sort_?field)$/i.test(n)) {
        this.add('query', 'query.sort.name', 'warning', '6.2', where, 'El orden no usa sort.', 'Usa sort=campo1,-campo2 («-» para descendente) y declara los campos ordenables en sort.');
        const vals = this.enumOf(schema);
        if (vals && !vals.every((v) => /^(asc|desc|ascending|descending)$/i.test(v))) c.sort.push(...vals.map((v) => String(v).replace(/^[-+]/, '').replace(/[:.](asc|desc)$/i, '')));
        else if (!vals && !/order$|dir|direction/i.test(n)) c.sortConfidence = 'low';
        continue;
      }
      if (/^(select|projection|attributes|only|field_?mask|fieldmask)$/i.test(n)) {
        this.add('query', 'query.fields.name', 'warning', '6.3', where, 'La selección de campos no usa fields.', 'Usa fields=campo1,campo2 (más id y los miembros _).');
        continue;
      }
      if (/^(expand|embed|with|includes|populate|join)$/i.test(n)) {
        this.add('relations', 'relations.expand', 'warning', '8', where, 'La expansión de relaciones no usa include.', 'Usa include=relacion (con rutas con punto hasta include_depth) y declara las relaciones expandibles.');
        continue;
      }
      if (/^(include_?total|with_?count|total|count_?total|with_?total|totals|inlinecount)$/i.test(n)) {
        this.add('query', 'query.count.name', 'warning', '6.5', where, 'El total no se pide con count.', 'Usa count=true, que añade total a la respuesta, y declara count en la colección.');
        c.count = true;
        continue;
      }
      if (/^(q|query|search|term|keyword|keywords|text|search_?term|fulltext)$/i.test(n)) {
        this.add('query', 'query.search', 'info', '6.1', where, 'Búsqueda de texto libre.',
          'Restep no define búsqueda de texto: el parámetro puede seguir como propio de la API (no es reservado). Lo que sea filtrar por un campo, mejor en filter[…].');
        continue;
      }
      if (/^(updated_?(since|after)|modified_?(since|after)|changed_?since|sync_?token|delta(_?token)?|last_?sync)$/i.test(n)) {
        this.add('sync', 'sync.delta', 'warning', '9', where, 'La sincronización usa un parámetro propio.', 'Ofrece GET /coleccion:changes?since=<state> con created, updated y destroyed, y state en cada lista.');
        this.syncHint = true;
        // También vale como filtro de fecha
      }
      // Lo demás: un filtro con nombre no reservado.
      const inferred = this.inferFilter(name, schema, matchField);
      addFilter(inferred.field, inferred.op, inferred.schema ?? schema, inferred.confidence, where);
      if (inferred.op2) addFilter(inferred.field, inferred.op2, inferred.schema ?? schema, inferred.confidence, where);
      const target = inferred.op === 'eq' ? `filter[${inferred.field}]` : `filter[${inferred.field}][${inferred.op}]`;
      this.add('query', 'query.filter.name', 'warning', '6.1', `${where} → ${target}`, 'Los filtros usan nombres propios, no filter[campo][op].',
        'Pasa cada filtro a filter[campo] o filter[campo][op] y declara campo, tipo y operadores en filter: así un filtro que el servidor no conoce da 400 en vez de devolver la colección entera.');
    }
    if (!anyQuery) this.add('query', 'query.absent', 'warning', '6', get.where, 'La lista no admite filtros, orden ni tamaño de página.',
      'Con query, la colección declara sus filtros, su orden y max_limit; sin él, el servidor debe responder 400 a esos parámetros (5.3).');
  }

  enumOf(schema) {
    const s = this.resolve(schema);
    if (Array.isArray(s?.enum)) return s.enum;
    if (this.typeOf(s) === 'array' && Array.isArray(this.resolve(s.items)?.enum)) return this.resolve(s.items).enum;
    return null;
  }

  // Deduce campo y operador de un parámetro con nombre libre: min_price → price ge, created_after → created_at gt…
  inferFilter(name, schema, matchField) {
    const n = words(name);
    const rules = [
      [/^min_(.+)$/, 'ge'], [/^max_(.+)$/, 'le'], [/^(.+)_(gte|ge|min|from|since)$/, 'ge'], [/^(.+)_(lte|le|max|to|until)$/, 'le'],
      [/^(.+)_(gt|after)$/, 'gt'], [/^(.+)_(lt|before)$/, 'lt'], [/^(.+)_(ne|not)$/, 'ne'], [/^(.+)_in$/, 'in'],
    ];
    let base = n, op = 'eq';
    for (const [re, o] of rules) { const m = re.exec(n); if (m) { base = m[1]; op = o; break; } }
    const isArray = this.typeOf(schema) === 'array';
    if (isArray && op === 'eq') op = 'in';
    let field = matchField(base);
    if (!field && op === 'in') field = matchField(singular(base)) ?? (singular(base) === 'id' ? 'id' : null);
    if (!field && /^ids?$/.test(base)) field = 'id';
    if (!field && ['gt', 'lt', 'ge', 'le'].includes(op)) field = matchField(base + '_at') ?? matchField(base + '_date') ?? matchField(base + 'At');
    const confidence = !field ? 'low' : op === 'eq' && field === name ? 'high' : 'medium';
    return { field: field ?? base, op, op2: op === 'in' && isArray ? 'eq' : null, confidence, schema: isArray ? this.resolve(schema).items : schema };
  }

  // Tipos de dato, nombres e identificadores (§3), sobre los esquemas de los elementos.
  checkFields() {
    const seen = new Set();
    const camel = [], snakeNames = [];
    const visit = (schema, where, depth = 0) => {
      if (depth > 3) return;
      const name = this.refName(schema);
      const key = name ?? where;
      if (seen.has(key)) return;
      seen.add(key);
      const at = name ? `esquema ${name}` : where;
      const props = this.props(schema);
      for (const [k, v0] of Object.entries(props)) {
        const v = this.resolve(v0);
        const t = this.typeOf(v);
        if (/[a-z][A-Z]/.test(k)) camel.push(`${at}.${k}`);
        else if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(k)) snakeNames.push(`${at}.${k}`);
        if (k.startsWith('_')) this.add('core', 'data.underscore', 'error', '3', `${at}.${k}`, 'Un campo empieza por «_».', 'Los miembros con _ son de Restep (_etag, _actions…): renombra el campo.');
        if (k !== 'id' && t === 'integer' && (v.format === 'int64' || v.format === 'uint64'))
          this.add('core', 'data.int64', 'warning', '3', `${at}.${k}`, 'Un entero de 64 bits va como número.', 'Si puede pasar de ±(2^53−1), envíalo como cadena en todas las representaciones.');
        if (t === 'number' && MONEY.test(k))
          this.add('core', 'data.money', 'warning', '3', `${at}.${k}`, 'Un importe va como número.', 'Los importes van como cadena decimal ("18.50"), acompañados de su moneda ISO 4217.');
        if ((t === 'integer' || t === 'number') && /(_at|At|timestamp|Timestamp|_time|Time|_date|Date)$/.test(k))
          this.add('core', 'data.timestamp-number', 'warning', '3', `${at}.${k}`, 'Un instante va como número.', 'Los instantes van como date-time del RFC 3339 con desfase ("2026-11-12T09:30:00Z").');
        if (t === 'string' && !v.format && /(_at|At|_date|Date|_on)$/.test(k))
          this.add('core', 'data.date-format', 'info', '3', `${at}.${k}`, 'Una fecha o un instante sin formato declarado.', 'Declara format: date-time (RFC 3339 con desfase) o format: date.');
        if (k !== 'id' && /^(.+?)(_id|Id|ID)$/.test(k) && (t === 'string' || t === 'integer'))
          this.add('relations', 'relations.scalar-fk', 'warning', '3', `${at}.${k}`, 'Una relación va como identificador suelto.',
            'Una relación es un objeto con id: "owner": {"id": "4"}, para que el tipo no cambie al incluir el elemento (3, 8).');
        if (/^(.+?)(_ids|Ids|IDs)$/.test(k) && t === 'array')
          this.add('relations', 'relations.id-array', 'warning', '3', `${at}.${k}`, 'Una relación a muchos va como lista de identificadores.',
            'Una relación a muchos es una lista de objetos con id, o mejor una subcolección si puede crecer sin límite (8).');
        if (t === 'object' && depth < 2 && !this.refName(v0)) visit(v, `${at}.${k}`, depth + 1);
      }
    };
    for (const c of this.collections) {
      const schema = c.itemSchema ?? c.listItemSchema;
      if (!schema) continue;
      const name = this.refName(schema);
      const at = name ? `esquema ${name}` : `${c.path}`;
      const props = this.props(schema);
      if (Object.keys(props).length) {
        if (!('id' in props)) {
          const alt = Object.keys(props).find((k) => /^(uuid|_id|key|guid|\w+_?id)$/i.test(k));
          this.add('core', 'data.id.missing', 'warning', '3', `${at}${alt ? ` (${alt})` : ''}`, 'El elemento no tiene campo «id».', 'El identificador de un elemento se llama id y es una cadena.');
        } else {
          const t = this.typeOf(props.id);
          if (t === 'integer' || t === 'number') this.add('core', 'data.id.type', 'error', '3', `${at}.id (${t})`,
            'El identificador es un número.', 'El id es una cadena ("7"), siempre: así se puede cambiar de generador de ids sin romper a los clientes.');
          else if (t === 'string') this.pass('core', '3', 'Los id son cadenas.', ['data.id.type']);
        }
      }
      visit(schema, c.path);
      for (const s of [this.resolve(c.ops.POST?.op.requestBody)?.content, this.resolve(c.itemOps.PATCH?.op.requestBody)?.content])
        if (s) for (const m of Object.values(s)) if (m.schema) visit(m.schema, c.path);
    }
    if (camel.length && snakeNames.length) this.add('core', 'data.naming', 'warning', '3', [`camelCase: ${camel.slice(0, 3).join(', ')}`, `snake_case: ${snakeNames.slice(0, 3).join(', ')}`],
      'Los campos mezclan camelCase y snake_case.', 'Sigue un único convenio para los nombres de campo; los que define Restep van en snake_case.');
  }

  checkSync() {
    for (const o of this.ops) {
      if (/:changes$/.test(o.path)) { this.pass('sync', '9', 'Ofrece :changes.'); this.syncHint = true; this.syncNative = true; }
      else if (/\/(changes|delta|sync)$/i.test(o.path)) {
        this.add('sync', 'sync.endpoint', 'warning', '9', o.where, 'La sincronización tiene un endpoint propio.', 'Restep usa GET /coleccion:changes?since=<state> por colección, con state en cada lista.');
        this.syncHint = true;
      }
      if (o.op.callbacks && Object.keys(o.op.callbacks).length) this.webhooks = true;
    }
    if (isObject(this.doc.webhooks) && Object.keys(this.doc.webhooks).length) this.webhooks = true;
    if (this.webhooks) {
      this.add('sync', 'sync.webhooks', 'info', '9', 'webhooks/callbacks', 'Avisa de cambios con webhooks.',
        'Los webhooks pueden seguir; para mantener copias al día Restep usa :changes y, si quieres empujar avisos, un canal SSE declarado en events.');
      this.syncHint = true;
    }
    if (this.syncHint && !this.syncNative) this.add('sync', 'sync.changes', 'error', '9', 'todas las colecciones', 'No hay :changes ni state.',
      'Cada lista lleva state; GET /coleccion:changes?since=<state> devuelve created, updated y destroyed; y la colección declara filter[id] con in.');
  }

  // ── Borrador del descubrimiento ──────────────────────────────────────────

  buildDiscovery() {
    const ann = this.options.annotations !== false;
    const withSchemas = this.options.schemas !== false;
    const d = { restep: '1.0' };
    if (this.majorVersion) d.version = this.majorVersion;
    const collections = {};
    const lowNotes = [];
    const nameOf = new Map(this.collections.map((c) => [c, c.name]));
    const bySchema = new Map();
    for (const c of this.collections) { const n = this.refName(c.itemSchema); if (n) bySchema.set(n, c); }
    let anyQuery = false, anyRelations = false, anyActions = false;
    for (const c of this.collections) {
      const notes = [];
      const out = { path: c.path };
      const desc = firstSentence(c.ops.GET?.op.summary) ?? firstSentence(c.ops.GET?.op.description) ?? firstSentence(this.tagDescription(c));
      if (desc) out.description = desc;
      const methods = ['GET', 'POST', 'PATCH', 'DELETE'].filter((m) => c.ops[m]);
      const itemMethods = ['GET', 'PATCH', 'DELETE'].filter((m) => c.itemOps[m]);
      if (c.itemOps.PUT && !c.itemOps.PATCH) { itemMethods.splice(1, 0, 'PATCH'); notes.push('item_methods: PATCH sale del PUT, que Restep no admite'); }
      if (methods.length) out.methods = methods;
      if (c.itemPath && itemMethods.length) out.item_methods = itemMethods;
      else if (!c.itemPath) notes.push('no hay ruta de elemento (/{id}) en OpenAPI');
      // Esquemas
      if (withSchemas) {
        const schemas = {};
        if (c.itemSchema) schemas.item = this.toJsonSchema(c.itemSchema);
        const create = this.resolve(c.ops.POST?.op.requestBody)?.content;
        const cm = create && Object.keys(create).find(isJsonMedia);
        if (cm && create[cm].schema) {
          schemas.create = this.toJsonSchema(create[cm].schema);
          if (this.dropId(schemas.create)) notes.push('schemas.create: se ha quitado id, que asigna el servidor');
        }
        const upd = this.resolve(c.itemOps.PATCH?.op.requestBody)?.content;
        const um = upd ? (Object.keys(upd).find((m) => /merge-patch\+json/i.test(m)) ?? Object.keys(upd).find(isJsonMedia)) : null;
        if (um && upd[um].schema && !/json-patch/i.test(um)) {
          schemas.update = this.toJsonSchema(upd[um].schema);
          if (this.dropId(schemas.update)) notes.push('schemas.update: se ha quitado id, que no cambia');
        }
        else {
          const put = this.resolve(c.itemOps.PUT?.op.requestBody)?.content;
          const pm = put && Object.keys(put).find(isJsonMedia);
          if (pm && put[pm].schema) { schemas.update = this.mergePatchSchema(this.toJsonSchema(put[pm].schema)); this.dropId(schemas.update); notes.push('schemas.update sale del cuerpo del PUT, sin required y con null admitido'); }
        }
        if (Object.keys(schemas).length) out.schemas = schemas;
      }
      // Filtros
      const filter = {};
      for (const [field, f] of Object.entries(c.filters ?? {})) {
        const decl = this.filterType(f.schema, field, c);
        const ops = f.ops.filter((op) => decl.type !== 'boolean' || ['eq', 'ne', 'null'].includes(op));
        if (!ops.length) continue;
        const entry = { type: decl.type, ...(decl.values ? { values: decl.values } : {}), ops };
        const low = f.confidence === 'low' || decl.low;
        if (ann && f.confidence !== 'high') entry['x-confidence'] = low ? 'low' : 'medium';
        if (ann && f.confidence !== 'high') entry['x-source'] = [...new Set(f.sources)].join('; ');
        if (low) lowNotes.push(`${c.name}.filter.${field}`);
        filter[field] = entry;
      }
      if (Object.keys(filter).length) { out.filter = filter; anyQuery = true; }
      const sort = [...new Set(c.sort ?? [])].filter((s) => /^[^_]/.test(s));
      if (sort.length) { out.sort = sort; anyQuery = true; }
      else if (c.sortConfidence === 'low') notes.push('hay un parámetro de orden sin lista de campos: completa sort a mano');
      if (Number.isInteger(c.maxLimit) && c.maxLimit >= 1) { out.max_limit = c.maxLimit; anyQuery = true; }
      if (c.count || c.countField) { out.count = 'exact'; notes.push('count: se supone exact; usa estimated si el total es aproximado'); anyQuery = true; }
      // Relaciones
      const relations = {};
      const props = this.props(c.itemSchema);
      for (const [k, v0] of Object.entries(props)) {
        const v = this.resolve(v0);
        const t = this.typeOf(v);
        const fk = /^(.+?)(_id|Id|ID)$/.exec(k);
        const fks = /^(.+?)(_ids|Ids|IDs)$/.exec(k);
        let rel = null;
        if (k !== 'id' && fk && (t === 'string' || t === 'integer')) {
          const target = this.findCollection(fk[1]);
          if (target) rel = { name: snake(fk[1]), decl: { to: target.name }, conf: 'low', note: `relación deducida de ${k}: la representación debe pasar a ${snake(fk[1])}: {"id": …}` };
        } else if (fks && t === 'array') {
          const target = this.findCollection(fks[1]);
          if (target) rel = { name: plural(snake(fks[1])), decl: { to: target.name, many: true }, conf: 'low', note: `relación deducida de ${k}: debe pasar a una lista de objetos con id` };
        } else if (t === 'object' && this.refName(v0) && bySchema.has(this.refName(v0))) {
          rel = { name: k, decl: { to: bySchema.get(this.refName(v0)).name, include: true }, conf: 'medium', note: `relación deducida del esquema ${this.refName(v0)} incrustado` };
        } else if (t === 'object' && 'id' in this.props(v) && Object.keys(this.props(v)).every((x) => ['id', 'type', 'href'].includes(x)) && this.findCollection(k)) {
          rel = { name: k, decl: { to: this.findCollection(k).name }, conf: 'medium', note: `relación deducida del objeto {id} en ${k}` };
        } else if (t === 'array' && this.refName(v.items) && bySchema.has(this.refName(v.items))) {
          rel = { name: k, decl: { to: bySchema.get(this.refName(v.items)).name, many: true }, conf: 'medium', note: `relación deducida de la lista de ${this.refName(v.items)}` };
        }
        if (rel) {
          if ((c.includeValues ?? []).includes(rel.name)) rel.decl.include = true;
          if (ann) { rel.decl['x-confidence'] = rel.conf; rel.decl['x-source'] = rel.note; }
          if (rel.conf === 'low') lowNotes.push(`${c.name}.relations.${rel.name}`);
          relations[rel.name] = rel.decl;
        }
      }
      for (const child of c.children) {
        const decl = { to: nameOf.get(child), many: true, path: child.path };
        relations[child.segment in relations ? child.name : child.segment] = decl;
      }
      if (Object.keys(relations).length) { out.relations = relations; anyRelations = true; }
      // Acciones
      const actions = {};
      for (const a of c.actions) {
        const name = snake(a.name);
        if (!name || name === 'changes') continue;
        const safe = a.o.method === 'GET';
        const decl = { on: a.on, safe, idempotent: safe || a.o.method === 'PUT' || a.o.method === 'DELETE' };
        if (safe) decl.method = 'GET';
        const desc2 = firstSentence(a.o.op.summary) ?? firstSentence(a.o.op.description);
        if (desc2) decl.description = desc2;
        const body = this.resolve(a.o.op.requestBody)?.content;
        const bm = body && Object.keys(body).find(isJsonMedia);
        if (!safe && withSchemas && bm && body[bm].schema) decl.input = this.toJsonSchema(body[bm].schema);
        if (ann) { decl['x-confidence'] = a.style === 'colon' ? 'medium' : 'low'; decl['x-source'] = `${a.o.where}${a.style === 'verb' ? ` → ${safe ? 'GET' : 'POST'} ${this.prefix}${a.base}:${name}` : ''}`; }
        if (a.style === 'verb') lowNotes.push(`${c.name}.actions.${name}`);
        if (!safe) notes.push(`actions.${name}: idempotent ${decl.idempotent} es una suposición`);
        actions[name] = decl;
      }
      if (Object.keys(actions).length) { out.actions = actions; anyActions = true; }
      if (ann) {
        const conf = !c.itemPath || !c.ops.GET ? 'low' : 'high';
        out['x-restep-from-openapi'] = { confidence: conf, source: [c.ops.GET?.where, c.itemOps.GET?.where].filter(Boolean).join(', ') || c.path, ...(notes.length ? { notes } : {}) };
      }
      if (!c.ops.GET) lowNotes.push(`${c.name} (sin GET de lista en OpenAPI)`);
      c.notes = notes;
      let key = c.name;
      for (let i = 2; key in collections; i++) key = `${c.name}_${i}`;
      collections[key] = out;
    }
    const profiles = ['core'];
    if (anyQuery) profiles.push('query');
    const writesErrors = [...this.findings.values()].some((f) => f.profile === 'writes' && f.severity === 'error');
    if (this.hasWrites && !writesErrors && !this.findings.has('writes.idempotency')) profiles.push('writes');
    if (anyRelations) profiles.push('relations');
    d.profiles = profiles;
    const extensions = [];
    if (anyActions) extensions.push('actions');
    if (this.oauth) extensions.push('oauth');
    if (extensions.length) d.extensions = extensions;
    if (profiles.includes('writes')) d.idempotency = { ttl: 86400 };
    if (this.statusPath) {
      const base = (this.doc.servers?.[0]?.url ?? '').replace(/\/+$/, '');
      d.status = /^[a-z][a-z0-9+.-]*:|^\//i.test(base + this.statusPath) ? base + this.statusPath : '/' + (base + this.statusPath).replace(/^\/*/, '');
    }
    d.collections = collections;
    if (ann) d['x-restep-from-openapi'] = {
      generator: `restep-from-openapi ${VERSION}`,
      source: `${this.title}${this.apiVersion ? ` ${this.apiVersion}` : ''} (OpenAPI ${this.openapi})`,
      api_root: this.root,
      note: 'Borrador deducido de la descripción OpenAPI. Revisa lo marcado con x-confidence low o medium y quita los miembros x-restep-from-openapi, x-confidence y x-source antes de publicarlo.',
    };
    this.discovery = d;
    this.lowNotes = lowNotes;
  }

  // Quita id de un esquema de cuerpo (5.1: lo asigna el servidor y no cambia).
  dropId(s) {
    if (!isObject(s?.properties) || !('id' in s.properties)) return false;
    delete s.properties.id;
    if (Array.isArray(s.required)) s.required = s.required.filter((k) => k !== 'id');
    if (Array.isArray(s.required) && !s.required.length) delete s.required;
    return true;
  }

  tagDescription(c) {
    const tag = c.ops.GET?.op.tags?.[0] ?? Object.values(c.itemOps)[0]?.op.tags?.[0];
    return (this.doc.tags ?? []).find((t) => t.name === tag)?.description;
  }

  findCollection(base) {
    const b = words(base);
    return this.collections.find((c) => !c.parent && [b, plural(b)].includes(words(c.segment)))
      ?? this.collections.find((c) => [b, plural(b)].includes(words(c.segment)))
      ?? this.collections.find((c) => lc(this.refName(c.itemSchema) ?? '') === lc(base));
  }

  // Tipo Restep (§4.2) de un filtro a partir del esquema del parámetro o del campo.
  filterType(schema0, field, c) {
    const itemProps = this.props(c.itemSchema ?? c.listItemSchema);
    const fieldSchema = this.resolve(itemProps[field]);
    let s = this.resolve(schema0);
    if (field === 'id') return { type: 'string' };
    const pick = (x) => {
      const t = this.typeOf(x);
      if (Array.isArray(x?.enum) && x.enum.length && x.enum.every((v) => typeof v === 'string')) return { type: 'enum', values: x.enum };
      if (t === 'string') {
        if (x.format === 'date-time') return { type: 'datetime' };
        if (x.format === 'date') return { type: 'date' };
        if (x.format === 'duration') return { type: 'duration' };
        if (x.format === 'decimal' || /\[0-9\]\+\(\\\.\[0-9\]|\\d\+\(\\\.\\d/.test(x.pattern ?? '') || MONEY.test(field)) return { type: 'decimal' };
        return { type: 'string' };
      }
      if (t === 'integer') return { type: 'integer' };
      if (t === 'number') return MONEY.test(field) ? { type: 'decimal' } : { type: 'number' };
      if (t === 'boolean') return { type: 'boolean' };
      return null;
    };
    const fromParam = pick(s);
    const fromField = fieldSchema && Object.keys(fieldSchema).length ? pick(fieldSchema) : null;
    // El tipo del campo manda (el del parámetro suele ser string), salvo que el parámetro sea más preciso.
    if (fromField && (!fromParam || fromParam.type === 'string')) return fromField;
    if (fromParam) return fromParam;
    return { type: 'string', low: true };
  }

  // OpenAPI 3.0 → JSON Schema 2020-12, con los $ref locales resueltos (un ciclo se corta con {}).
  toJsonSchema(schema, stack = []) {
    const name = this.refName(schema);
    if (name && stack.includes(name)) return { description: `Referencia circular a ${name} (recortada).` };
    const s = this.resolve(schema);
    if (!isObject(s)) return typeof s === 'boolean' ? s : {};
    const next = name ? [...stack, name] : stack;
    if (stack.length > 12) return {};
    const out = {};
    for (const [k, v] of Object.entries(s)) {
      if (['nullable', 'discriminator', 'xml', 'externalDocs', 'example', '$ref', '$schema', '$id'].includes(k)) continue;
      if (/^x-/.test(k)) continue;
      if (['properties', 'patternProperties', '$defs', 'definitions'].includes(k) && isObject(v)) out[k] = Object.fromEntries(Object.entries(v).map(([p, x]) => [p, this.toJsonSchema(x, next)]));
      else if (['items', 'additionalProperties', 'not', 'contains', 'propertyNames', 'if', 'then', 'else'].includes(k) && (isObject(v) || typeof v === 'boolean')) out[k] = typeof v === 'boolean' ? v : this.toJsonSchema(v, next);
      else if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(k) && Array.isArray(v)) out[k] = v.map((x) => this.toJsonSchema(x, next));
      else if (k === 'exclusiveMinimum' && v === true) { out.exclusiveMinimum = s.minimum; }
      else if (k === 'exclusiveMaximum' && v === true) { out.exclusiveMaximum = s.maximum; }
      else if ((k === 'exclusiveMinimum' || k === 'exclusiveMaximum') && v === false) continue;
      else out[k] = v;
    }
    if (s.exclusiveMinimum === true) delete out.minimum;
    if (s.exclusiveMaximum === true) delete out.maximum;
    if (s.example !== undefined && out.examples === undefined) out.examples = [s.example];
    if (s.nullable === true) {
      if (typeof out.type === 'string') out.type = [out.type, 'null'];
      else if (Array.isArray(out.type) && !out.type.includes('null')) out.type = [...out.type, 'null'];
      else if (!out.type) return { anyOf: [out, { type: 'null' }] };
      if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
    }
    return out;
  }

  // Un esquema de merge patch a partir del de un cuerpo completo: nada obligatorio y null admitido.
  mergePatchSchema(s) {
    const out = { ...s };
    delete out.required;
    if (isObject(out.properties)) out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => {
      if (!isObject(v)) return [k, v];
      if (typeof v.type === 'string') return [k, { ...v, type: [v.type, 'null'], ...(Array.isArray(v.enum) ? { enum: [...v.enum, null] } : {}) }];
      if (Array.isArray(v.type)) return [k, v.type.includes('null') ? v : { ...v, type: [...v.type, 'null'] }];
      return [k, { anyOf: [v, { type: 'null' }] }];
    }));
    return out;
  }

  result() {
    const findings = [...this.findings.values()];
    const order = { error: 0, warning: 1, info: 2 };
    findings.sort((a, b) => order[a.severity] - order[b.severity] || a.section.localeCompare(b.section, 'en', { numeric: true }) || a.id.localeCompare(b.id));
    const relevant = {
      core: true,
      query: this.collections.some((c) => c.ops.GET) || findings.some((f) => f.profile === 'query'),
      writes: this.hasWrites,
      relations: findings.some((f) => f.profile === 'relations') || this.passes.some((p) => p.profile === 'relations') || Object.values(this.discovery.collections).some((c) => c.relations),
      sync: !!this.syncHint,
    };
    const scores = {};
    for (const p of PROFILES) {
      const fs = findings.filter((f) => f.profile === p);
      const errors = fs.filter((f) => f.severity === 'error').length;
      const warnings = fs.filter((f) => f.severity === 'warning').length;
      if (!relevant[p]) { scores[p] = { score: null, errors, warnings, note: p === 'sync' ? 'sin indicios de sincronización en la descripción' : p === 'writes' ? 'la API no tiene escrituras' : 'nada que evaluar' }; continue; }
      let penalty = 0;
      for (const f of fs) {
        if (f.severity === 'info') continue;
        penalty += (f.severity === 'error' ? 15 : 6) + Math.min(8, 2 * (f.where.length - 1));
      }
      const score = Math.max(0, 100 - penalty);
      scores[p] = { score, errors, warnings, note: score >= 90 ? 'casi listo' : score >= 60 ? 'trabajo moderado' : 'mucho trabajo' };
    }
    return {
      tool: `restep-from-openapi ${VERSION}`,
      api: { title: this.title, version: this.apiVersion, openapi: this.openapi, root: this.root, operations: this.ops.length, paths: this.byPath.size },
      collections: this.collections.map((c) => ({ name: c.name, path: c.path, itemPath: c.itemPath, actions: c.actions.map((a) => snake(a.name)) })),
      scores,
      findings,
      passes: this.passes.filter((p) => !p.unless.some((id) => this.findings.has(id))).map(({ unless, ...p }) => p),
      unresolvedRefs: [...this.unresolved],
      lowConfidence: this.lowNotes,
      discovery: this.discovery,
    };
  }
}

// ── Informe ─────────────────────────────────────────────────────────────────

const SEVERITY = { error: 'Error', warning: 'Aviso', info: 'Nota' };
const PROFILE_TITLES = { core: 'core (obligatorio)', query: 'query', writes: 'writes', relations: 'relations', sync: 'sync', extensions: 'Extensiones' };
const MAX_WHERE = 8;

export function renderReport(r, { source, validation } = {}) {
  const L = [];
  L.push(`# ${r.api.title}: qué le falta para cumplir Restep 1`, '');
  L.push(`Generado por ${r.tool} a partir de ${source ? `\`${source}\`` : 'una descripción'} (OpenAPI ${r.api.openapi}${r.api.version ? `, versión de la API ${r.api.version}` : ''}). `
    + `${r.api.operations} operaciones en ${r.api.paths} rutas; ${r.collections.length} colecciones reconocidas. Raíz de la API supuesta: \`${r.api.root}\`.`, '');
  L.push('> Es un informe orientativo: solo lee la descripción OpenAPI, no llama a la API, y deduce por nombres y esquemas. '
    + 'Lo que la descripción no documenta (cabeceras, códigos de error) cuenta como ausente. Para comprobar un servidor de verdad, usa '
    + '[restep-check](https://restep.wubytes.com/es/herramientas/).', '');
  L.push('## Resumen', '');
  L.push('| Perfil | Puntuación | Errores | Avisos | Valoración |', '|---|---|---|---|---|');
  for (const p of PROFILES) {
    const s = r.scores[p];
    L.push(`| ${p} | ${s.score === null ? '—' : `${s.score}/100`} | ${s.errors} | ${s.warnings} | ${s.note} |`);
  }
  L.push('', 'Puntuación orientativa: 100 menos 15 por cada tipo de error y 6 por cada tipo de aviso, más 2 por cada lugar extra donde se repite (hasta 8). Las notas no restan.', '');
  for (const p of [...PROFILES, 'extensions']) {
    const fs = r.findings.filter((f) => f.profile === p);
    const ps = r.passes.filter((x) => x.profile === p);
    if (!fs.length && !ps.length) continue;
    L.push(`## ${PROFILE_TITLES[p]}`, '');
    if (fs.length) {
      L.push(p === 'extensions' ? '### Sugerencias' : '### Lo que falta', '');
      for (const f of fs) {
        L.push(`- **${SEVERITY[f.severity]}: ${f.title}** ${sectionLink(f.section)} \`${f.id}\``);
        L.push(`  ${f.fix}`);
        const shown = f.where.slice(0, MAX_WHERE).map((w) => `\`${w}\``).join(', ');
        L.push(`  Dónde: ${shown}${f.where.length > MAX_WHERE ? ` y ${f.where.length - MAX_WHERE} más` : ''}.`);
      }
      L.push('');
    }
    if (ps.length) {
      L.push('### Lo que ya cumple', '');
      for (const x of ps) L.push(`- ${x.text} ${sectionLink(x.section)}`);
      L.push('');
    }
  }
  L.push('## Borrador del documento de descubrimiento', '');
  const d = r.discovery;
  L.push(`Perfiles: ${d.profiles.join(', ')}${d.extensions ? `. Extensiones: ${d.extensions.join(', ')}` : ''}. `
    + 'Los perfiles salen de lo que el borrador declara; anunciarlos obliga a cumplir lo que falta arriba.', '');
  const cols = Object.entries(d.collections);
  if (cols.length) {
    L.push('| Colección | Ruta | Métodos | Elemento | Filtros | Orden | Relaciones | Acciones |', '|---|---|---|---|---|---|---|---|');
    for (const [name, c] of cols)
      L.push(`| ${name} | \`${c.path}\` | ${(c.methods ?? []).join(' ') || '—'} | ${(c.item_methods ?? []).join(' ') || '—'} | ${Object.keys(c.filter ?? {}).join(', ') || '—'} | ${(c.sort ?? []).join(', ') || '—'} | ${Object.keys(c.relations ?? {}).join(', ') || '—'} | ${Object.keys(c.actions ?? {}).join(', ') || '—'} |`);
    L.push('');
  }
  if (r.lowConfidence.length) {
    L.push('Deducido con poca confianza (revísalo a mano):', '');
    for (const x of r.lowConfidence) L.push(`- \`${x}\``);
    L.push('');
  }
  const notes = Object.entries(d.collections).flatMap(([n, c]) => (c['x-restep-from-openapi']?.notes ?? []).map((x) => `${n}: ${x}`));
  if (notes.length) { L.push('Notas:', ''); for (const x of notes) L.push(`- ${x}`); L.push(''); }
  if (r.unresolvedRefs.length) L.push(`Referencias externas sin resolver (se han tratado como esquemas vacíos): ${r.unresolvedRefs.map((x) => `\`${x}\``).join(', ')}.`, '');
  if (validation) L.push(validation.errors === null ? `Validación contra discovery.json: no hecha (${validation.reason}).`
    : validation.errors.length ? `Validación contra discovery.json: **${validation.errors.length} errores**: ${validation.errors.slice(0, 5).map((e) => `\`${e.at}\` ${e.message}`).join('; ')}.`
      : 'Validación contra discovery.json: correcta.', '');
  return L.join('\n');
}

// ── Esquema de descubrimiento ───────────────────────────────────────────────

export async function loadDiscoverySchema() {
  const here = fileURLToPath(new URL('.', import.meta.url));
  for (const p of [`${here}schema/discovery.json`]) {
    try { return { schema: JSON.parse(await readFile(p, 'utf8')), from: p }; } catch { /* siguiente */ }
  }
  try {
    const r = await fetch(SCHEMA_URL, { signal: AbortSignal.timeout(10000) });
    if (r.ok) return { schema: await r.json(), from: SCHEMA_URL };
  } catch { /* sin red */ }
  return null;
}

export function stripAnnotations(v) {
  if (Array.isArray(v)) return v.map(stripAnnotations);
  if (!isObject(v)) return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => !/^x-(confidence|source|restep-from-openapi)$/.test(k)).map(([k, x]) => [k, stripAnnotations(x)]));
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `Uso: restep-from-openapi <openapi.json|openapi.yaml|URL> [opciones]

Lee una API descrita en OpenAPI 3.x y dice qué le falta para cumplir Restep 1, perfil a perfil,
con una puntuación orientativa; y escribe un borrador de su documento de descubrimiento.

Opciones:
  --out <archivo>     escribe el borrador del descubrimiento (JSON)
  --report <archivo>  escribe el informe en Markdown (si no, va a la salida estándar)
  --json              saca por la salida estándar el resultado completo en JSON en vez del informe
  --no-schemas        no copia los esquemas de OpenAPI en schemas ni en el input de las acciones
  --no-annotations    sin los miembros x-confidence, x-source y x-restep-from-openapi
  --help              esta ayuda

Códigos de salida: 0 bien; 1 no se pudo leer la descripción; 2 uso incorrecto.`;

async function main(argv) {
  const opts = { schemas: true, annotations: true };
  let input = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (!v || v.startsWith('--')) usage(`${a} necesita un archivo.`); return v; };
    if (a === '--help' || a === '-h') { console.log(USAGE); return 0; }
    else if (a === '--out') opts.out = val();
    else if (a === '--report') opts.report = val();
    else if (a === '--json') opts.json = true;
    else if (a === '--no-schemas') opts.schemas = false;
    else if (a === '--no-annotations') opts.annotations = false;
    else if (a.startsWith('--')) usage(`Opción desconocida: ${a}.`);
    else if (input) usage('Solo se admite una descripción OpenAPI.');
    else input = a;
  }
  if (!input) usage('Falta la descripción OpenAPI (archivo o URL).');
  let doc;
  try { doc = await loadDocument(input); }
  catch (e) { console.error(`Error: ${e.message}`); return 1; }
  const r = analyze(doc, opts);
  const loaded = await loadDiscoverySchema();
  const validation = loaded ? { errors: validate(loaded.schema, stripAnnotations(r.discovery)) } : { errors: null, reason: 'no se encontró el esquema ni hay red' };
  r.validation = validation;
  const report = renderReport(r, { source: input, validation });
  if (opts.out) await writeFile(opts.out, JSON.stringify(r.discovery, null, 2) + '\n');
  if (opts.report) await writeFile(opts.report, report + '\n');
  if (opts.json) console.log(JSON.stringify(r, null, 2));
  else if (opts.report) {
    console.log(`${r.api.title}: ${r.collections.length} colecciones, ${r.findings.length} hallazgos.`);
    for (const p of PROFILES) console.log(`  ${p.padEnd(10)} ${r.scores[p].score === null ? '   —' : String(r.scores[p].score).padStart(4)}  ${r.scores[p].note}`);
    console.log(`Informe: ${opts.report}${opts.out ? `\nDescubrimiento: ${opts.out}` : ''}`);
  } else console.log(report);
  if (validation.errors?.length) console.error(`Aviso: el borrador no valida contra discovery.json (${validation.errors.length} errores).`);
  return 0;
}

function usage(msg) {
  console.error(`${msg}\n\n${USAGE}`);
  process.exit(2);
}

const isMain = () => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } };
if (process.argv[1] && isMain()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(`Error: ${e.stack ?? e.message}`); process.exitCode = 1; });
}
