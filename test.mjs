// Tests for restep-from-openapi.
//   node tools/restep-from-openapi/test.mjs       (from projects/restep)
// Uses ports 8880 (serves a fixture over HTTP) and 8881 (reference server, to validate its
// discovery with our own validator and so check the validator).
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, parseDocument, parseYaml, validate, renderReport, stripAnnotations } from './restep-from-openapi.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TOOL = join(here, 'restep-from-openapi.mjs');
// RESTEP_REF: another copy of the reference server (while public/ref is being edited, for instance).
const SERVER = process.env.RESTEP_REF ?? join(here, 'vendor/restep-server.mjs');
const SCHEMA = JSON.parse(readFileSync(join(here, 'schema/discovery.json'), 'utf8'));
const FIX = (f) => join(here, 'fixtures', f);
const HTTP_PORT = 8880, REF_PORT = 8881;

let passed = 0, failed = 0;
function ok(cond, name, detail = '') {
  if (cond) { passed++; console.log(`ok     ${name}`); }
  else { failed++; console.log(`FAIL   ${name}${detail ? `: ${detail}` : ''}`); }
}
function throws(fn, re, name) {
  try { fn(); ok(false, name, 'does not throw'); }
  catch (e) { ok(re.test(e.message), name, e.message); }
}
const run = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [TOOL, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('exit', (code) => resolve({ code, out, err }));
});

// ── YAML ────────────────────────────────────────────────────────────────────
{
  const y = parseYaml(`# comentario
openapi: 3.1.0
info:
  title: "Con: dos puntos" # comentario al final
  description: |
    uno
    dos
  summary: >-
    plegado
    en una
  version: '1.0'
servers:
- url: https://x.example/v1
tags: [a, "b, c", {x: 1}]
paths:
  /a/{id}:cancel:
    post:
      parameters:
        - name: id
          in: path
          schema: &s { type: integer, format: int64 }
        - schema: *s
      responses:
        '200':
          description: texto que
            sigue en otra línea
base: &b {p: 1}
merged:
  <<: *b
  q: [1,
    2]
nulo: ~
verdad: true
numero: -12.5e1
`);
  ok(y.openapi === '3.1.0' && y.info.title === 'Con: dos puntos', 'YAML: scalars and comments');
  ok(y.info.description === 'uno\ndos\n' && y.info.summary === 'plegado en una' && y.info.version === '1.0', 'YAML: | and >- blocks');
  ok(y.servers[0].url === 'https://x.example/v1', 'YAML: list at the same indentation as its key');
  ok(JSON.stringify(y.tags) === '["a","b, c",{"x":1}]', 'YAML: flow collections');
  const op = y.paths['/a/{id}:cancel'].post;
  ok(op.parameters[1].schema.format === 'int64' && op.parameters[0].schema === op.parameters[1].schema, 'YAML: anchors and aliases');
  ok(op.responses['200'].description === 'texto que sigue en otra línea', 'YAML: multi-line scalar');
  ok(y.merged.p === 1 && y.merged.q.length === 2, 'YAML: << merge key and multi-line collection');
  ok(y.nulo === null && y.verdad === true && y.numero === -125, 'YAML: core schema types');
  throws(() => parseYaml('a:\n\tb: 1'), /line 2.*tab/, 'YAML: a tab in the indentation gives an error with the line');
  throws(() => parseYaml('a: *nada'), /alias/, 'YAML: an alias without an anchor gives an error');
  throws(() => parseYaml('a: [1, 2'), /unclosed/, 'YAML: an unclosed collection gives an error');
}

// ── JSON Schema validator ───────────────────────────────────────────────────
{
  ok(validate(SCHEMA, { restep: '1.0', collections: { books: { path: '/books' } } }).length === 0, 'Validator: minimal valid discovery document');
  const bad = validate(SCHEMA, { restep: '2', profiles: ['sync'], collections: { books: { path: 'books', filter: { _x: { type: 'enum', ops: ['eq'] } }, actions: { changes: { on: 'item', safe: true, idempotent: true } } } } });
  const msgs = bad.map((e) => `${e.at} ${e.message}`).join(' | ');
  ok(/\/restep/.test(msgs) && /\/collections\/books\/path/.test(msgs) && /_x/.test(msgs) && /changes/.test(msgs) && /contains/.test(msgs) && /values/.test(msgs),
    'Validator: detects version, path, _ name, changes action, sync without query and enum without values', msgs);
  const ga = validate(SCHEMA, { restep: '1.0', collections: { b: { path: '/b', actions: { x: { on: 'item', safe: false, idempotent: true, method: 'GET' } } } } });
  ok(ga.length > 0, 'Validator: an unsafe GET action does not validate (if/then)');
}

// The reference server's discovery must validate with our own validator.
{
  const ref = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(REF_PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the reference server does not start')), 10000);
      ref.stdout.on('data', (d) => { if (/on http/.test(String(d))) { clearTimeout(t); resolve(); } });
      ref.on('exit', (c) => reject(new Error(`the reference server exited (${c})`)));
    });
    const disc = await (await fetch(`http://localhost:${REF_PORT}/`)).json();
    const errs = validate(SCHEMA, disc);
    ok(errs.length === 0, 'Validator: the reference server discovery document validates', errs.slice(0, 3).map((e) => `${e.at} ${e.message}`).join('; '));
  } catch (e) { ok(false, 'Validator: reference server', e.message); }
  finally { ref.kill(); }
}

