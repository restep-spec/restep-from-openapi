#!/usr/bin/env node
// restep-from-openapi: reads an API described in OpenAPI 3.0, 3.1 or 3.2 and says what it lacks to
// comply with Restep 1 (https://restep.wubytes.com/1/), profile by profile, and writes a draft of its
// discovery document (§4.2). Node 18 or later, no dependencies.
//
// Usage:
//   restep-from-openapi <openapi.json|openapi.yaml|URL> [--out discovery.json] [--report report.md]
//                       [--json] [--no-schemas] [--no-annotations]
//
// It only reads the description: it does not call the API. To check a real server use restep-check.
import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseYaml } from './yaml.mjs';
import { validate } from './json-schema.mjs';

export { parseYaml, validate };

const VERSION = '0.3.0';
const SPEC = 'https://restep.wubytes.com/1/';
const SCHEMA_URL = 'https://restep.wubytes.com/1/schema/discovery.json';
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace', 'query'];
const PROFILES = ['core', 'query', 'writes', 'cache', 'relations', 'sync'];
// Restep version that the draft declares: the text this tool follows (§1.1).
export const RESTEP_VERSION = '1.0-draft.7';
// §6.1: the operators of this version; a server MUST NOT declare another.
const OPERATORS = ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'in', 'nin', 'null', 'prefix', 'contains'];

// Spec section → anchor on the Spanish page.
const ANCHORS = {
  '1.1': 'restep-versions', '1.2': 'dependencies', '3': 'data', '4.1': 'profile-header', '4.2': 'discovery', '4.3': 'describing', '4.4': 'health',
  '5.1': 'resources', '5.2': 'collections', '5.3': 'reserved', '5.4': 'errors', '5.5': 'versions', '5.6': 'language', '5.7': 'retries',
  '5.8': 'browser-clients', '5.9': 'singletons',
  '6': 'query', '6.1': 'filters', '6.2': 'sorting', '6.3': 'fields', '6.4': 'pagination', '6.5': 'counts',
  '7': 'writes', '7.1': 'idempotency', '7.2': 'concurrency', '7.3': 'minimal', '8': 'cache', '9': 'relations', '10': 'sync',
  '11': 'extensions', '11.1': 'actions', '11.2': 'batch', '11.3': 'filter-expr', '11.4': 'query-method', '11.5': 'oauth', '11.6': 'inheritance',
};
export const sectionLink = (s) => `[§${s}](${SPEC}#${ANCHORS[s] ?? ''})`;

// ── Loading ───────────────────────────────────────────────────────────────────

export async function loadDocument(src) {
  let text;
  if (/^https?:\/\//i.test(src)) {
    let res;
    try { res = await fetch(src, { headers: { accept: 'application/json, application/yaml, text/yaml, */*' }, signal: AbortSignal.timeout(20000) }); }
    catch (e) { throw new Error(`Could not download ${src}: ${e.cause?.message ?? e.message}`); }
    if (!res.ok) throw new Error(`Could not download ${src}: status ${res.status}.`);
    text = await res.text();
  } else {
    try { text = await readFile(src, 'utf8'); }
    catch (e) { throw new Error(e.code === 'ENOENT' ? `File ${src} does not exist.` : `Could not read ${src}: ${e.message}`); }
  }
  return parseDocument(text, src);
}

export function parseDocument(text, name = 'document') {
  const t = text.replace(/^﻿/, '').trimStart();
  let doc;
  if (t.startsWith('{')) {
    try { doc = JSON.parse(t); } catch (e) { throw new Error(`${name} is not valid JSON: ${e.message}`); }
  } else {
    try { doc = parseYaml(t); } catch (e) { throw new Error(`${name} cannot be read as YAML: ${e.message}`); }
  }
  if (!isObject(doc)) throw new Error(`${name} is not an OpenAPI object.`);
  if (doc.swagger) throw new Error(`${name} is Swagger ${doc.swagger}; this tool reads OpenAPI 3. Convert it first (for example with https://converter.swagger.io/ or "npx swagger2openapi").`);
  if (!/^3\.[0-2]/.test(String(doc.openapi ?? ''))) throw new Error(`${name} does not declare "openapi: 3.x" (it has ${JSON.stringify(doc.openapi ?? null)}).`);
  if (!isObject(doc.paths) && !isObject(doc.webhooks)) throw new Error(`${name} has no "paths".`);
  return doc;
}

// ── Utilities ──────────────────────────────────────────────────────────────

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
// Name grammar (§3) and dotted paths; templates with simple, distinct variables (§4.2).
const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const FIELD_PATH_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}(\.[A-Za-z][A-Za-z0-9_-]{0,63})*$/;
function templatePath(path) {
  const used = new Set();
  let prev = 'item';
  return path.split('/').map((seg) => {
    if (!isParam(seg)) { if (seg) prev = seg; return seg; }
    let v = seg.slice(1, -1).replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'id';
    if (used.has(v)) v = `${snake(singular(prev)) || 'item'}_id`;
    for (let i = 2, b = v; used.has(v); i++) v = `${b}_${i}`;
    used.add(v);
    return `{${v}}`;
  }).join('/');
}
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
const RESERVED_FIX = 'filter, sort, fields, include, count, limit, cursor, since and languages mean what Restep says (5.3): sort takes fields with "-" for descending, '
  + 'count=true asks for the total, limit is the page size, since belongs to sync and languages is not used. Rename your own parameter or give it the Restep meaning.';
const RPC_PREFIX = /^(get|list|fetch|create|update|delete|remove|set|add|do|find|search)[A-Z_]/;