// ── Analysis of the fixtures ────────────────────────────────────────────────
const load = (f) => parseDocument(readFileSync(FIX(f), 'utf8'), f);
const ids = (r) => new Set(r.findings.map((f) => f.id));
const finding = (r, id) => r.findings.find((f) => f.id === id);
const validates = (name, disc) => {
  const e1 = validate(SCHEMA, disc), e2 = validate(SCHEMA, stripAnnotations(disc));
  ok(!e1.length && !e2.length, `${name}: the draft validates against discovery.json (with and without annotations)`, [...e1, ...e2].slice(0, 3).map((e) => `${e.at} ${e.message}`).join('; '));
};

// §4.3 and appendix A: a form comes from create; title, default and examples pass through as is, the
// labels of an enum (x-enumNames) become oneOf with title, and update is left without default.
{
  const book = { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string', title: 'Título', example: 'La niebla' },
    status: { type: 'string', enum: ['draft', 'published'], 'x-enumNames': ['Borrador', 'Publicado'], default: 'draft', nullable: true } } };
  const r = analyze({ openapi: '3.0.3', info: { title: 'x', version: '1' }, servers: [{ url: 'https://f.example/' }], paths: {
    '/books': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: book } } } } } },
      post: { requestBody: { content: { 'application/json': { schema: book } } }, responses: { 201: { description: 'ok', content: { 'application/json': { schema: book } } } } } },
    '/books/{id}': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: book } } } } },
      put: { requestBody: { content: { 'application/json': { schema: book } } }, responses: { 200: { description: 'ok', content: { 'application/json': { schema: book } } } } } },
  } });
  const s = r.discovery.collections.books?.schemas ?? {};
  const st = s.create?.properties?.status;
  ok(st?.default === 'draft' && JSON.stringify(st.oneOf) === JSON.stringify([{ const: 'draft', title: 'Borrador' }, { const: 'published', title: 'Publicado' }, { type: 'null' }]) && !('enum' in st),
    'forms: default and enum labels in create', JSON.stringify(st));
  ok(s.create?.properties?.title?.title === 'Título' && s.create.properties.title.examples?.[0] === 'La niebla', 'forms: title and example go to create', JSON.stringify(s.create?.properties?.title));
  ok(s.update && !('default' in (s.update.properties?.status ?? {})), 'forms: update without default', JSON.stringify(s.update?.properties?.status));
}

const pet = analyze(load('petstore-ampliada.yaml'));
{
  const has = ids(pet);
  const expected = ['core.list.array', 'core.list.envelope', 'core.list.next', 'core.put', 'core.patch.json-patch', 'core.error.media', 'core.post.status',
    'core.delete.status', 'data.id.type', 'data.money', 'data.underscore', 'data.timestamp-number', 'data.naming', 'query.pagination.offset',
    'query.filter.name', 'query.sort.name', 'query.limit.name', 'writes.etag', 'writes.if-match', 'writes.idempotency',
    'relations.scalar-fk', 'relations.id-array', 'actions.verb-path', 'query.search-path', 'core.item-post'];
  const missing = expected.filter((x) => !has.has(x));
  ok(!missing.length, 'Petstore: detects the expected issues', `missing ${missing.join(', ')}`);
  ok(pet.api.root === 'https://petstore.example.com/api/v1/' && pet.discovery.version === '1', 'Petstore: root and major version');
  const where = finding(pet, 'query.filter.name').where.join(' ');
  // tags is a list in Pet: since draft 7 it is declared in filter with "quantifier": "some" (§6.1).
  ok(/min_price → filter\[price\]\[ge\]/.test(where) && /created_after → filter\[created_at\]\[gt\]/.test(where) && /tags → filter\[tags\]/.test(where),
    'Petstore: translates filters to filter[field][op]', where);
  const pf = pet.discovery.collections.pets;
  ok(pf.filter.tags?.quantifier === 'some' && pf.filter.tags.type === 'string' && pf.filter.tags.ops.includes('in') && !pf.named_filters?.tags && finding(pet, 'query.filter.list'),
    'Petstore: a filter on a list goes to filter with "quantifier": "some" and the type of its elements (§6.1)', JSON.stringify(pf.filter.tags));
  ok(pf.named_filters?.q?.type === 'string' && /filter\[q\]/.test(finding(pet, 'query.search').where.join(' ')), 'Petstore: free-text search ?q becomes a named filter', JSON.stringify(pf.named_filters));
  ok(finding(pet, 'core.put').section === '5.1' && finding(pet, 'core.error.media').section === '5.4' && finding(pet, 'query.pagination.offset').section === '6.4',
    'Petstore: each finding cites its section');
  ok(finding(pet, 'core.list.array').where.includes('GET /pets'), 'Petstore: each finding cites the OpenAPI operation');
  const pets = pet.discovery.collections.pets;
  ok(pets && pets.path === '/pets' && pets.filter.price.type === 'decimal' && pets.filter.price.ops.join() === 'ge,le' && pets.filter.status.type === 'enum',
    'Petstore: draft filters (decimal price, enum status)', JSON.stringify(pets?.filter));
  ok(pets.sort.join() === 'name,price,createdAt' && pets.max_limit === 100, 'Petstore: draft sort and max_limit');
  ok(pets.item_methods.join() === 'GET,PATCH,DELETE' && pets['x-restep-from-openapi'].notes.some((n) => /PUT/.test(n)), 'Petstore: PUT becomes PATCH with a note');
  ok(pets.actions.adopt?.on === 'item' && pets.actions.adopt['x-confidence'] === 'low', 'Petstore: action inferred from a verb, with low confidence');
  ok(pet.discovery.collections.orders.relations.customer?.to === 'customers', 'Petstore: relation inferred from customer_id');
  ok(!pet.discovery.profiles.includes('writes'), 'Petstore: does not announce writes without ETag');
  ok(pet.discovery.status === 'https://petstore.example.com/api/v1/health', 'Petstore: status from /health');
  ok(!pet.passes.some((p) => /Ids are strings/.test(p.text)), 'Petstore: does not claim to conform where it fails');
  validates('Petstore', pet.discovery);
}

const casi = analyze(load('casi-restep.json'));
{
  const serious = casi.findings.filter((f) => f.severity !== 'info');
  ok(!serious.length, 'Almost Restep: no errors or warnings', serious.map((f) => f.id).join(', '));
  ok(Object.values(casi.scores).filter((s) => s.score !== null).every((s) => s.score === 100) && casi.scores.sync.score === null, 'Almost Restep: 100 where it applies; sync not scored');
  const books = casi.discovery.collections.books;
  ok(books.filter.price.type === 'decimal' && books.filter['author.id'] && books.sort.join() === 'title,price' && books.max_limit === 50 && books.count === 'exact',
    'Almost Restep: filters, sort, max_limit and count', JSON.stringify(books.filter));
  ok(books.relations.author?.to === 'authors' && books.relations.author.include === true && books.relations.reviews?.path === '/books/{id}/reviews',
    'Almost Restep: expandable relation and subcollection');
  ok(books.actions.reserve?.on === 'item' && books.actions.reserve.input?.properties?.hours, 'Almost Restep: colon action and its input');
  ok(books.schemas?.update?.additionalProperties === false && !('id' in (books.schemas.create.properties ?? {})), 'Almost Restep: create and update schemas');
  // Documents Cache-Control and ETag on reads: since draft 6 that is the cache profile (§8), not writes.
  ok(casi.discovery.profiles.join() === 'core,query,writes,cache,relations' && casi.discovery.extensions.join() === 'actions,oauth' && casi.discovery.idempotency?.ttl === 86400,
    'Almost Restep: profiles and extensions', JSON.stringify([casi.discovery.profiles, casi.discovery.extensions]));
  ok(casi.discovery.collections.reviews?.path === '/books/{id}/reviews' && casi.discovery.collections.reviews.parent === 'books', 'Almost Restep: subcollection as a collection with a template and parent (§4.2)');
  ok(casi.discovery.restep === '1.0-draft.7', 'Almost Restep: the draft declares 1.0-draft.7 (§1.1)');
  validates('Almost Restep', casi.discovery);
}

const crm = analyze(load('legado-crm.yaml'));
{
  const has = ids(crm);
  const expected = ['core.version.header', 'core.reserved.dollar', 'core.reserved.conflict', 'core.rpc-path', 'core.error.in-200', 'core.list.next',
    'core.patch.media', 'core.post.id', 'query.pagination.cursor-param', 'relations.expand', 'writes.idempotency-name', 'sync.delta', 'sync.webhooks',
    'sync.changes', 'oauth.query-token', 'batch.bulk', 'data.date-format'];
  const missing = expected.filter((x) => !has.has(x));
  ok(!missing.length, 'Legacy CRM: detects the expected issues', `missing ${missing.join(', ')}`);
  ok(crm.api.root === 'https://crm.example.com/api/v2/' && crm.discovery.version === '2' && crm.discovery.collections.accounts?.path === '/accounts',
    'Legacy CRM: strips the /api/v2 prefix from paths', crm.api.root);
  ok(finding(crm, 'core.reserved.conflict').where.some((w) => /\?since/.test(w)) && finding(crm, 'core.reserved.conflict').where.some((w) => /\?sort/.test(w)),
    'Legacy CRM: since and sort=asc clash with the reserved parameters');
  ok(typeof crm.scores.sync.score === 'number', 'Legacy CRM: sync is scored because there are signs of it');
  ok(/Circular reference/.test(JSON.stringify(crm.discovery.collections.accounts.schemas.item)), 'Legacy CRM: cuts the recursive schema');
  validates('Legacy CRM', crm.discovery);
}