// ── Analysis ────────────────────────────────────────────────────────────────

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
    this.allFields = new Map(); // field name → where
  }

  // A finding: those with the same id are grouped and the places accumulate.
  add(profile, id, severity, section, where, title, fix) {
    const key = id;
    let f = this.findings.get(key);
    if (!f) { f = { id, profile, severity, section, title, fix, where: [] }; this.findings.set(key, f); }
    for (const w of [].concat(where)) if (w && !f.where.includes(w)) f.where.push(w);
  }

  // Something that already complies; dropped at the end if there is a finding for any of the ids in `unless`.
  pass(profile, section, text, unless = []) {
    if (!this.passes.some((p) => p.profile === profile && p.text === text)) this.passes.push({ profile, section, text, unless });
  }

  // Local $refs (#/…). External ones are noted and treated as an empty schema.
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

  // Properties of an object schema, merging allOf (and, with less confidence, oneOf/anyOf).
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

  // The JSON schema of a successful response, and its media type.
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
    this.title = doc.info?.title ?? 'Untitled API';
    this.apiVersion = doc.info?.version ?? null;
    this.openapi = String(doc.openapi);
    // External $refs are not followed: all of them are noted for the report.
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

  // The API root: servers[0] plus a common version prefix (/api/v1) if every path carries it.
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
    if (m && m[2]) this.add('core', 'core.version.path-format', 'warning', '5.5', `root ${this.root}`,
      'The version in the path is not "v" followed by an integer.',
      'Put only the major version in the path (/v2/); minor versions are compatible changes and do not change the URL.');
    else if (this.majorVersion) this.pass('core', '5.5', `The major version is in the path (/v${this.majorVersion}/).`);
  }

  // Classifies each path as collection, item, action or standalone resource.
  classifyPaths() {
    const byPath = new Map();
    for (const o of this.ops) { if (!byPath.has(o.path)) byPath.set(o.path, []); byPath.get(o.path).push(o); }
    this.byPath = byPath;
    const collections = new Map(); // collection path → collection
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
    // Collections that exist only through their items are kept; actions hang from their base.
    this.collections = [...collections.values()].sort((a, b) => a.path.localeCompare(b.path));
    for (const a of actions) {
      const segs = a.base.split('/').filter(Boolean);
      const onItem = isParam(segs.at(-1));
      const cpath = onItem ? '/' + segs.slice(0, -1).join('/') : a.base;
      const c = collections.get(cpath);
      if (c) c.actions.push({ ...a, on: onItem ? 'item' : 'collection' });
      else others.push({ o: a.o, action: a });
    }
    // Subcollections: the parent is the item of another collection.
    for (const c of this.collections) {
      const segs = c.path.split('/').filter(Boolean);
      if (segs.length >= 2 && isParam(segs.at(-2))) {
        const parent = collections.get('/' + segs.slice(0, -2).join('/'));
        if (parent) { c.parent = parent; parent.children.push(c); }
      }
    }
    // Names: the last segment; if repeated, with the parent's in front.
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

  // Shape of a list response: bare array, wrapper with an array, or a plain object.
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
          this.add('core', 'core.version.header', 'error', '5.5', `${o.where} (header ${p.name})`,
            'The API version is in a header.', 'Restep puts the major version in the path (/v2/), never in headers, parameters or media types.');
        if (p.in === 'query' && /^(api[-_]?)?version$|^v$/.test(n))
          this.add('core', 'core.version.query', 'error', '5.5', `${o.where}?${p.name}`,
            'The API version is in a query parameter.', 'Put the major version in the path (/v2/) and remove the parameter.');
      }
      for (const r of Object.values(o.op.responses ?? {})) {
        for (const media of Object.keys(this.resolve(r)?.content ?? {}))
          if (/vnd\.[^;]*(\.v\d+|version=)|;\s*version=/i.test(media))
            this.add('core', 'core.version.media', 'error', '5.5', `${o.where} (${media})`,
              'The API version is in the media type.', 'Use application/json and put the major version in the path (/v2/).');
      }
    }
  }

  checkSecurity() {
    const schemes = Object.entries(this.doc.components?.securitySchemes ?? {}).map(([k, v]) => [k, this.resolve(v)]);
    this.oauth = schemes.some(([, s]) => s?.type === 'oauth2' || s?.type === 'openIdConnect');
    if (this.oauth) this.add('extensions', 'oauth.metadata', 'info', '11.5', schemes.filter(([, s]) => s?.type === 'oauth2' || s?.type === 'openIdConnect').map(([k]) => `securitySchemes.${k}`),
      'Uses OAuth 2.0: it can announce the oauth extension.',
      'Serve the protected resource metadata (RFC 9728) at /.well-known/oauth-protected-resource/<root> and put resource_metadata in the challenge of the 401 responses at the root.');
    for (const [k, s] of schemes)
      if (s?.type === 'apiKey' && s.in === 'query')
        this.add('extensions', 'oauth.query-token', 'warning', '11.5', `securitySchemes.${k} (?${s.name})`,
          'Credentials go in the query.', 'Send them in Authorization: a URL with the token ends up in logs and caches (RFC 6750, 2.3).');
  }

  checkOperations() {
    let anyErrors = false, problem = false;
    for (const o of this.ops) {
      const { method, op, where } = o;
      if (method === 'PUT') this.add('core', 'core.put', 'error', '5.1', where,
        'Uses PUT to update.', 'PUT is outside Restep 1: offer PATCH with JSON Merge Patch (application/merge-patch+json), where absent members are left untouched.');
      if (method === 'PATCH') {
        const body = this.resolve(op.requestBody);
        const medias = Object.keys(body?.content ?? {}).map(lc);
        if (medias.includes('application/merge-patch+json')) this.pass('core', '5.1', 'PATCH accepts application/merge-patch+json.', ['core.patch.json-patch', 'core.patch.media']);
        else if (medias.some((m) => m.includes('json-patch'))) this.add('core', 'core.patch.json-patch', 'error', '5.1', where,
          'PATCH uses JSON Patch (RFC 6902) instead of JSON Merge Patch.', 'Accept application/merge-patch+json (RFC 7396): an object with the fields that change; null deletes.');
        else this.add('core', 'core.patch.media', 'warning', '5.1', where,
          'PATCH does not declare application/merge-patch+json.', 'Declare and accept application/merge-patch+json; application/json with the same meaning is optional.');
      }
      // Errors
      const responses = Object.entries(op.responses ?? {});
      const errs = responses.filter(([code]) => /^[45]/.test(code) || code === 'default');
      if (!errs.length) this.add('core', 'core.error.missing', 'info', '5.4', where,
        'Declares no error responses.', 'Document at least the 4xx it can return, with application/problem+json.');
      for (const [code, r0] of errs) {
        anyErrors = true;
        const r = this.resolve(r0);
        const content = r?.content ?? {};
        const medias = Object.keys(content);
        if (!medias.length) continue;
        const pj = medias.find((m) => lc(m) === 'application/problem+json');
        if (!pj) this.add('core', 'core.error.media', 'error', '5.4', `${where} → ${code} (${medias.join(', ')})`,
          'Errors are not application/problem+json.', 'Answer 4xx and 5xx with application/problem+json (RFC 9457) and the members type, title, status and code.');
        else {
          problem = true;
          const props = this.props(content[pj].schema);
          if (Object.keys(props).length && !('code' in props))
            this.add('core', 'core.error.code', 'warning', '5.4', `${where} → ${code}`,
              'The problem+json has no "code".', 'Add code, with the values from the table in 5.4 (not_found, invalid, conflict…).');
        }
      }
      // Errors inside a 200
      const ok = this.successSchema(op, ['200']);
      if (ok?.schema) {
        const props = this.props(ok.schema);
        if (('success' in props && this.typeOf(props.success) === 'boolean') || ('ok' in props && this.typeOf(props.ok) === 'boolean') || ('error' in props && 'data' in props))
          this.add('core', 'core.error.in-200', 'warning', '5.4', where,
            'The 200 response carries a success or error flag.', 'An error never goes in a 200: use the HTTP status and problem+json. Remove success/ok/error from 200 responses.');
      }
      if (op.deprecated === true) this.add('core', 'core.deprecated', 'info', '5.5', where, 'Something is marked deprecated.',
            'Restep announces it in deprecations in the discovery document (§5.5), with its kind (field, filter, method, collection…), announced (the instant the notice was published, which does not change) and sunset when there is a date; responses that use it carry Deprecation and Link rel="deprecation". The draft does not declare it: OpenAPI does not say when it was announced.');
      // Credentials in the query, idempotency, conditionals
      for (const p of o.params) {
        const n = lc(p.name ?? '');
        if (p.deprecated === true) this.add('core', 'core.deprecated', 'info', '5.5', `${where}?${p.name}`, 'Something is marked deprecated.',
            'Restep announces it in deprecations in the discovery document (§5.5), with its kind (field, filter, method, collection…), announced (the instant the notice was published, which does not change) and sunset when there is a date; responses that use it carry Deprecation and Link rel="deprecation". The draft does not declare it: OpenAPI does not say when it was announced.');
        if (p.in === 'header' && n === 'idempotency-key') this.pass('writes', '7.1', 'POST requests accept Idempotency-Key.', ['writes.idempotency', 'writes.idempotency-name']);
        if (p.in === 'query' && n.startsWith('$')) this.add('core', 'core.reserved.dollar', 'error', '5.3', `${where}?${p.name}`,
          'Uses parameters that start with "$" (OData style).', 'Names with $ belong to Restep. Move to filter[…], sort, fields and limit (6), or to your own names without $.');
      }
      if (o.path.includes('//') || /\/$/.test(o.path) && o.path !== '/')
        this.add('core', 'core.path.slash', 'warning', '5.1', where, 'The path ends in "/".', 'The path of a collection or an item has no trailing "/" (5.1).');
    }
    if (problem) this.pass('core', '5.4', 'Errors use application/problem+json.', ['core.error.media']);
    this.anyErrors = anyErrors;
    // Paths that are neither collections nor items
    const loose = new Map();
    for (const x of this.others) {
      if (x.root) continue;
      if (x.rpc && x.o.method === 'GET' && /^(find|search|list|get|fetch)/i.test(x.o.path.split('/').at(-1)) && x.o.path.split('/').filter(Boolean).length > 1)
        this.add('query', 'query.search-path', 'warning', '6.1', x.o.where, 'A search has its own path.',
          'Filter on the collection itself: GET /pets?filter[status]=sold instead of GET /pets/findByStatus?status=sold, with the filters declared in the discovery document.');
      else if (x.rpc) this.add('core', 'core.rpc-path', 'warning', '5.1', x.o.where,
        'The path is a procedure name (RPC style).', 'Organize the API into collections and items (/users, /users/7) with GET, POST, PATCH and DELETE; everything else as actions (11.1).');
      else if (x.action) this.add('extensions', 'actions.verb-path', 'warning', '11.1', x.o.where,
        'A verb in the URL acts as an action.', `Declare it as an action: ${x.o.method === 'GET' ? 'GET' : 'POST'} ${this.prefix}${x.action.base}:${snake(x.action.name)}.`);
      else if (/^\/?(health|healthz|status|ping|livez|readyz)$/i.test(x.o.path.replace(/^\//, ''))) this.statusPath = x.o.rawPath;
      else { if (!loose.has(x.o.path)) loose.set(x.o.path, []); loose.get(x.o.path).push(x.o); }
    }
    this.findSingletons(loose);
  }

  // §5.9 (draft 6): a standalone resource that is a single object (/me, /settings) is declared as
  // a singleton if its path is not a template nor one that a collection or an item has or could
  // have, it allows GET and, at most, PATCH (a PUT becomes PATCH). The rest stay outside Restep.
  findSingletons(loose) {
    this.singletons = [];
    for (const [path, ops] of loose) {
      const methods = new Set(ops.map((o) => o.method));
      const get = ops.find((o) => o.method === 'GET');
      // §5.9 (draft 7): a singleton may hang from an item: its path is the item path followed by literal segments.
      const parent = this.collections.find((c) => c.itemPath && path.startsWith(c.itemPath + '/') && !path.slice(c.itemPath.length + 1).split('/').some(isParam));
      const ok = get && [...methods].every((m) => ['GET', 'HEAD', 'PATCH', 'PUT'].includes(m))
        && (parent ? !this.collections.some((c) => c.path === path || path.startsWith(c.path + '/') && c !== parent && c.path.length > parent.itemPath.length)
          : !path.split('/').some(isParam) && !this.collections.some((c) => path.startsWith(c.path + '/') || path === c.path));
      const shape = get && this.successSchema(get.op);
      const objectLike = !shape?.schema || this.listShape(shape.schema).kind === 'object';
      if (!ok || !objectLike) {
        for (const o of ops) this.add('core', 'core.non-resource', 'info', '5.9', o.where, 'Resource that is not a collection, item or singleton.',
          'It is outside Restep (§5.9): only 5.3, 5.4 and the Cache-Control rule of 5.1 apply to it, and it is not in the discovery document. If it is a single object with GET and PATCH, '
          + 'like /me or /settings, it can be declared as a singleton; if it creates or deletes things, consider a collection or an action.');
        continue;
      }
      const segs = path.split('/').filter(Boolean);
      let name = snake(segs.at(-1)) || 'resource';
      if (this.singletons.some((x) => x.name === name)) name = snake(segs.join('_')) || name;
      this.singletons.push({ name, path, parent, ops: Object.fromEntries(ops.map((o) => [o.method, o])) });
      this.add('core', 'core.singleton', 'info', '5.9', ops.map((o) => o.where), 'Standalone resource that the draft declares as a singleton.',
        'A singleton allows GET (and HEAD) and, at most, PATCH with merge patch; POST and DELETE get 405. Its relations carry href, and include and the other reserved parameters it does not implement give unsupported_parameter (§5.9).');
    }
    if (this.singletons.length) this.pass('core', '5.9', 'Single-object resources can be declared as singletons.');
  }

  checkCollections() {
    const writes = this.ops.some((o) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(o.method));
    this.hasWrites = writes;
    for (const c of this.collections) {
      const get = c.ops.GET;
      // List shape (§5.2)
      if (get) {
        const s = this.successSchema(get.op);
        const shape = s?.schema ? this.listShape(s.schema) : null;
        c.shape = shape;
        if (!shape) this.add('core', 'core.list.unknown', 'info', '5.2', get.where, 'The shape of the list response is not visible.', 'Document the schema: an object with items and next.');
        else if (shape.kind === 'array') this.add('core', 'core.list.array', 'error', '5.2', get.where,
          'The list responds with a bare array.', 'Respond with an object { "items": [...], "next": null }: that way pagination can be added later without breaking anyone.');
        else if (shape.kind === 'envelope') {
          if (shape.key !== 'items') this.add('core', 'core.list.envelope', 'error', '5.2', `${get.where} (${shape.key})`,
            'The list does not carry its items in "items".', `Rename "${shape.key}" to "items".`);
          else this.pass('core', '5.2', 'Lists carry their items in "items".', ['core.list.envelope', 'core.list.array']);
          const p = shape.props;
          if ('next' in p) this.pass('core', '5.2', 'Lists carry "next".', ['core.list.next', 'core.list.array']);
          else {
            const alt = Object.keys(p).find((k) => /^(next_?(cursor|page|token|link|url)?|nextpagetoken|cursor|links|_links|pagination|meta|paging)$/i.test(k));
            this.add('core', 'core.list.next', 'error', '5.2', `${get.where}${alt ? ` (${alt})` : ''}`,
              'The list has no "next".', 'Add next, always present: the URL of the next page (with its cursor) or null.');
          }
          if (['page', 'total_pages', 'totalpages', 'page_count', 'pagecount', 'offset'].some((k) => Object.keys(p).map(lc).includes(k)))
            this.add('query', 'query.pagination.offset', 'error', '6.4', `${get.where} (response)`, 'Paginates by offset or page number.',
              'Paginate with an opaque cursor carried in next (6.4); the server can keep an offset inside the cursor.');
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
          if (!h.location) this.add('core', 'core.post.location', 'warning', '5.1', post.where, 'The 201 does not declare Location.', 'A POST that creates responds 201 with Location and the representation of the item.');
          else this.pass('core', '5.1', 'POST requests that create respond 201 with Location.', ['core.post.status', 'core.post.location']);
        } else this.add('core', 'core.post.status', 'warning', '5.1', `${post.where} (${codes.join(', ')})`, 'Creating does not respond 201.', 'Respond 201 with Location and the representation of the created item.');
        const body = this.resolve(post.op.requestBody)?.content;
        const bm = body && Object.keys(body).find(isJsonMedia);
        const bodyProps = bm ? this.props(body[bm].schema) : {};
        // §5.1 (draft 6): the client may choose the id if the collection declares it in id_from.
        if ('id' in bodyProps && !this.resolve(bodyProps.id)?.readOnly) {
          c.idFrom = this.requiredOf(body[bm].schema).includes('id') ? 'client' : 'either';
          this.add('core', 'core.post.id', 'info', '5.1', `${post.where} (${this.refName(body[bm].schema) ? `schema ${this.refName(body[bm].schema)}` : 'body'} → id_from ${c.idFrom})`,
            'The create body accepts id: the client chooses the id.',
            'The draft declares it with id_from ("client" if the id is required, "either" if not). The server then validates the id (422 with type or format), '
            + 'responds 409 with a taken entry to an id the collection has or has had, and should require a hard-to-guess format, such as a UUID (§13.6). '
            + 'If the server actually assigns it, remove it from the body or mark it readOnly: a POST with id gets 422 with read_only.');
        }
        // §3: the body of a POST to a collection is application/json; another type gives 415.
        this.checkJsonBody(post, c);
        const h = post.params.find((p) => p.in === 'header' && /idempoten/i.test(p.name));
        if (!h) this.add('writes', 'writes.idempotency', 'warning', '7.1', post.where, 'POST requests do not accept Idempotency-Key.',
          'Accept Idempotency-Key (a Structured Fields string) and return the same response when the request is repeated.');
        else if (lc(h.name) !== 'idempotency-key') this.add('writes', 'writes.idempotency-name', 'warning', '7.1', `${post.where} (${h.name})`,
          'The idempotency key is not called Idempotency-Key.', 'Use the Idempotency-Key header, the one from the IETF draft.');
      }
      // Item
      const iget = c.itemOps.GET;
      if (iget) {
        const s = this.successSchema(iget.op, ['200']);
        const h = s ? this.headersOf(s.response) : {};
        c.itemSchema = s?.schema;
        if (h.etag) this.pass('writes', '7.2', 'The GET of an item declares ETag.', ['writes.etag']);
        else if (writes) this.add('writes', 'writes.etag', 'error', '7.2', iget.where, 'The item GET does not declare ETag.',
          'Return a strong ETag of the full representation; it is what makes If-Match possible.');
        this.checkCacheControl(h, iget.where);
        if (!h.etag) this.cacheMissing = true;
      }
      if (get) this.checkCacheControl(this.headersOf(this.successSchema(get.op)?.response), get.where);
      for (const m of ['PATCH', 'PUT', 'DELETE']) {
        const o = c.itemOps[m];
        if (!o) continue;
        const ifMatch = o.params.some((p) => p.in === 'header' && lc(p.name) === 'if-match') || '412' in (o.op.responses ?? {});
        if (ifMatch) this.pass('writes', '7.2', 'Writes accept If-Match.', ['writes.if-match']);
        else this.add('writes', 'writes.if-match', 'warning', '7.2', o.where, 'Writes do not accept If-Match.',
          'Evaluate If-Match against the ETag of the item in PATCH and DELETE, and respond 412 precondition_failed if it does not match.');
      }
      if (c.itemOps.POST) this.add('core', 'core.item-post', 'warning', '5.1', c.itemOps.POST.where, 'A POST on an item.',
        'To change an item, PATCH with JSON Merge Patch; for an operation that is not an update, a declared action (POST /pets/{id}:name).');
      const del = c.itemOps.DELETE;
      if (del) {
        const codes = Object.keys(del.op.responses ?? {});
        if (!codes.includes('204')) this.add('core', 'core.delete.status', 'warning', '5.1', `${del.where} (${codes.filter((k) => /^2/.test(k)).join(', ') || 'no 2xx'})`,
          'Deleting does not respond 204.', 'DELETE responds 204 with no body.');
      }
      c.itemSchema ??= c.listItemSchema ?? (post && this.successSchema(post.op, ['201'])?.schema);
      if (c.itemPath) {
        const pname = c.itemPath.split('/').filter(Boolean).at(-1).slice(1, -1);
        const pp = c.itemOps.GET?.params.find((p) => p.in === 'path' && p.name === pname) ?? Object.values(c.itemOps)[0]?.params.find((p) => p.in === 'path' && p.name === pname);
        const t = pp ? this.typeOf(pp.schema) : null;
        if (t === 'integer' || t === 'number') this.add('core', 'data.id.type', 'error', '3', `${c.itemPath} ({${pname}}: ${t})`,
          'The identifier is a number.', 'The id is always a string ("7"): that way the id generator can change without breaking clients.');
      }
      this.checkQueryParams(c);
      // Actions
      for (const a of c.actions) {
        if (a.style === 'colon') this.pass('extensions', '11.1', 'Actions use the colon form (/orders/{id}:cancel).');
        else this.add('extensions', 'actions.verb-path', 'warning', '11.1', a.o.where,
          'A verb in the URL acts as an action.', 'Declare it as an action with a colon: POST /orders/{id}:cancel instead of POST /orders/{id}/cancel.');
        if (a.o.method === 'POST') this.checkJsonBody(a.o);
        if (lc(a.name) === 'search' && a.o.method === 'POST') this.add('extensions', 'query-method.search', 'info', '11.4', a.o.where,
          'A search via POST.', 'If it is for queries that do not fit in the URL, Restep has QUERY (the query-method extension) with the same filters as GET; otherwise, use GET with filter[…].');
      }
      if (c.ops.QUERY) this.pass('extensions', '11.4', 'Uses the QUERY method.');
    }
    // Batches
    for (const o of this.ops) if (/\/(batch|bulk)(\/|$|:)/i.test(o.path) || /:(batch|bulk)\w*$/i.test(o.path))
      this.add('extensions', 'batch.bulk', 'info', '11.2', o.where, 'There are batch operations.',
        'Restep has the batch extension: a single POST with ordered operations, references between them and an atomic mode.');
    if (!this.collections.length) this.add('core', 'core.no-collections', 'error', '5.2', 'whole document',
      'No collection is recognized.', 'Restep organizes the API into collections (/books) and items (/books/7).');
  }

  // The required of an object schema, merging allOf.
  requiredOf(schema, depth = 0) {
    const s = this.resolve(schema);
    if (!isObject(s) || depth > 8) return [];
    return [...(Array.isArray(s.required) ? s.required : []), ...(s.allOf ?? []).flatMap((x) => this.requiredOf(x, depth + 1))];
  }

  // §3 (draft 6): a request with a body to a Restep resource (POST to a collection or to an
  // action) carries Content-Type: application/json; any other type, or none, gives 415.
  checkJsonBody(o, c = null) {
    const body = this.resolve(o.op.requestBody);
    const medias = Object.keys(body?.content ?? {});
    // §5.1 (draft 7): a POST to a collection that carries the bytes of a file is an upload: the collection
    // declares upload with those media types, and multipart/form-data with one binary part, named file, as
    // "multipart": true. Council, round 4: only application/json creates an item from JSON (1b), so a +json type
    // (application/ld+json) is a file like any other, and */* is a media range that admits every type (2).
    if (c) {
      const types = [], suffixed = [], at = (m) => this.resolve(body.content[m]?.schema);
      const range = (t) => t === '*/*' || /^[a-z0-9][a-z0-9!#$&^_.+-]*\/(\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/.test(t);
      let multipart = false;
      for (const m of medias) {
        const t = lc(m).split(';')[0].trim();
        if (t === 'application/json' || t === 'application/x-www-form-urlencoded') continue;
        if (t === 'multipart/form-data') {
          const props = this.props(at(m));
          const file = this.resolve(props.file);
          if (Object.keys(props).length === 1 && file && (file.format === 'binary' || file.contentMediaType)) {
            multipart = true;
            const enc = body.content[m].encoding?.file?.contentType;
            for (const x of String(enc ?? file.contentMediaType ?? 'application/octet-stream').split(',')) {
              const y = lc(x.split(';')[0].trim());
              if (range(y)) types.push(y);
            }
          }
          continue;
        }
        if (range(t)) { types.push(t); if (t.endsWith('+json')) suffixed.push(t); }
      }
      // A +json body that the OpenAPI document describes as an object most likely creates an item: in Restep it is a file.
      if (suffixed.length)
        this.add('core', 'core.upload.json-suffix', 'warning', '5.1', `${o.where} (${suffixed.join(', ')})`, 'The POST takes a +json media type.',
          'Only a request whose own Content-Type is application/json creates an item from JSON (§5.1); any other type, a +json one included, is the bytes of a file. '
          + 'The draft declares it in upload; if the body creates an item, the client sends it as application/json instead.');
      if (types.length) {
        // §5.1 (council, round 3, decisions 1 and 2): schemas.create announces creation from JSON, so the collection
        // declares it if and only if the POST also takes JSON. Then a JSON POST always creates an item, and a JSON file
        // (application/json, also by application/* or */*) only travels as the file part of multipart/form-data, which
        // the collection declares with "multipart": true.
        const acceptsJson = medias.some((m) => lc(m).split(';')[0].trim() === 'application/json');
        const jsonFiles = types.some((t) => t === 'application/json' || t === 'application/*' || t === '*/*');
        c.createsFromJson = acceptsJson;
        if (acceptsJson && jsonFiles && !multipart) {
          multipart = true;
          this.add('core', 'core.upload.json-file', 'warning', '5.1', o.where, 'The collection takes JSON files and creates items from JSON.',
            'A POST with application/json to it always creates an item from its fields, never a file: a JSON file only travels as the file part of multipart/form-data, '
            + 'so the collection declares "multipart": true (§5.1). OpenAPI does not describe that multipart body; the draft declares it, and the server has to accept it.');
        }
        c.upload = { media_types: [...new Set(types)], ...(multipart && { multipart: true }) };
        this.add('core', 'core.upload', 'info', '5.1', `${o.where} (${medias.join(', ')})`, 'The POST carries the bytes of a file.',
          'Restep declares it with upload on the collection (§5.1): the media types it takes (415 to any other), max_size (413 content_too_large above it) and, for multipart/form-data with one part named file, "multipart": true. '
          + 'The item it creates carries _content with href, media_type and size. The draft declares upload; add max_size by hand.');
        // §5.1 (council, decision 2; round 4, 1a): a collection that does not create items from JSON answers a JSON
        // body with 415, unless its media_types admit application/json, also by a wildcard: then that body is a file.
        if (!acceptsJson && !jsonFiles)
          this.add('core', 'core.upload.only', 'info', '5.1', o.where, 'The collection only takes files, not JSON.',
            'A POST with a JSON body to it gets 415 unsupported_media_type, not 422, and that 415 SHOULD carry Accept-Post with the media types it takes (§5.1); '
            + 'a browser client needs Accept-Post in Access-Control-Expose-Headers (§5.8).');
        return;
      }
    }
    if (!medias.length || medias.some((m) => lc(m).split(';')[0].trim() === 'application/json')) return;
    this.add('core', 'core.request.media', 'error', '3', `${o.where} (${medias.join(', ')})`, 'The request body is not application/json.',
      'A POST to a collection or an action carries Content-Type: application/json, and the server responds 415 unsupported_media_type to any other type (forms and multipart included) or to a body without it. '
      + 'A file is uploaded to a collection that declares upload (§5.1).');
  }


  // Cache profile (§8): every read carries an explicit Cache-Control, and an item GET, ETag.
  // Since draft 6 it is a profile apart from writes. That a response that depends on the
  // credentials carries private or no-store is required of every server by §5.1, but OpenAPI does not show
  // the header value.
  checkCacheControl(h, where) {
    if (h['cache-control']) { this.cacheHint = true; this.pass('cache', '8', 'Reads document Cache-Control.', ['cache.cache-control']); return; }
    this.cacheMissing = true;
    this.add('cache', 'cache.cache-control', 'info', '8', where, 'Reads do not document Cache-Control.',
      'With the cache profile, every response to GET or HEAD, errors included, carries an explicit Cache-Control, and the GET of an item an ETag. '
      + 'Whether or not you announce cache, a response that depends on credentials carries private or no-store (§5.1).');
  }

  // Query parameters of the list (§5.3, §6) and what can be inferred for discovery.
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
    c.namedFilters = {};
    // §6.1 (draft 6): a field whose value is a list is not declared in filter (whether it means "some
    // element" or "all" is left for a minor version). A parameter on it becomes a named filter,
    // whose description says what it returns; a dotted one that crosses the list is dropped.
    const listPath = (field) => this.typeOf(itemProps[field.split('.')[0]]) === 'array';
    const addNamed = (field, schema, source, why) => {
      const itemSchema = this.typeOf(schema) === 'array' ? this.resolve(schema).items : schema;
      const listItems = this.resolve(itemProps[field])?.items;
      const decl = this.filterType(listItems ?? itemSchema, '', { itemSchema: {} });
      c.namedFilters[field] ??= { type: decl.type, ...(decl.values ? { values: decl.values } : {}), description: why, sources: [] };
      c.namedFilters[field].sources.push(source);
    };
    const addFilter = (field, op, schema, confidence, source) => {
      if (listPath(field)) {
        if (field.includes('.')) {
          this.add('query', 'query.filter.list', 'warning', '6.1', `${source} → ${field}`, 'A filter goes through a field that is a list.',
            'Restep 1 does not declare in filter or sort a field that is a list, nor a path that goes through a to-many relation (§6.1). For that criterion, declare a named filter (named_filters) with a description of which items it returns.');
          return 'dropped';
        }
        // §6.1 (draft 7): a field whose value is a list of scalars is declared with "quantifier": "some" and the
        // type of its elements: an item matches when some element does. Never with ne or nin.
        const listItems = this.resolve(itemProps[field])?.items;
        const elem = listItems ?? (this.typeOf(schema) === 'array' ? this.resolve(schema).items : schema);
        const qop = op === 'in' || (this.typeOf(schema) === 'array' && op !== 'null') ? 'in' : op;
        // §6.1 (council, decision 1): null on a list of objects, which is kept only if it is a to-many relation,
        // is declared with the type of the related items' id, string, and without quantifier.
        if (this.typeOf(elem) === 'object' || this.typeOf(elem) === 'array') {
          if (qop !== 'null') return 'dropped';
          const f = (c.filters[field] ??= { ops: [], schema: { type: 'string' }, relationNull: true, confidence: 'low', sources: [] });
          if (!f.ops.includes('null')) f.ops.push('null');
          f.sources.push(source);
          return 'quantifier';
        }
        const f = (c.filters[field] ??= { ops: [], schema: elem, elem, quantifier: 'some', confidence: 'low', sources: [] });
        if (!['ne', 'nin'].includes(qop) && !f.ops.includes(qop)) f.ops.push(qop);
        f.sources.push(source);
        this.add('query', 'query.filter.list', 'info', '6.1', `${source} → filter[${field}]`, 'A filter on a field that is a list.',
          'Restep 1 declares it in filter with "quantifier": "some" and the type of its elements (§6.1): an item matches when some element matches. The draft declares it so; check that the API means "some element". '
          + 'With null as its only operator (an empty list is null) it carries no quantifier.');
        return 'quantifier';
      }
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
        this.pass('query', '6.1', 'Filters use filter[field][op].', ['query.filter.name']);
        continue;
      }
      if (n.startsWith('$')) continue; // already warned
      switch (n) {
        case 'limit':
          if (t === 'integer' || t === 'number') { this.pass('query', '6.4', 'The page size is requested with limit.', ['query.limit.name']); c.maxLimit = schema.maximum; }
          else this.add('core', 'core.reserved.conflict', 'error', '5.3', where, 'Uses a reserved parameter with another meaning.', RESERVED_FIX);
          if (schema.maximum === undefined) this.add('query', 'query.limit.max', 'warning', '6.4', where, 'limit declares no maximum.',
            'A collection that accepts limit declares max_limit, and without it limit gives unsupported_parameter (§6.4). Declare the maximum (maximum in OpenAPI, max_limit in the discovery document); out of range, invalid_parameter.');
          continue;
        case 'cursor': this.pass('query', '6.4', 'Paginates with a cursor.', ['query.pagination.offset', 'query.pagination.cursor-param']); continue;
        case 'fields': this.pass('query', '6.3', 'Supports fields.'); c.fields = true; continue;
        case 'include': c.includeValues = this.enumOf(schema) ?? []; this.pass('relations', '9', 'Relations are expanded with include.', ['relations.expand']); continue;
        case 'count':
          if (t === 'boolean') { c.count = true; this.pass('query', '6.5', 'Supports count=true.'); }
          else if (t === 'integer') this.add('query', 'query.limit.name', 'warning', '6.4', where, 'The page size is not called limit.', 'Call it limit; count is reserved and in Restep asks for the total (count=true, 6.5).');
          else this.add('core', 'core.reserved.conflict', 'error', '5.3', where, 'Uses a reserved parameter with another meaning.', RESERVED_FIX);
          continue;
        case 'sort': {
          const vals = this.enumOf(schema);
          if (vals && vals.every((v) => /^(asc|desc|ascending|descending)$/i.test(v)))
            this.add('core', 'core.reserved.conflict', 'error', '5.3', where, 'Uses a reserved parameter with another meaning.', RESERVED_FIX);
          else {
            this.pass('query', '6.2', 'Sorting is requested with sort.', ['query.sort.name']);
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
            this.pass('query', '6.1', 'Filters use filter[field][op].', ['query.filter.name']);
          } else this.add('extensions', 'filter-expr.string', 'warning', '11.3', where, 'filter is a text expression.',
            'For filter=<expression> Restep requires the filter-expr extension (AIP-160 syntax with mandatory parentheses); also declare the fields in filter.');
          continue;
        case 'since':
        case 'languages':
          this.add('core', 'core.reserved.conflict', 'error', '5.3', where, 'Uses a reserved parameter with another meaning.', RESERVED_FIX);
          continue;
      }
      if (/^(offset|skip|start|page|page_?number|pagenumber|page_?index|pageno|from_?index)$/i.test(n)) {
        this.add('query', 'query.pagination.offset', 'error', '6.4', where, 'Paginates by offset or page number.',
          'Paginate with an opaque cursor carried in next (6.4); the client follows next as is. The server can keep the offset inside the cursor.');
        continue;
      }
      if (/^(page_?token|after|before|starting_?after|ending_?before|next_?token|next_?cursor|continuation(_?token)?|marker|page_?cursor|cursor_?\w+|\w+_cursor)$/i.test(n)) {
        this.add('query', 'query.pagination.cursor-param', 'warning', '6.4', where, 'The cursor is not called cursor.', 'Call it cursor, make it opaque and put it in next; the client does not build it.');
        continue;
      }
      if (/^(page_?size|per_?page|size|top|take|max_?results|max_?items|maxpagesize|max|n)$/i.test(n)) {
        this.add('query', 'query.limit.name', 'warning', '6.4', where, 'The page size is not called limit.', 'Call it limit, with a declared maximum (max_limit).');
        if (t === 'integer') c.maxLimit = schema.maximum;
        continue;
      }
      if (/^(sort_?by|order_?by|ordering|order|sort_?order|sort_?dir(ection)?|direction|dir|sort_?field)$/i.test(n)) {
        this.add('query', 'query.sort.name', 'warning', '6.2', where, 'Sorting does not use sort.', 'Use sort=field1,-field2 ("-" for descending) and declare the sortable fields in sort.');
        const vals = this.enumOf(schema);
        if (vals && !vals.every((v) => /^(asc|desc|ascending|descending)$/i.test(v))) c.sort.push(...vals.map((v) => String(v).replace(/^[-+]/, '').replace(/[:.](asc|desc)$/i, '')));
        else if (!vals && !/order$|dir|direction/i.test(n)) c.sortConfidence = 'low';
        continue;
      }
      if (/^(select|projection|attributes|only|field_?mask|fieldmask)$/i.test(n)) {
        this.add('query', 'query.fields.name', 'warning', '6.3', where, 'Field selection does not use fields.', 'Use fields=field1,field2 (plus id and the _ members).');
        continue;
      }
      if (/^(expand|embed|with|includes|populate|join)$/i.test(n)) {
        this.add('relations', 'relations.expand', 'warning', '9', where, 'Relation expansion does not use include.', 'Use include=relation (with dotted paths up to include_depth) and declare the expandable relations.');
        continue;
      }
      if (/^(include_?total|with_?count|total|count_?total|with_?total|totals|inlinecount)$/i.test(n)) {
        this.add('query', 'query.count.name', 'warning', '6.5', where, 'The total is not requested with count.', 'Use count=true, which adds total to the response, and declare count on the collection.');
        c.count = true;
        continue;
      }
      if (/^(q|query|search|term|keyword|keywords|text|search_?term|fulltext)$/i.test(n)) {
        // §6.1: a criterion that does not compare a field is a named filter, with its description.
        const nf = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) ? name : 'search';
        addNamed(nf, schema, where, firstSentence(p.description) ?? `Free-text search (inferred from ?${name}: describe which fields it looks at and how it compares).`);
        this.add('query', 'query.search', 'info', '6.1', `${where} → filter[${nf}]`, 'Free-text search.',
          'Restep expresses it as a named filter (named_filters): filter[' + nf + ']=text, declared with type string and a description saying which items it returns. '
          + 'Your own parameter can stay too, since it is not reserved.');
        continue;
      }
      if (/^(updated_?(since|after)|modified_?(since|after)|changed_?since|sync_?token|delta(_?token)?|last_?sync)$/i.test(n)) {
        this.add('sync', 'sync.delta', 'warning', '10', where, 'Sync uses its own parameter.', 'Offer GET /collection:changes?since=<state> with created, updated and destroyed, and state in every list.');
        this.syncHint = true;
        // Also valid as a date filter
      }
      // The rest: a named filter that is not reserved.
      const inferred = this.inferFilter(name, schema, matchField);
      const routed = addFilter(inferred.field, inferred.op, inferred.schema ?? schema, inferred.confidence, where);
      if (inferred.op2 && !routed) addFilter(inferred.field, inferred.op2, inferred.schema ?? schema, inferred.confidence, where);
      const target = routed === 'named' || inferred.op === 'eq' ? `filter[${inferred.field}]` : `filter[${inferred.field}][${inferred.op}]`;
      this.add('query', 'query.filter.name', 'warning', '6.1', `${where} → ${target}`, 'Filters use their own names, not filter[field][op].',
        'Move each filter to filter[field] or filter[field][op] and declare field, type and operators in filter: that way a filter the server does not know gives 400 instead of returning the whole collection.');
    }
    if (!anyQuery) this.add('query', 'query.absent', 'warning', '6', get.where, 'The list supports no filters, sorting or page size.',
      'With query, the collection declares its filters, its sort and max_limit; without it, the server must respond 400 to those parameters (5.3).');
  }

  enumOf(schema) {
    const s = this.resolve(schema);
    if (Array.isArray(s?.enum)) return s.enum;
    if (this.typeOf(s) === 'array' && Array.isArray(this.resolve(s.items)?.enum)) return this.resolve(s.items).enum;
    return null;
  }

  // Infers field and operator from a free-named parameter: min_price → price ge, created_after → created_at gt…
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

  // Data types, names and identifiers (§3), over the item schemas.
  checkFields() {
    const seen = new Set();
    const camel = [], snakeNames = [];
    const visit = (schema, where, depth = 0) => {
      if (depth > 3) return;
      const name = this.refName(schema);
      const key = name ?? where;
      if (seen.has(key)) return;
      seen.add(key);
      const at = name ? `schema ${name}` : where;
      const props = this.props(schema);
      for (const [k, v0] of Object.entries(props)) {
        const v = this.resolve(v0);
        const t = this.typeOf(v);
        if (/[a-z][A-Z]/.test(k)) camel.push(`${at}.${k}`);
        else if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(k)) snakeNames.push(`${at}.${k}`);
        if (v?.deprecated === true) this.add('core', 'core.deprecated', 'info', '5.5', `${at}.${k}`, 'Something is marked deprecated.',
            'Restep announces it in deprecations in the discovery document (§5.5), with its kind (field, filter, method, collection…), announced (the instant the notice was published, which does not change) and sunset when there is a date; responses that use it carry Deprecation and Link rel="deprecation". The draft does not declare it: OpenAPI does not say when it was announced.');
        if (k.startsWith('_')) this.add('core', 'data.underscore', 'error', '3', `${at}.${k}`, 'A field starts with "_".', 'Members with _ belong to Restep (_etag, _actions…): rename the field.');
        if (k !== 'id' && t === 'integer' && (v.format === 'int64' || v.format === 'uint64'))
          this.add('core', 'data.int64', 'warning', '3', `${at}.${k}`, 'A 64-bit integer is sent as a number.', 'If it can exceed ±(2^53−1), send it as a string in every representation.');
        if (t === 'number' && MONEY.test(k))
          this.add('core', 'data.money', 'warning', '3', `${at}.${k}`, 'An amount is sent as a number.', 'Amounts go as a decimal string ("18.50"), together with their ISO 4217 currency.');
        if ((t === 'integer' || t === 'number') && /(_at|At|timestamp|Timestamp|_time|Time|_date|Date)$/.test(k))
          this.add('core', 'data.timestamp-number', 'warning', '3', `${at}.${k}`, 'An instant is sent as a number.', 'Instants go as RFC 3339 date-time with offset ("2026-11-12T09:30:00Z").');
        if (t === 'string' && !v.format && /(_at|At|_date|Date|_on)$/.test(k))
          this.add('core', 'data.date-format', 'info', '3', `${at}.${k}`, 'A date or instant with no declared format.', 'Declare format: date-time (RFC 3339 with offset) or format: date.');
        if (k !== 'id' && /^(.+?)(_id|Id|ID)$/.test(k) && (t === 'string' || t === 'integer'))
          this.add('relations', 'relations.scalar-fk', 'warning', '3', `${at}.${k}`, 'A relation is sent as a bare identifier.',
            'A relation is an object with id: "owner": {"id": "4"}, so the type does not change when the item is included (3, 9).');
        if (/^(.+?)(_ids|Ids|IDs)$/.test(k) && t === 'array')
          this.add('relations', 'relations.id-array', 'warning', '3', `${at}.${k}`, 'A to-many relation is sent as a list of identifiers.',
            'A to-many relation is a list of objects with id, or better a subcollection if it can grow without limit (9).');
        if (t === 'object' && depth < 2 && !this.refName(v0)) visit(v, `${at}.${k}`, depth + 1);
      }
    };
    for (const c of this.collections) {
      const schema = c.itemSchema ?? c.listItemSchema;
      if (!schema) continue;
      const name = this.refName(schema);
      const at = name ? `schema ${name}` : `${c.path}`;
      const props = this.props(schema);
      if (Object.keys(props).length) {
        if (!('id' in props)) {
          const alt = Object.keys(props).find((k) => /^(uuid|_id|key|guid|\w+_?id)$/i.test(k));
          this.add('core', 'data.id.missing', 'warning', '3', `${at}${alt ? ` (${alt})` : ''}`, 'The item has no "id" field.', 'The identifier of an item is called id and is a string.');
        } else {
          const t = this.typeOf(props.id);
          if (t === 'integer' || t === 'number') this.add('core', 'data.id.type', 'error', '3', `${at}.id (${t})`,
            'The identifier is a number.', 'The id is always a string ("7"): that way the id generator can change without breaking clients.');
          else if (t === 'string') this.pass('core', '3', 'Ids are strings.', ['data.id.type']);
        }
      }
      visit(schema, c.path);
      for (const s of [this.resolve(c.ops.POST?.op.requestBody)?.content, this.resolve(c.itemOps.PATCH?.op.requestBody)?.content])
        if (s) for (const m of Object.values(s)) if (m.schema) visit(m.schema, c.path);
    }
    if (camel.length && snakeNames.length) this.add('core', 'data.naming', 'warning', '3', [`camelCase: ${camel.slice(0, 3).join(', ')}`, `snake_case: ${snakeNames.slice(0, 3).join(', ')}`],
      'Fields mix camelCase and snake_case.', 'Follow a single convention for field names; the ones Restep defines are snake_case.');
  }

  checkSync() {
    for (const o of this.ops) {
      if (/:changes$/.test(o.path)) { this.pass('sync', '10', 'Offers :changes.'); this.syncHint = true; this.syncNative = true; }
      else if (/\/(changes|delta|sync)$/i.test(o.path)) {
        this.add('sync', 'sync.endpoint', 'warning', '10', o.where, 'Sync has its own endpoint.', 'Restep uses GET /collection:changes?since=<state> per collection, with state in every list.');
        this.syncHint = true;
      }
      if (o.op.callbacks && Object.keys(o.op.callbacks).length) this.webhooks = true;
    }
    if (isObject(this.doc.webhooks) && Object.keys(this.doc.webhooks).length) this.webhooks = true;
    if (this.webhooks) {
      this.add('sync', 'sync.webhooks', 'info', '10', 'webhooks/callbacks', 'Notifies changes with webhooks.',
        'Webhooks can stay; to keep copies up to date Restep uses :changes and, if you want to push notifications, an SSE channel declared in events.');
      this.syncHint = true;
    }
    if (this.syncHint && !this.syncNative) this.add('sync', 'sync.changes', 'error', '10', 'all collections', 'There is no :changes or state.',
      'The collection declares sync (and the API the sync profile, experimental: §1.2); every list carries state; GET /collection:changes?since=<state> returns created, updated and destroyed; and the collection declares filter[id] with in.');
  }

  // ── Discovery draft ──────────────────────────────────────────

  buildDiscovery() {
    const ann = this.options.annotations !== false;
    const withSchemas = this.options.schemas !== false;
    // §1.1: a server that implements a draft declares it with its suffix.
    const d = { restep: RESTEP_VERSION };
    if (this.majorVersion) d.version = this.majorVersion;
    const collections = {};
    const lowNotes = [];
    // Collection keys: valid names (§3) and no repeats; computed first so that
    // parent and relations can name any of them.
    const nameOf = new Map();
    for (const c of this.collections) {
      const base = NAME_RE.test(c.name) ? c.name : (snake(c.name) || 'collection');
      let key = base;
      for (let i = 2; [...nameOf.values()].includes(key); i++) key = `${base}_${i}`;
      nameOf.set(c, key);
    }
    for (const c of this.collections) c.declaredPath = templatePath(c.path);
    const bySchema = new Map();
    for (const c of this.collections) { const n = this.refName(c.itemSchema); if (n) bySchema.set(n, c); }
    let anyQuery = false, anyRelations = false, anyActions = false;
    for (const c of this.collections) {
      const notes = [];
      const out = { path: c.declaredPath };
      if (c.declaredPath !== c.path) notes.push(`path: template variables are renamed to be distinct and simple (§4.2); in OpenAPI it is ${c.path}`);
      // §4.2: a subcollection names in parent the collection whose items it hangs from.
      if (c.parent) out.parent = nameOf.get(c.parent);
      const desc = firstSentence(c.ops.GET?.op.summary) ?? firstSentence(c.ops.GET?.op.description) ?? firstSentence(this.tagDescription(c));
      if (desc) out.description = desc;
      const methods = ['GET', 'POST', 'PATCH', 'DELETE'].filter((m) => c.ops[m]);
      const itemMethods = ['GET', 'PATCH', 'DELETE'].filter((m) => c.itemOps[m]);
      if (c.itemOps.PUT && !c.itemOps.PATCH) { itemMethods.splice(1, 0, 'PATCH'); notes.push('item_methods: PATCH comes from the PUT, which Restep does not allow'); }
      if (methods.length) out.methods = methods;
      if (c.idFrom) { out.id_from = c.idFrom; notes.push(`id_from: ${c.idFrom}, because the create body accepts id${c.idFrom === 'client' ? ' and requires it' : ''} (§5.1)`); }
      if (c.itemPath && itemMethods.length) out.item_methods = itemMethods;
      else if (!c.itemPath) notes.push('there is no item path (/{id}) in OpenAPI');
      // Schemas
      if (withSchemas) {
        const schemas = {};
        if (c.itemSchema) schemas.item = this.toJsonSchema(c.itemSchema);
        const create = this.resolve(c.ops.POST?.op.requestBody)?.content;
        const cm = create && Object.keys(create).find(isJsonMedia);
        if (cm && create[cm].schema) {
          schemas.create = this.toJsonSchema(create[cm].schema);
          if (!c.idFrom && this.dropId(schemas.create)) notes.push('schemas.create: id removed, the server assigns it');
          // §4.3 (draft 7): a default in a top-level property of create is the value the field takes, and MUST be
          // valid against the property's schema. An invalid one is reported and left out.
          for (const [f, prop] of Object.entries(isObject(schemas.create.properties) ? schemas.create.properties : {})) {
            if (!isObject(prop) || !('default' in prop)) continue;
            const { default: value, ...rest } = prop;
            const errors = validate({ ...rest, $defs: schemas.create.$defs }, value);
            if (!errors.length) continue;
            delete prop.default;
            notes.push(`schemas.create.${f}: default ${JSON.stringify(value)} removed, it is not valid against the property (§4.3)`);
            this.add('core', 'core.schema.default', 'warning', '4.3', `${c.ops.POST.where} → ${f}`, 'A default that its own property does not accept.',
              `default ${JSON.stringify(value)} does not fit the schema of ${f} (${errors[0].message}). In Restep the server gives the field that value when a POST leaves it out, and it MUST be valid (§4.3): fix it or remove it. The draft leaves it out.`);
          }
        }
        const upd = this.resolve(c.itemOps.PATCH?.op.requestBody)?.content;
        const um = upd ? (Object.keys(upd).find((m) => /merge-patch\+json/i.test(m)) ?? Object.keys(upd).find(isJsonMedia)) : null;
        if (um && upd[um].schema && !/json-patch/i.test(um)) {
          schemas.update = this.toJsonSchema(upd[um].schema);
          if (this.dropId(schemas.update)) notes.push('schemas.update: id removed, it does not change');
        }
        else {
          const put = this.resolve(c.itemOps.PUT?.op.requestBody)?.content;
          const pm = put && Object.keys(put).find(isJsonMedia);
          if (pm && put[pm].schema) { schemas.update = this.mergePatchSchema(this.toJsonSchema(put[pm].schema)); this.dropId(schemas.update); notes.push('schemas.update comes from the PUT body, without required and with null allowed'); }
        }
        if (schemas.update && this.dropDefaults(schemas.update)) notes.push('schemas.update: defaults removed, they mean nothing in a PATCH (§4.3)');
        // §5.1 (council, round 3, decision 1): with upload, create only where the POST takes JSON.
        if (c.upload && !c.createsFromJson && schemas.create) { delete schemas.create; notes.push('schemas.create: left out, the POST only takes files (§5.1)'); }
        if (Object.keys(schemas).length) out.schemas = schemas;
      }
      // Filters
      const filter = {};
      for (const [field, f] of Object.entries(c.filters ?? {})) {
        if (!FIELD_PATH_RE.test(field)) { notes.push(`filter.${field}: does not follow the name grammar (§3) and is not declared`); continue; }
        const decl = f.relationNull ? { type: 'string' } : f.quantifier ? this.filterType(f.elem, '', { itemSchema: {} }) : this.filterType(f.schema, field, c);
        // §6.1: only the operators of the list; boolean only with eq, ne and null; the id filter, without order operators;
        // prefix and contains only on strings; ne and nin never with quantifier.
        const ops = f.ops.filter((op) => OPERATORS.includes(op) && (decl.type !== 'boolean' || ['eq', 'ne', 'null'].includes(op)) && (field !== 'id' || !['lt', 'le', 'gt', 'ge', 'prefix', 'contains'].includes(op))
          && (!['prefix', 'contains'].includes(op) || decl.type === 'string') && (!f.quantifier || !['ne', 'nin'].includes(op)));
        if (ops.length < f.ops.length) notes.push(`filter.${field}: removed ${f.ops.filter((op) => !ops.includes(op)).join(', ')}, which §6.1 does not allow there`);
        if (!ops.length) continue;
        // §6.1 (council, decision 1): null alone on the list field itself carries no quantifier.
        const quantifier = f.quantifier && !(ops.length === 1 && ops[0] === 'null') ? f.quantifier : undefined;
        const entry = { type: decl.type, ...(decl.values ? { values: decl.values } : {}), ops, ...(quantifier && { quantifier }) };
        const low = f.confidence === 'low' || decl.low;
        if (ann && f.confidence !== 'high') entry['x-confidence'] = low ? 'low' : 'medium';
        if (ann && f.confidence !== 'high') entry['x-source'] = [...new Set(f.sources)].join('; ');
        if (low) lowNotes.push(`${c.name}.filter.${field}`);
        filter[field] = entry;
      }
      const named = {};
      for (const [field, f] of Object.entries(c.namedFilters ?? {})) {
        if (field in filter || !NAME_RE.test(field)) continue;
        const { sources, ...entry } = f;
        if (ann) { entry['x-confidence'] = 'low'; entry['x-source'] = [...new Set(sources)].join('; '); }
        lowNotes.push(`${nameOf.get(c)}.named_filters.${field}`);
        named[field] = entry;
      }
      const sort = [...new Set(c.sort ?? [])].filter((s) => FIELD_PATH_RE.test(s));
      if (sort.length) { out.sort = sort; anyQuery = true; }
      if (!sort.length && c.sortConfidence === 'low') notes.push('there is a sort parameter without a list of fields: fill in sort by hand');
      if (Number.isInteger(c.maxLimit) && c.maxLimit >= 1) { out.max_limit = c.maxLimit; anyQuery = true; }
      if (c.upload && methods.includes('POST')) {
        out.upload = c.upload;
        notes.push('upload: from the file the POST carries; add max_size (§5.1)');
        // §5.1 (council, round 3, decision 1): schemas.create says that the collection also creates items from JSON.
        if (c.createsFromJson && !out.schemas?.create) {
          out.schemas = { ...(out.schemas ?? {}), create: { type: 'object' } };
          notes.push('schemas.create: {"type": "object"}, because the POST also takes JSON and, with upload, create announces it (§5.1); describe the body');
        }
      }
      if (c.count || c.countField) { out.count = 'exact'; notes.push('count: assumed exact; use estimated if the total is approximate'); anyQuery = true; }
      // Relations
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
          if (target) rel = { name: snake(fk[1]), decl: { to: nameOf.get(target) }, conf: 'low', note: `relation inferred from ${k}: the representation must become ${snake(fk[1])}: {"id": …}` };
        } else if (fks && t === 'array') {
          const target = this.findCollection(fks[1]);
          if (target) rel = { name: plural(snake(fks[1])), decl: { to: nameOf.get(target), many: true }, conf: 'low', note: `relation inferred from ${k}: it must become a list of objects with id` };
        } else if (t === 'object' && this.refName(v0) && bySchema.has(this.refName(v0))) {
          rel = { name: k, decl: { to: nameOf.get(bySchema.get(this.refName(v0))), include: true }, conf: 'medium', note: `relation inferred from the embedded schema ${this.refName(v0)}` };
        } else if (t === 'object' && 'id' in this.props(v) && Object.keys(this.props(v)).every((x) => ['id', 'type', 'href'].includes(x)) && this.findCollection(k)) {
          rel = { name: k, decl: { to: nameOf.get(this.findCollection(k)) }, conf: 'medium', note: `relation inferred from the {id} object in ${k}` };
        } else if (t === 'array' && this.refName(v.items) && bySchema.has(this.refName(v.items))) {
          rel = { name: k, decl: { to: nameOf.get(bySchema.get(this.refName(v.items))), many: true }, conf: 'medium', note: `relation inferred from the list of ${this.refName(v.items)}` };
        }
        if (rel) {
          if ((c.includeValues ?? []).includes(rel.name)) rel.decl.include = true;
          if (ann) { rel.decl['x-confidence'] = rel.conf; rel.decl['x-source'] = rel.note; }
          if (rel.conf === 'low') lowNotes.push(`${c.name}.relations.${rel.name}`);
          relations[rel.name] = rel.decl;
        }
      }
      for (const child of c.children) {
        const decl = { to: nameOf.get(child), many: true, path: templatePath(child.path) };
        relations[child.segment in relations || !NAME_RE.test(child.segment) ? nameOf.get(child) : child.segment] = decl;
      }
      for (const k of Object.keys(relations)) if (!NAME_RE.test(k)) { notes.push(`relations.${k}: does not follow the name grammar (§3) and is not declared`); delete relations[k]; }
      for (const [k, r] of Object.entries(relations)) {
        const target = this.collections.find((x) => nameOf.get(x) === r.to);
        if (!r.many && target?.parent) notes.push(`relations.${k}: its target is a subcollection, so every object of the relation carries href (§3, §5.1)`);
      }
      if (Object.keys(relations).length) { out.relations = relations; anyRelations = true; }
      // §6.1: neither paths that cross a to-many relation nor the one that ends in the id of the item of
      // a subcollection are declared in filter or sort.
      const forbidden = (path) => {
        const [first, ...rest] = path.split('.');
        const r = relations[first];
        if (!r || !rest.length) return null;
        if (r.many) return 'goes through a to-many relation';
        const target = this.collections.find((x) => nameOf.get(x) === r.to);
        if (rest.join('.') === 'id' && target?.parent) return 'ends in the id of a subcollection item';
        return null;
      };
      for (const k of Object.keys(filter)) { const why = forbidden(k); if (why) { notes.push(`filter.${k}: ${why} and is not declared (§6.1)`); delete filter[k]; } }
      for (const [k, f] of Object.entries(c.filters ?? {})) {
        if (f.relationNull && filter[k] && !relations[k]?.many) { notes.push(`filter.${k}: null on a list of objects that is not a to-many relation is not declared (§6.1)`); delete filter[k]; }
      }
      if (Object.keys(filter).length) { out.filter = filter; anyQuery = true; }
      if (Object.keys(named).length) { out.named_filters = named; anyQuery = true; }
      const sortOk = sort.filter((k) => { const why = forbidden(k); if (why) notes.push(`sort.${k}: ${why} and is not declared (§6.1)`); return !why; });
      if (sortOk.length) out.sort = sortOk; else delete out.sort;
      // Actions
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
        if (!safe) notes.push(`actions.${name}: idempotent ${decl.idempotent} is an assumption`);
        actions[name] = decl;
      }
      if (Object.keys(actions).length) { out.actions = actions; anyActions = true; }
      if (ann) {
        const conf = !c.itemPath || !c.ops.GET ? 'low' : 'high';
        out['x-restep-from-openapi'] = { confidence: conf, source: [c.ops.GET?.where, c.itemOps.GET?.where].filter(Boolean).join(', ') || c.path, ...(notes.length ? { notes } : {}) };
      }
      if (!c.ops.GET) lowNotes.push(`${c.name} (no list GET in OpenAPI)`);
      c.notes = notes;
      collections[nameOf.get(c)] = out;
    }
    const profiles = ['core'];
    if (anyQuery) profiles.push('query');
    const writesErrors = [...this.findings.values()].some((f) => f.profile === 'writes' && f.severity === 'error');
    if (this.hasWrites && !writesErrors && !this.findings.has('writes.idempotency')) profiles.push('writes');
    // cache (§8) only if every read documents Cache-Control and every item GET, ETag.
    if (this.cacheHint && !this.cacheMissing && this.collections.some((c) => c.ops.GET || c.itemOps.GET)) profiles.push('cache');
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
    // Singletons (§5.9): GET and, if there is PATCH or PUT, PATCH; item and update schemas.
    const singletons = {};
    for (const sg of this.singletons ?? []) {
      const out = { path: sg.path };
      if (sg.parent) {
        // §5.9: the parent's item path (its declared template and a simple variable of its own), then the literals.
        const last = sg.parent.itemPath.split('/').at(-1), base = sg.parent.declaredPath ?? sg.parent.path;
        const used = new Set([...base.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]));
        let v = /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(last) ? last.slice(1, -1) : `${snake(nameOf.get(sg.parent))}_id`;
        if (used.has(v)) v = `${nameOf.get(sg.parent).replace(/s$/, '')}_id`;
        out.path = `${base}/{${v}}${sg.path.slice(sg.parent.itemPath.length)}`;
        out.parent = nameOf.get(sg.parent);
      }
      out.methods = ['GET', ...(sg.ops.PATCH || sg.ops.PUT ? ['PATCH'] : [])];
      const desc = firstSentence(sg.ops.GET.op.summary) ?? firstSentence(sg.ops.GET.op.description);
      if (desc) out.description = desc;
      if (withSchemas) {
        const schemas = {};
        const item = this.successSchema(sg.ops.GET.op, ['200'])?.schema;
        if (item) schemas.item = this.toJsonSchema(item);
        const w = sg.ops.PATCH ?? sg.ops.PUT;
        const body = w && this.resolve(w.op.requestBody)?.content;
        const bm = body && (Object.keys(body).find((m) => /merge-patch\+json/i.test(m)) ?? Object.keys(body).find(isJsonMedia));
        if (bm && body[bm].schema && !/json-patch/i.test(bm)) {
          schemas.update = sg.ops.PATCH ? this.toJsonSchema(body[bm].schema) : this.mergePatchSchema(this.toJsonSchema(body[bm].schema));
          this.dropDefaults(schemas.update);
        }
        if (Object.keys(schemas).length) out.schemas = schemas;
      }
      if (ann) { out['x-confidence'] = 'medium'; out['x-source'] = Object.values(sg.ops).map((o) => o.where).join(', ') + (sg.ops.PUT && !sg.ops.PATCH ? ' (the PUT becomes PATCH)' : ''); }
      singletons[sg.name] = out;
    }
    if (Object.keys(singletons).length) d.singletons = singletons;
    if (ann) d['x-restep-from-openapi'] = {
      generator: `restep-from-openapi ${VERSION}`,
      source: `${this.title}${this.apiVersion ? ` ${this.apiVersion}` : ''} (OpenAPI ${this.openapi})`,
      api_root: this.root,
      note: 'Draft inferred from the OpenAPI description. Review what is marked x-confidence low or medium and remove the x-restep-from-openapi, x-confidence and x-source members before publishing it.',
    };
    this.discovery = d;
    this.lowNotes = lowNotes;
  }

  // Removes id from a body schema (5.1: the server assigns it and it does not change).
  // §4.3: in update a default means nothing (what a PATCH omits does not change); in OpenAPI a PUT body
  // does have one, and that is where it usually comes from. Top-level ones are removed.
  dropDefaults(s) {
    if (!isObject(s?.properties)) return false;
    let dropped = false;
    for (const p of Object.values(s.properties)) if (isObject(p) && 'default' in p) { delete p.default; dropped = true; }
    return dropped;
  }

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

  // Restep type (§4.2) of a filter from the parameter or field schema.
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
    // The field type wins (the parameter's is usually string), unless the parameter is more precise.
    if (fromField && (!fromParam || fromParam.type === 'string')) return fromField;
    if (fromParam) return fromParam;
    return { type: 'string', low: true };
  }

  // OpenAPI 3.0 → JSON Schema 2020-12, with local $refs resolved (a cycle is cut with {}).
  toJsonSchema(schema, stack = []) {
    const name = this.refName(schema);
    if (name && stack.includes(name)) return { description: `Circular reference to ${name} (cut).` };
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
    // Enum labels (x-enumNames, from NSwag and others) become a oneOf of const with title, which
    // is how Restep gives the options of a form with their label (§4.3, appendix A).
    const names = s['x-enumNames'];
    const labelled = Array.isArray(s.enum) && Array.isArray(names) && names.length === s.enum.length && names.every((x) => typeof x === 'string');
    if (labelled) { out.oneOf = s.enum.map((v, i) => ({ const: v, title: names[i] })); delete out.enum; }
    if (s.nullable === true) {
      if (labelled) out.oneOf.push({ type: 'null' });
      if (typeof out.type === 'string') out.type = [out.type, 'null'];
      else if (Array.isArray(out.type) && !out.type.includes('null')) out.type = [...out.type, 'null'];
      else if (!out.type) return { anyOf: [out, { type: 'null' }] };
      if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
    }
    return out;
  }

  // A merge patch schema from that of a full body: nothing required and null allowed.
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
      cache: !!this.cacheHint,
      relations: findings.some((f) => f.profile === 'relations') || this.passes.some((p) => p.profile === 'relations') || Object.values(this.discovery.collections).some((c) => c.relations),
      sync: !!this.syncHint,
    };
    const scores = {};
    for (const p of PROFILES) {
      const fs = findings.filter((f) => f.profile === p);
      const errors = fs.filter((f) => f.severity === 'error').length;
      const warnings = fs.filter((f) => f.severity === 'warning').length;
      if (!relevant[p]) { scores[p] = { score: null, errors, warnings, note: p === 'sync' ? 'no sign of sync in the description' : p === 'writes' ? 'the API has no writes' : p === 'cache' ? 'no read documents Cache-Control' : 'nothing to evaluate' }; continue; }
      let penalty = 0;
      for (const f of fs) {
        if (f.severity === 'info') continue;
        penalty += (f.severity === 'error' ? 15 : 6) + Math.min(8, 2 * (f.where.length - 1));
      }
      const score = Math.max(0, 100 - penalty);
      scores[p] = { score, errors, warnings, note: score >= 90 ? 'almost ready' : score >= 60 ? 'moderate work' : 'a lot of work' };
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

// ── Report ─────────────────────────────────────────────────────────────────

const SEVERITY = { error: 'Error', warning: 'Warning', info: 'Note' };
const PROFILE_TITLES = { core: 'core (required)', query: 'query', writes: 'writes', cache: 'cache', relations: 'relations', sync: 'sync', extensions: 'Extensions' };
const MAX_WHERE = 8;

export function renderReport(r, { source, validation } = {}) {
  const L = [];
  L.push(`# ${r.api.title}: what it needs to conform to Restep 1`, '');
  L.push(`Generated by ${r.tool} from ${source ? `\`${source}\`` : 'a description'} (OpenAPI ${r.api.openapi}${r.api.version ? `, API version ${r.api.version}` : ''}). `
    + `${r.api.operations} operations on ${r.api.paths} paths; ${r.collections.length} collections recognized. Assumed API root: \`${r.api.root}\`.`, '');
  L.push('> This is an indicative report: it only reads the OpenAPI description, does not call the API, and infers from names and schemas. '
    + 'Whatever the description does not document (headers, error codes) counts as missing. To check a real server, use '
    + '[restep-check](https://restep.wubytes.com/tools/).', '');
  L.push('## Summary', '');
  L.push('| Profile | Score | Errors | Warnings | Assessment |', '|---|---|---|---|---|');
  for (const p of PROFILES) {
    const s = r.scores[p];
    L.push(`| ${p} | ${s.score === null ? '—' : `${s.score}/100`} | ${s.errors} | ${s.warnings} | ${s.note} |`);
  }
  L.push('', 'Indicative score: 100 minus 15 for each kind of error and 6 for each kind of warning, plus 2 for each extra place where it repeats (up to 8). Notes do not subtract.', '');
  for (const p of [...PROFILES, 'extensions']) {
    const fs = r.findings.filter((f) => f.profile === p);
    const ps = r.passes.filter((x) => x.profile === p);
    if (!fs.length && !ps.length) continue;
    L.push(`## ${PROFILE_TITLES[p]}`, '');
    if (fs.length) {
      L.push(p === 'extensions' ? '### Suggestions' : '### What is missing', '');
      for (const f of fs) {
        L.push(`- **${SEVERITY[f.severity]}: ${f.title}** ${sectionLink(f.section)} \`${f.id}\``);
        L.push(`  ${f.fix}`);
        const shown = f.where.slice(0, MAX_WHERE).map((w) => `\`${w}\``).join(', ');
        L.push(`  Where: ${shown}${f.where.length > MAX_WHERE ? ` and ${f.where.length - MAX_WHERE} more` : ''}.`);
      }
      L.push('');
    }
    if (ps.length) {
      L.push('### What already conforms', '');
      for (const x of ps) L.push(`- ${x.text} ${sectionLink(x.section)}`);
      L.push('');
    }
  }
  L.push('## Draft discovery document', '');
  const d = r.discovery;
  L.push(`Profiles: ${d.profiles.join(', ')}${d.extensions ? `. Extensions: ${d.extensions.join(', ')}` : ''}. `
    + 'The profiles come from what the draft declares; announcing them requires fixing what is missing above.', '');
  const cols = Object.entries(d.collections);
  if (cols.length) {
    L.push('| Collection | Path | Methods | Item | Filters | Sort | Relations | Actions |', '|---|---|---|---|---|---|---|---|');
    for (const [name, c] of cols)
      L.push(`| ${name} | \`${c.path}\` | ${(c.methods ?? []).join(' ') || '—'} | ${(c.item_methods ?? []).join(' ') || '—'} | ${Object.keys(c.filter ?? {}).join(', ') || '—'} | ${(c.sort ?? []).join(', ') || '—'} | ${Object.keys(c.relations ?? {}).join(', ') || '—'} | ${Object.keys(c.actions ?? {}).join(', ') || '—'} |`);
    L.push('');
  }
  if (r.lowConfidence.length) {
    L.push('Inferred with low confidence (review it by hand):', '');
    for (const x of r.lowConfidence) L.push(`- \`${x}\``);
    L.push('');
  }
  const notes = Object.entries(d.collections).flatMap(([n, c]) => (c['x-restep-from-openapi']?.notes ?? []).map((x) => `${n}: ${x}`));
  if (notes.length) { L.push('Notes:', ''); for (const x of notes) L.push(`- ${x}`); L.push(''); }
  if (r.unresolvedRefs.length) L.push(`Unresolved external references (treated as empty schemas): ${r.unresolvedRefs.map((x) => `\`${x}\``).join(', ')}.`, '');
  if (validation) L.push(validation.errors === null ? `Validation against discovery.json: not done (${validation.reason}).`
    : validation.errors.length ? `Validation against discovery.json: **${validation.errors.length} errors**: ${validation.errors.slice(0, 5).map((e) => `\`${e.at}\` ${e.message}`).join('; ')}.`
      : 'Validation against discovery.json: passed.', '');
  return L.join('\n');
}

// ── Discovery schema ───────────────────────────────────────────────

export async function loadDiscoverySchema() {
  const here = fileURLToPath(new URL('.', import.meta.url));
  for (const p of [`${here}schema/discovery.json`]) {
    try { return { schema: JSON.parse(await readFile(p, 'utf8')), from: p }; } catch { /* next */ }
  }
  try {
    const r = await fetch(SCHEMA_URL, { signal: AbortSignal.timeout(10000) });
    if (r.ok) return { schema: await r.json(), from: SCHEMA_URL };
  } catch { /* no network */ }
  return null;
}

export function stripAnnotations(v) {
  if (Array.isArray(v)) return v.map(stripAnnotations);
  if (!isObject(v)) return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => !/^x-(confidence|source|restep-from-openapi)$/.test(k)).map(([k, x]) => [k, stripAnnotations(x)]));
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `Usage: restep-from-openapi <openapi.json|openapi.yaml|URL> [options]