// Draft 6: singletons, id_from, nested subcollections, forbidden filters, Content-Type, cache and deprecated.
{
  const ok200 = (schema, headers) => ({ 200: { description: 'ok', ...(headers ? { headers } : {}), content: { 'application/json': { schema } } } });
  const err = { 404: { description: 'no', content: { 'application/problem+json': { schema: { type: 'object', properties: { code: { type: 'string' } } } } } } };
  const author = { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, active: { type: 'boolean' }, labels: { type: 'array', items: { type: 'string' } } } };
  const list = (item) => ({ type: 'object', properties: { items: { type: 'array', items: item }, next: { type: ['string', 'null'] } } });
  const idp = (n) => ({ name: n, in: 'path', required: true, schema: { type: 'string' } });
  const doc = { openapi: '3.1.0', info: { title: 'Borrador 6', version: '1' }, servers: [{ url: 'https://b6.example/' }], paths: {
    '/authors': {
      get: { parameters: [{ name: 'filter[id][gt]', in: 'query', schema: { type: 'string' } }, { name: 'filter[id]', in: 'query', schema: { type: 'string' } },
        { name: 'filter[active][lt]', in: 'query', schema: { type: 'boolean' } }, { name: 'filter[active]', in: 'query', schema: { type: 'boolean' } },
        { name: 'filter[books.title]', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } },
        { name: 'legacy', in: 'query', deprecated: true, schema: { type: 'string' } }],
        responses: { ...ok200(list(author), { 'Cache-Control': { schema: { type: 'string' } } }), ...err } },
      post: { requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string' } } } } } },
        responses: { 201: { description: 'ok', headers: { Location: { schema: { type: 'string' } } }, content: { 'application/json': { schema: author } } }, ...err } } },
    '/authors/{id}': { parameters: [idp('id')], get: { responses: { ...ok200(author, { ETag: { schema: { type: 'string' } }, 'Cache-Control': { schema: { type: 'string' } } }), ...err } } },
    '/authors/{id}/books': { parameters: [idp('id')], get: { responses: { ...ok200(list({ type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } }), { 'Cache-Control': { schema: { type: 'string' } } }), ...err } } },
    '/authors/{id}/books/{id2}': { parameters: [idp('id'), idp('id2')], get: { responses: { ...ok200({ type: 'object', properties: { id: { type: 'string' } } }, { ETag: { schema: { type: 'string' } }, 'Cache-Control': { schema: { type: 'string' } } }), ...err } } },
    '/authors/{id}/books/{id}/reviews': { parameters: [idp('id')], get: { responses: { ...ok200(list({ type: 'object', properties: { id: { type: 'string' } } })), ...err } } },
    '/uploads': { post: { requestBody: { content: { 'multipart/form-data': { schema: { type: 'object' } } } }, responses: { 201: { description: 'ok', headers: { Location: { schema: { type: 'string' } } } }, ...err } } },
    '/me': { get: { summary: 'The signed-in user.', responses: { ...ok200({ type: 'object', properties: { name: { type: 'string' } } }), ...err } },
      patch: { requestBody: { content: { 'application/merge-patch+json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } }, responses: { ...ok200({ type: 'object' }), ...err } } },
    '/authors/stats': { get: { responses: { ...ok200({ type: 'object', properties: { total: { type: 'integer' } } }), ...err } } },
    '/old': { get: { deprecated: true, responses: { ...ok200({ type: 'object' }), ...err } }, delete: { responses: { 204: { description: 'ok' } } } },
  } };
  const r = analyze(doc);
  const d = r.discovery;
  validates('Draft 6', d);
  ok(d.restep === '1.0-draft.7', 'Draft 6 additions: declares 1.0-draft.7');
  ok(d.singletons?.me?.path === '/me' && d.singletons.me.methods.join() === 'GET,PATCH' && d.singletons.me.description === 'The signed-in user.' && d.singletons.me.schemas?.update,
    'Draft 6: /me is a singleton with GET and PATCH (§5.9)', JSON.stringify(d.singletons));
  ok(!d.singletons?.stats && !d.singletons?.old && finding(r, 'core.non-resource')?.where.some((w) => /\/authors\/stats/.test(w))
    && finding(r, 'core.non-resource').where.some((w) => /DELETE \/old/.test(w)),
    'Draft 6: a path under a collection and a resource with DELETE are not singletons', JSON.stringify(finding(r, 'core.non-resource')?.where));
  const a = d.collections.authors;
  ok(a.id_from === 'client' && a.schemas.create.properties.id && finding(r, 'core.post.id')?.severity === 'info', 'Draft 6: a required id in create gives id_from client and stays in the schema (§5.1)', JSON.stringify(a.id_from));
  ok(a.filter.id.ops.join() === 'eq' && a.filter.active.ops.join() === 'eq', 'Draft 6: id without ordering operators and boolean without lt (§6.1)', JSON.stringify(a.filter));
  ok(!a.filter['books.title'], 'Draft 6: does not declare a filter that goes through a to-many relation (§6.1)', JSON.stringify(Object.keys(a.filter)));
  ok(!a.filter.labels && finding(r, 'query.limit.max')?.severity === 'warning', 'Draft 6: limit without a maximum is a warning (§6.4)');
  const books = Object.entries(d.collections).find(([, c]) => c.path === '/authors/{id}/books');
  const reviews = Object.entries(d.collections).find(([, c]) => /reviews$/.test(c.path));
  ok(books && books[1].parent === 'authors' && reviews && reviews[1].path === '/authors/{id}/books/{book_id}/reviews' && reviews[1].parent === books[0],
    'Draft 6: subcollections with parent and distinct variables (§4.2)', JSON.stringify(reviews));
  ok(finding(r, 'core.request.media')?.where.some((w) => /POST \/uploads \(multipart/.test(w)), 'Draft 6: a multipart POST gives a Content-Type error (§3)');
  ok(d.profiles.includes('cache') === false && r.scores.cache.score === 100, 'Draft 6: without Cache-Control on every read it does not announce cache, but scores it', JSON.stringify(d.profiles));
  ok(finding(r, 'core.deprecated')?.where.some((w) => /\?legacy/.test(w)) && finding(r, 'core.deprecated').where.some((w) => /GET \/old/.test(w)) && !d.deprecations,
    'Draft 6: deprecated items are noted without inventing announced (§5.5)');
  ok(Object.values(d.collections).every((c) => !c.filter || Object.keys(c.filter).every((k) => /^[A-Za-z][A-Za-z0-9_-]{0,63}(\.[A-Za-z][A-Za-z0-9_-]{0,63})*$/.test(k))), 'Draft 6: names follow the grammar (§3)');
}

// The score orders APIs from farthest to closest to Restep.
ok(casi.scores.core.score > pet.scores.core.score || casi.scores.query.score > pet.scores.query.score, 'Score: the almost-Restep API scores better than the Petstore');

// Markdown report
{
  const md = renderReport(pet, { source: 'petstore-ampliada.yaml', validation: { errors: [] } });
  ok(/\| core \| \d+\/100 \|/.test(md) && /\[§5\.4\]\(https:\/\/restep\.wubytes\.com\/1\/#errors\)/.test(md) && /`GET \/pets`/.test(md) && /Validation against discovery\.json: passed/.test(md),
    'Report: table per profile, spec links, endpoints and validation');
}

// Draft 7: list filters with quantifier, operators, upload, an invalid default and a singleton under an item.
{
  const ok200 = (schema) => ({ 200: { description: 'ok', content: { 'application/json': { schema } } } });
  const list = (item) => ({ type: 'object', properties: { items: { type: 'array', items: item }, next: { type: ['string', 'null'] } } });
  const idp = (n) => ({ name: n, in: 'path', required: true, schema: { type: 'string' } });
  const reader = { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, formats: { type: 'array', items: { type: 'string', enum: ['pdf', 'epub'] } },
    status: { type: 'string', enum: ['active', 'gone'] } } };
  const file = { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } };
  const doc = { openapi: '3.1.0', info: { title: 'Draft 7', version: '1' }, servers: [{ url: 'https://b7.example/' }], paths: {
    '/readers': {
      get: { parameters: [{ name: 'filter[formats]', in: 'query', schema: { type: 'string' } }, { name: 'filter[name][prefix]', in: 'query', schema: { type: 'string' } },
        { name: 'filter[name][regex]', in: 'query', schema: { type: 'string' } }, { name: 'filter[formats][ne]', in: 'query', schema: { type: 'string' } }],
        responses: ok200(list(reader)) },
      post: { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' },
        status: { type: 'string', enum: ['active', 'gone'], default: 'archived' }, level: { type: 'integer', default: 1 } } } } } }, responses: { 201: { description: 'ok', content: { 'application/json': { schema: reader } } } } } },
    '/readers/{id}': { parameters: [idp('id')], get: { responses: ok200(reader) } },
    '/readers/{id}/settings': { parameters: [idp('id')], get: { responses: ok200({ type: 'object', properties: { theme: { type: 'string' } } }) },
      patch: { requestBody: { content: { 'application/merge-patch+json': { schema: { type: 'object', properties: { theme: { type: 'string' } } } } } }, responses: ok200({ type: 'object' }) } },
    '/files': { get: { responses: ok200(list(file)) },
      post: { requestBody: { content: { 'image/png': { schema: { type: 'string', format: 'binary' } }, 'application/pdf': { schema: { type: 'string', format: 'binary' } },
        'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } }, encoding: { file: { contentType: 'image/png, application/pdf' } } } } },
        responses: { 201: { description: 'ok', content: { 'application/json': { schema: file } } } } } },
    '/files/{id}': { parameters: [idp('id')], get: { responses: ok200(file) } },
  } };
  const r = analyze(doc);
  const d = r.discovery;
  validates('Draft 7', d);
  const rf = d.collections.readers.filter;
  ok(rf.formats?.quantifier === 'some' && rf.formats.type === 'enum' && JSON.stringify(rf.formats.values) === '["pdf","epub"]' && !rf.formats.ops.includes('ne'),
    'Draft 7: a list field is declared with "quantifier": "some", the type of its elements and never ne (§6.1)', JSON.stringify(rf));
  ok(JSON.stringify(rf.name?.ops) === '["prefix"]', 'Draft 7: prefix is kept and an operator outside 6.1 (regex) is not declared', JSON.stringify(rf.name));
  const create = d.collections.readers.schemas?.create?.properties ?? {};
  ok(!('default' in create.status) && create.level?.default === 1 && /default "archived"/.test(finding(r, 'core.schema.default')?.fix ?? ''),
    'Draft 7: a default that its property does not accept is reported and left out; a valid one stays (§4.3)', JSON.stringify(create));
  ok(d.singletons?.settings?.path === '/readers/{id}/settings' && d.singletons.settings.parent === 'readers' && d.singletons.settings.methods.join() === 'GET,PATCH',
    'Draft 7: a single object under an item is a singleton with parent (§5.9)', JSON.stringify(d.singletons));
  const up = d.collections.files.upload;
  ok(up && JSON.stringify(up.media_types) === '["image/png","application/pdf"]' && up.multipart === true && !finding(r, 'core.request.media') && finding(r, 'core.upload'),
    'Draft 7: a POST with a binary body declares upload, with multipart for one part named file (§5.1)', JSON.stringify(up));
}

// Council decisions of draft 7: null alone on a list field or a to-many relation (1), an upload-only collection (2)
// and a singleton's method_effects (8).
{
  const ok200 = (schema) => ({ 200: { description: 'ok', content: { 'application/json': { schema } } } });
  const list = (item) => ({ type: 'object', properties: { items: { type: 'array', items: item }, next: { type: ['string', 'null'] } } });
  const idp = (n) => ({ name: n, in: 'path', required: true, schema: { type: 'string' } });
  const q = (name, schema = { type: 'boolean' }) => ({ name, in: 'query', schema });
  const doc = { openapi: '3.1.0', info: { title: 'Council', version: '1' }, servers: [{ url: 'https://c.example/' }],
    components: { schemas: {
      Review: { type: 'object', properties: { id: { type: 'string' }, rating: { type: 'integer' } } },
      Book: { type: 'object', properties: { id: { type: 'string' }, tags: { type: 'array', items: { type: 'integer' } }, formats: { type: 'array', items: { type: 'string' } },
        reviews: { type: 'array', items: { $ref: '#/components/schemas/Review' } }, notes: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' } } } } } } } },
    paths: {
      '/books': { get: { parameters: [q('filter[tags][null]'), q('filter[formats][null]'), q('filter[formats][in]', { type: 'string' }), q('filter[reviews][null]'), q('filter[notes][null]')],
        responses: ok200(list({ $ref: '#/components/schemas/Book' })) } },
      '/books/{id}': { parameters: [idp('id')], get: { responses: ok200({ $ref: '#/components/schemas/Book' }) } },
      '/reviews': { get: { responses: ok200(list({ $ref: '#/components/schemas/Review' })) } },
      '/reviews/{id}': { parameters: [idp('id')], get: { responses: ok200({ $ref: '#/components/schemas/Review' }) } },
      '/scans': { get: { responses: ok200(list({ type: 'object', properties: { id: { type: 'string' } } })) },
        post: { requestBody: { content: { 'image/png': { schema: { type: 'string', format: 'binary' } } } }, responses: { 201: { description: 'ok' } } } },
      '/notes': { get: { responses: ok200(list({ type: 'object', properties: { id: { type: 'string' } } })) },
        post: { requestBody: { content: { 'application/json': { schema: { type: 'object' } }, 'text/plain': { schema: { type: 'string' } } } }, responses: { 201: { description: 'ok' } } } },
      '/settings': { get: { responses: ok200({ type: 'object', properties: { theme: { type: 'string' } } }) },
        patch: { requestBody: { content: { 'application/merge-patch+json': { schema: { type: 'object', properties: { theme: { type: 'string' } } } } } }, responses: ok200({ type: 'object' }) } },
    } };
  const r = analyze(doc);
  const d = r.discovery;
  validates('Council decisions', d);
  const bf = d.collections.books.filter ?? {};
  ok(JSON.stringify(bf.tags) === JSON.stringify({ type: 'integer', ops: ['null'], 'x-confidence': 'low', 'x-source': 'GET /books?filter[tags][null]' }),
    'Decision 1: null alone on a list field has the elements\' type and no quantifier (§6.1)', JSON.stringify(bf.tags));
  ok(bf.formats?.quantifier === 'some' && bf.formats.type === 'string' && bf.formats.ops.join() === 'null,in',
    'Decision 1: with another operator, the list field keeps its quantifier', JSON.stringify(bf.formats));
  ok(bf.reviews?.type === 'string' && bf.reviews.ops.join() === 'null' && !('quantifier' in bf.reviews) && d.collections.books.relations?.reviews?.many === true,
    'Decision 1: null on a to-many relation has type string (the related items\' id) and no quantifier (§6.1)', JSON.stringify(bf.reviews));
  ok(!bf.notes, 'Decision 1: null on a list of objects that is not a relation is not declared', JSON.stringify(Object.keys(bf)));
  ok(finding(r, 'core.upload.only')?.where.join() === 'POST /scans' && /415/.test(finding(r, 'core.upload.only').fix) && /Accept-Post/.test(finding(r, 'core.upload.only').fix),
    'Decision 2: a collection that only takes files gets 415 with Accept-Post to a JSON body; one that also takes JSON does not (§5.1)', JSON.stringify(finding(r, 'core.upload.only')));
  ok(d.collections.notes?.upload && d.singletons?.settings?.methods?.join() === 'GET,PATCH' && !('method_effects' in d.singletons.settings),
    'Decision 8: OpenAPI says nothing about effects, so the singleton declares no method_effects (§5.9)', JSON.stringify(d.singletons));
  const withEffects = structuredClone(d);
  withEffects.singletons.settings.method_effects = { PATCH: [] };
  ok(validate(SCHEMA, withEffects).length === 0, 'Decision 8: a singleton with method_effects for PATCH validates against discovery.json', JSON.stringify(validate(SCHEMA, withEffects).slice(0, 2)));
  // Council, round 3 (§5.1): create iff the POST takes JSON (1); a JSON file in a collection that creates from JSON, only as multipart (2).
  ok(!d.collections.scans.schemas?.create && d.collections.notes.schemas?.create,
    'Round 3, decision 1: an upload collection declares schemas.create only where its POST takes JSON', JSON.stringify([d.collections.scans.schemas, d.collections.notes.schemas]));
  const bare = analyze(doc, { schemas: false }).discovery;
  ok(JSON.stringify(bare.collections.notes.schemas) === '{"create":{"type":"object"}}' && !bare.collections.scans.schemas && !bare.collections.books.schemas,
    'Round 3, decision 1: without --schemas, an upload collection that takes JSON still declares create, as {"type": "object"}', JSON.stringify([bare.collections.notes.schemas, bare.collections.books.schemas]));
}
{
  const ok200 = (schema) => ({ 200: { description: 'ok', content: { 'application/json': { schema } } } });
  const list = (item) => ({ type: 'object', properties: { items: { type: 'array', items: item }, next: { type: ['string', 'null'] } } });
  const created = { 201: { description: 'ok' } };
  const doc = { openapi: '3.1.0', info: { title: 'Round 3', version: '1' }, servers: [{ url: 'https://r3.example/' }], paths: {
    '/docs': { get: { responses: ok200(list({ type: 'object', properties: { id: { type: 'string' } } })) },
      post: { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string' } } } }, 'application/*': { schema: { type: 'string', format: 'binary' } } } }, responses: created } },
    '/configs': { get: { responses: ok200(list({ type: 'object', properties: { id: { type: 'string' } } })) },
      post: { requestBody: { content: { 'application/json': { schema: { type: 'object' } },
        'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } }, encoding: { file: { contentType: 'application/json' } } } } }, responses: created } },
    '/dumps': { get: { responses: ok200(list({ type: 'object', properties: { id: { type: 'string' } } })) },
      post: { requestBody: { content: { 'application/*': { schema: { type: 'string', format: 'binary' } } } }, responses: created } },
  } };
  const r = analyze(doc);
  const d = r.discovery;
  validates('Round 3', d);
  ok(d.collections.docs.upload?.multipart === true && d.collections.docs.schemas?.create && finding(r, 'core.upload.json-file')?.where.join() === 'POST /docs',
    'Round 3, decision 2: a collection that creates from JSON and takes application/* files declares "multipart": true, with a warning', JSON.stringify([d.collections.docs, finding(r, 'core.upload.json-file')]));
  ok(d.collections.configs.upload?.multipart === true && JSON.stringify(d.collections.configs.upload.media_types) === '["application/json"]' && d.collections.configs.schemas?.create,
    'Round 3, decision 2: a JSON file as the file part of multipart, beside JSON creation, keeps its multipart', JSON.stringify(d.collections.configs));
  ok(!d.collections.dumps.upload?.multipart && !d.collections.dumps.schemas?.create,
    'Round 3, decision 2: a collection that only takes files, JSON ones included, needs neither multipart nor create', JSON.stringify(d.collections.dumps));
}
{
  // Council, round 4 (§5.1): */* is a media range (2); +json types are files (1b); a JSON file in an upload-only
  // collection, also by */*, is a raw file (1a); a multipart file part keeps its media types.
  const ok200 = (schema) => ({ 200: { description: 'ok', content: { 'application/json': { schema } } } });
  const list = (item) => ({ type: 'object', properties: { items: { type: 'array', items: item }, next: { type: ['string', 'null'] } } });
  const created = { 201: { description: 'ok' } };
  const get = { responses: ok200(list({ type: 'object', properties: { id: { type: 'string' } } })) };
  const part = (contentType) => ({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } }, encoding: { file: { contentType } } });
  const doc = { openapi: '3.1.0', info: { title: 'Round 4', version: '1' }, servers: [{ url: 'https://r4.example/' }], paths: {
    '/anything': { get, post: { requestBody: { content: { '*/*': { schema: { type: 'string', format: 'binary' } } } }, responses: created } },
    '/both': { get, post: { requestBody: { content: { 'application/json': { schema: { type: 'object' } }, '*/*': { schema: { type: 'string', format: 'binary' } } } }, responses: created } },
    '/linked': { get, post: { requestBody: { content: { 'application/ld+json': { schema: { type: 'object' } } } }, responses: created } },
    '/linkedjson': { get, post: { requestBody: { content: { 'application/json': { schema: { type: 'object' } }, 'application/ld+json': { schema: { type: 'object' } } } }, responses: created } },
    '/parts': { get, post: { requestBody: { content: { 'multipart/form-data': part('*/*') } }, responses: created } },
    '/ldparts': { get, post: { requestBody: { content: { 'multipart/form-data': part('application/ld+json; profile="x"') } }, responses: created } },
  } };
  const r = analyze(doc);
  const d = r.discovery, cs = d.collections;
  validates('Round 4', d);
  ok(JSON.stringify(cs.anything.upload) === '{"media_types":["*/*"]}' && !cs.anything.schemas?.create && !finding(r, 'core.upload.only')?.where.includes('POST /anything'),
    'Round 4, decisions 1a and 2: a raw */* body is an upload-only collection, where a JSON body is a file, not a 415', JSON.stringify([cs.anything, finding(r, 'core.upload.only')]));
  ok(cs.both.upload?.multipart === true && cs.both.schemas?.create && finding(r, 'core.upload.json-file')?.where.includes('POST /both'),
    'Round 4, decisions 2 and 3: */* beside JSON creation admits JSON files, so the collection declares "multipart": true', JSON.stringify(cs.both));
  ok(JSON.stringify(cs.linked.upload) === '{"media_types":["application/ld+json"]}' && !cs.linked.schemas?.create && finding(r, 'core.upload.json-suffix')?.where.some((w) => w.startsWith('POST /linked ('))
    && finding(r, 'core.upload.only')?.where.includes('POST /linked'),
    'Round 4, decision 1b: an application/ld+json body is a file, with a warning, and the collection does not create from JSON', JSON.stringify([cs.linked, finding(r, 'core.upload.json-suffix')]));
  ok(JSON.stringify(cs.linkedjson.upload?.media_types) === '["application/ld+json"]' && !cs.linkedjson.upload.multipart && cs.linkedjson.schemas?.create,
    'Round 4, decision 1b: application/ld+json beside application/json is a file type that does not admit JSON, so no multipart', JSON.stringify(cs.linkedjson));
  ok(JSON.stringify(cs.parts.upload) === '{"media_types":["*/*"],"multipart":true}' && JSON.stringify(cs.ldparts.upload) === '{"media_types":["application/ld+json"],"multipart":true}',
    'Round 4: a multipart file part of */* or of a +json type with parameters keeps its media range and declares multipart', JSON.stringify([cs.parts.upload, cs.ldparts.upload]));
}

// External $refs, OpenAPI 3.0 nullable and Swagger 2
{
  const doc = parseDocument(JSON.stringify({ openapi: '3.0.0', info: { title: 'x', version: '1' }, paths: {
    '/things': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: { $ref: 'otro.yaml#/Thing' } }, next: { type: 'string', nullable: true } } } } } } } } },
    '/things/{id}': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string', nullable: true } } } } } } } } } } }));
  const r = analyze(doc);
  ok(r.unresolvedRefs.includes('otro.yaml#/Thing'), 'An external $ref is noted without breaking');
  ok(JSON.stringify(r.discovery.collections.things.schemas.item.properties.note.type) === '["string","null"]', 'OpenAPI 3.0 nullable becomes type with null');
  throws(() => parseDocument('{"swagger": "2.0", "paths": {}}'), /Swagger 2\.0.*OpenAPI 3/, 'Swagger 2.0 gives a clear error');
  throws(() => parseDocument('openapi: 4.0\npaths: {}'), /openapi: 3\.x/, 'An unknown version gives a clear error');
}

// ── CLI ─────────────────────────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'restep-from-openapi-'));
  const httpServer = createServer((req, res) => {
    if (req.url === '/openapi.yaml') { res.writeHead(200, { 'content-type': 'application/yaml' }); res.end(readFileSync(FIX('petstore-ampliada.yaml'))); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => httpServer.listen(HTTP_PORT, '127.0.0.1', r));
  try {
    const out = join(dir, 'discovery.json'), rep = join(dir, 'informe.md');
    const a = await run([FIX('casi-restep.json'), '--out', out, '--report', rep]);
    ok(a.code === 0 && existsSync(out) && existsSync(rep) && /core\s+100/.test(a.out), 'CLI: --out and --report', a.err || a.out);
    const disc = JSON.parse(readFileSync(out, 'utf8'));
    ok(validate(SCHEMA, disc).length === 0 && disc.restep === '1.0-draft.7', 'CLI: the --out file validates', JSON.stringify(validate(SCHEMA, disc).slice(0, 3)));
    ok(/^# Librería casi Restep/.test(readFileSync(rep, 'utf8')), 'CLI: the report is Markdown');
    const b = await run([`http://127.0.0.1:${HTTP_PORT}/openapi.yaml`, '--json', '--no-annotations', '--no-schemas']);
    let j = null;
    try { j = JSON.parse(b.out); } catch { /* fails below */ }
    ok(b.code === 0 && j?.api.title === 'Petstore ampliada' && j.validation.errors.length === 0, 'CLI: reads a URL and prints JSON', b.err);
    ok(j && !JSON.stringify(j.discovery).includes('x-confidence') && !j.discovery.collections.pets.schemas, 'CLI: --no-annotations and --no-schemas');
    const c = await run([FIX('legado-crm.yaml')]);
    ok(c.code === 0 && /^# CRM heredado/.test(c.out) && /core\.version\.header/.test(c.out), 'CLI: without --report, the report goes to standard output');
    const d = await run([join(dir, 'no-existe.yaml')]);
    ok(d.code === 1 && /does not exist/.test(d.err), 'CLI: a missing file gives 1 and a clear message', d.err);
    const e = await run([]);
    ok(e.code === 2 && /Usage:/.test(e.err), 'CLI: no arguments gives 2 and the usage');
    const f = await run([FIX('casi-restep.json'), '--nada']);
    ok(f.code === 2 && /Unknown option/.test(f.err), 'CLI: an unknown option gives 2');
    const g = await run([`http://127.0.0.1:${HTTP_PORT}/falta.yaml`]);
    ok(g.code === 1 && /404/.test(g.err), 'CLI: a URL that returns 404 gives 1', g.err);
  } finally {
    httpServer.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(failed ? `\n${failed} of ${passed + failed} tests fail` : `\nAll ${passed} tests pass`);
process.exit(failed ? 1 : 0);