Reads an API described in OpenAPI 3.x and says what it needs to conform to Restep 1, profile by
profile, with an indicative score; and writes a draft of its discovery document.

Options:
  --out <file>        writes the draft discovery document (JSON)
  --report <file>     writes the report in Markdown (otherwise it goes to standard output)
  --json              prints the full result as JSON to standard output instead of the report
  --no-schemas        does not copy the OpenAPI schemas into schemas or into the actions' input (an upload
                      collection whose POST takes JSON still gets "create": {"type": "object"}, §5.1)
  --no-annotations    leaves out the x-confidence, x-source and x-restep-from-openapi members
  --help              this help

Exit codes: 0 OK; 1 the description could not be read; 2 wrong usage.`;

async function main(argv) {
  const opts = { schemas: true, annotations: true };
  let input = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (!v || v.startsWith('--')) usage(`${a} needs a file.`); return v; };
    if (a === '--help' || a === '-h') { console.log(USAGE); return 0; }
    else if (a === '--out') opts.out = val();
    else if (a === '--report') opts.report = val();
    else if (a === '--json') opts.json = true;
    else if (a === '--no-schemas') opts.schemas = false;
    else if (a === '--no-annotations') opts.annotations = false;
    else if (a.startsWith('--')) usage(`Unknown option: ${a}.`);
    else if (input) usage('Only one OpenAPI description is allowed.');
    else input = a;
  }
  if (!input) usage('Missing the OpenAPI description (file or URL).');
  let doc;
  try { doc = await loadDocument(input); }
  catch (e) { console.error(`Error: ${e.message}`); return 1; }
  const r = analyze(doc, opts);
  const loaded = await loadDiscoverySchema();
  const validation = loaded ? { errors: validate(loaded.schema, stripAnnotations(r.discovery)) } : { errors: null, reason: 'schema not found and no network' };
  r.validation = validation;
  const report = renderReport(r, { source: input, validation });
  if (opts.out) await writeFile(opts.out, JSON.stringify(r.discovery, null, 2) + '\n');
  if (opts.report) await writeFile(opts.report, report + '\n');
  if (opts.json) console.log(JSON.stringify(r, null, 2));
  else if (opts.report) {
    console.log(`${r.api.title}: ${r.collections.length} collections, ${r.findings.length} findings.`);
    for (const p of PROFILES) console.log(`  ${p.padEnd(10)} ${r.scores[p].score === null ? '   —' : String(r.scores[p].score).padStart(4)}  ${r.scores[p].note}`);
    console.log(`Report: ${opts.report}${opts.out ? `\nDiscovery: ${opts.out}` : ''}`);
  } else console.log(report);
  if (validation.errors?.length) console.error(`Warning: the draft does not validate against discovery.json (${validation.errors.length} errors).`);
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
