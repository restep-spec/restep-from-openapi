// Pruebas de restep-from-openapi.
//   node tools/restep-from-openapi/test.mjs       (desde projects/restep)
// Usa los puertos 8880 (sirve un fixture por HTTP) y 8881 (servidor de referencia, para validar su
// descubrimiento con el validador propio y comprobar así el validador).
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, parseDocument, parseYaml, validate, renderReport, stripAnnotations } from './restep-from-openapi.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TOOL = join(here, 'restep-from-openapi.mjs');
const SERVER = join(here, 'vendor/restep-server.mjs');
const SCHEMA = JSON.parse(readFileSync(join(here, 'schema/discovery.json'), 'utf8'));
const FIX = (f) => join(here, 'fixtures', f);
const HTTP_PORT = 8880, REF_PORT = 8881;

let passed = 0, failed = 0;
function ok(cond, name, detail = '') {
  if (cond) { passed++; console.log(`ok     ${name}`); }
  else { failed++; console.log(`FALLA  ${name}${detail ? `: ${detail}` : ''}`); }
}
function throws(fn, re, name) {
  try { fn(); ok(false, name, 'no lanza error'); }
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
  ok(y.openapi === '3.1.0' && y.info.title === 'Con: dos puntos', 'YAML: escalares y comentarios');
  ok(y.info.description === 'uno\ndos\n' && y.info.summary === 'plegado en una' && y.info.version === '1.0', 'YAML: bloques | y >-');
  ok(y.servers[0].url === 'https://x.example/v1', 'YAML: lista al mismo sangrado que su clave');
  ok(JSON.stringify(y.tags) === '["a","b, c",{"x":1}]', 'YAML: colecciones en línea');
  const op = y.paths['/a/{id}:cancel'].post;
  ok(op.parameters[1].schema.format === 'int64' && op.parameters[0].schema === op.parameters[1].schema, 'YAML: anclas y alias');
  ok(op.responses['200'].description === 'texto que sigue en otra línea', 'YAML: escalar en varias líneas');
  ok(y.merged.p === 1 && y.merged.q.length === 2, 'YAML: clave de fusión << y colección en varias líneas');
  ok(y.nulo === null && y.verdad === true && y.numero === -125, 'YAML: tipos del esquema core');
  throws(() => parseYaml('a:\n\tb: 1'), /línea 2.*tabulador/, 'YAML: tabulador en el sangrado da error con línea');
  throws(() => parseYaml('a: *nada'), /alias/, 'YAML: alias sin ancla da error');
  throws(() => parseYaml('a: [1, 2'), /cerrar/, 'YAML: colección sin cerrar da error');
}

// ── Validador JSON Schema ───────────────────────────────────────────────────
{
  ok(validate(SCHEMA, { restep: '1.0', collections: { books: { path: '/books' } } }).length === 0, 'Validador: descubrimiento mínimo válido');
  const bad = validate(SCHEMA, { restep: '2', profiles: ['sync'], collections: { books: { path: 'books', filter: { _x: { type: 'enum', ops: ['eq'] } }, actions: { changes: { on: 'item', safe: true, idempotent: true } } } } });
  const msgs = bad.map((e) => `${e.at} ${e.message}`).join(' | ');
  ok(/\/restep/.test(msgs) && /\/collections\/books\/path/.test(msgs) && /_x/.test(msgs) && /changes/.test(msgs) && /contains/.test(msgs) && /values/.test(msgs),
    'Validador: detecta versión, ruta, nombre _, acción changes, sync sin query y enum sin values', msgs);
  const ga = validate(SCHEMA, { restep: '1.0', collections: { b: { path: '/b', actions: { x: { on: 'item', safe: false, idempotent: true, method: 'GET' } } } } });
  ok(ga.length > 0, 'Validador: una acción GET no segura no valida (if/then)');
}

// El descubrimiento del servidor de referencia tiene que validar con el validador propio.
{
  const ref = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(REF_PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('el servidor de referencia no arranca')), 10000);
      ref.stdout.on('data', (d) => { if (/on http/.test(String(d))) { clearTimeout(t); resolve(); } });
      ref.on('exit', (c) => reject(new Error(`el servidor de referencia ha salido (${c})`)));
    });
    const disc = await (await fetch(`http://localhost:${REF_PORT}/`)).json();
    const errs = validate(SCHEMA, disc);
    ok(errs.length === 0, 'Validador: el descubrimiento del servidor de referencia valida', errs.slice(0, 3).map((e) => `${e.at} ${e.message}`).join('; '));
  } catch (e) { ok(false, 'Validador: servidor de referencia', e.message); }
  finally { ref.kill(); }
}

// ── Análisis de los fixtures ────────────────────────────────────────────────
const load = (f) => parseDocument(readFileSync(FIX(f), 'utf8'), f);
const ids = (r) => new Set(r.findings.map((f) => f.id));
const finding = (r, id) => r.findings.find((f) => f.id === id);
const validates = (name, disc) => {
  const e1 = validate(SCHEMA, disc), e2 = validate(SCHEMA, stripAnnotations(disc));
  ok(!e1.length && !e2.length, `${name}: el borrador valida contra discovery.json (con y sin anotaciones)`, [...e1, ...e2].slice(0, 3).map((e) => `${e.at} ${e.message}`).join('; '));
};

// §4.3 y apéndice A: un formulario sale de create; title, default y examples pasan tal cual, las
// etiquetas de un enum (x-enumNames) pasan a oneOf con title, y update se queda sin default.
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
    'formularios: default y etiquetas del enum en create', JSON.stringify(st));
  ok(s.create?.properties?.title?.title === 'Título' && s.create.properties.title.examples?.[0] === 'La niebla', 'formularios: title y example pasan a create', JSON.stringify(s.create?.properties?.title));
  ok(s.update && !('default' in (s.update.properties?.status ?? {})), 'formularios: update sin default', JSON.stringify(s.update?.properties?.status));
}

const pet = analyze(load('petstore-ampliada.yaml'));
{
  const has = ids(pet);
  const expected = ['core.list.array', 'core.list.envelope', 'core.list.next', 'core.put', 'core.patch.json-patch', 'core.error.media', 'core.post.status',
    'core.delete.status', 'data.id.type', 'data.money', 'data.underscore', 'data.timestamp-number', 'data.naming', 'query.pagination.offset',
    'query.filter.name', 'query.sort.name', 'query.limit.name', 'writes.etag', 'writes.if-match', 'writes.idempotency',
    'relations.scalar-fk', 'relations.id-array', 'actions.verb-path', 'query.search-path', 'core.item-post'];
  const missing = expected.filter((x) => !has.has(x));
  ok(!missing.length, 'Petstore: detecta los fallos esperados', `faltan ${missing.join(', ')}`);
  ok(pet.api.root === 'https://petstore.example.com/api/v1/' && pet.discovery.version === '1', 'Petstore: raíz y versión mayor');
  const where = finding(pet, 'query.filter.name').where.join(' ');
  // tags es una lista en Pet: desde el borrador 6 no se declara en filter (§6.1), sino como filtro con nombre.
  ok(/min_price → filter\[price\]\[ge\]/.test(where) && /created_after → filter\[created_at\]\[gt\]/.test(where) && /tags → filter\[tags\]( |$)/.test(where),
    'Petstore: traduce los filtros a filter[campo][op]', where);
  const pf = pet.discovery.collections.pets;
  ok(!pf.filter.tags && pf.named_filters?.tags?.type === 'string' && /lista/.test(pf.named_filters.tags.description) && finding(pet, 'query.filter.list'),
    'Petstore: el filtro sobre una lista pasa a named_filters con su descripción (§6.1)', JSON.stringify(pf.named_filters));
  ok(pf.named_filters?.q?.type === 'string' && /filter\[q\]/.test(finding(pet, 'query.search').where.join(' ')), 'Petstore: la búsqueda libre ?q pasa a un filtro con nombre', JSON.stringify(pf.named_filters));
  ok(finding(pet, 'core.put').section === '5.1' && finding(pet, 'core.error.media').section === '5.4' && finding(pet, 'query.pagination.offset').section === '6.4',
    'Petstore: cada hallazgo cita su apartado');
  ok(finding(pet, 'core.list.array').where.includes('GET /pets'), 'Petstore: cada hallazgo cita la operación de OpenAPI');
  const pets = pet.discovery.collections.pets;
  ok(pets && pets.path === '/pets' && pets.filter.price.type === 'decimal' && pets.filter.price.ops.join() === 'ge,le' && pets.filter.status.type === 'enum',
    'Petstore: filtros del borrador (precio decimal, estado enum)', JSON.stringify(pets?.filter));
  ok(pets.sort.join() === 'name,price,createdAt' && pets.max_limit === 100, 'Petstore: orden y max_limit del borrador');
  ok(pets.item_methods.join() === 'GET,PATCH,DELETE' && pets['x-restep-from-openapi'].notes.some((n) => /PUT/.test(n)), 'Petstore: PUT pasa a PATCH con nota');
  ok(pets.actions.adopt?.on === 'item' && pets.actions.adopt['x-confidence'] === 'low', 'Petstore: acción deducida de un verbo, con poca confianza');
  ok(pet.discovery.collections.orders.relations.customer?.to === 'customers', 'Petstore: relación deducida de customer_id');
  ok(!pet.discovery.profiles.includes('writes'), 'Petstore: no anuncia writes sin ETag');
  ok(pet.discovery.status === 'https://petstore.example.com/api/v1/health', 'Petstore: status desde /health');
  ok(!pet.passes.some((p) => /id son cadenas/.test(p.text)), 'Petstore: no dice que cumple lo que falla');
  validates('Petstore', pet.discovery);
}

const casi = analyze(load('casi-restep.json'));
{
  const serious = casi.findings.filter((f) => f.severity !== 'info');
  ok(!serious.length, 'Casi Restep: sin errores ni avisos', serious.map((f) => f.id).join(', '));
  ok(Object.values(casi.scores).filter((s) => s.score !== null).every((s) => s.score === 100) && casi.scores.sync.score === null, 'Casi Restep: 100 en lo que aplica; sync sin puntuar');
  const books = casi.discovery.collections.books;
  ok(books.filter.price.type === 'decimal' && books.filter['author.id'] && books.sort.join() === 'title,price' && books.max_limit === 50 && books.count === 'exact',
    'Casi Restep: filtros, orden, max_limit y count', JSON.stringify(books.filter));
  ok(books.relations.author?.to === 'authors' && books.relations.author.include === true && books.relations.reviews?.path === '/books/{id}/reviews',
    'Casi Restep: relación expandible y subcolección');
  ok(books.actions.reserve?.on === 'item' && books.actions.reserve.input?.properties?.hours, 'Casi Restep: acción con dos puntos y su input');
  ok(books.schemas?.update?.additionalProperties === false && !('id' in (books.schemas.create.properties ?? {})), 'Casi Restep: esquemas create y update');
  // Documenta Cache-Control y ETag en las lecturas: desde el borrador 6 eso es el perfil cache (§8), no writes.
  ok(casi.discovery.profiles.join() === 'core,query,writes,cache,relations' && casi.discovery.extensions.join() === 'actions,oauth' && casi.discovery.idempotency?.ttl === 86400,
    'Casi Restep: perfiles y extensiones', JSON.stringify([casi.discovery.profiles, casi.discovery.extensions]));
  ok(casi.discovery.collections.reviews?.path === '/books/{id}/reviews' && casi.discovery.collections.reviews.parent === 'books', 'Casi Restep: subcolección como colección con plantilla y parent (§4.2)');
  ok(casi.discovery.restep === '1.0-draft.6', 'Casi Restep: el borrador declara 1.0-draft.6 (§1.1)');
  validates('Casi Restep', casi.discovery);
}

const crm = analyze(load('legado-crm.yaml'));
{
  const has = ids(crm);
  const expected = ['core.version.header', 'core.reserved.dollar', 'core.reserved.conflict', 'core.rpc-path', 'core.error.in-200', 'core.list.next',
    'core.patch.media', 'core.post.id', 'query.pagination.cursor-param', 'relations.expand', 'writes.idempotency-name', 'sync.delta', 'sync.webhooks',
    'sync.changes', 'oauth.query-token', 'batch.bulk', 'data.date-format'];
  const missing = expected.filter((x) => !has.has(x));
  ok(!missing.length, 'CRM heredado: detecta los fallos esperados', `faltan ${missing.join(', ')}`);
  ok(crm.api.root === 'https://crm.example.com/api/v2/' && crm.discovery.version === '2' && crm.discovery.collections.accounts?.path === '/accounts',
    'CRM heredado: quita el prefijo /api/v2 de las rutas', crm.api.root);
  ok(finding(crm, 'core.reserved.conflict').where.some((w) => /\?since/.test(w)) && finding(crm, 'core.reserved.conflict').where.some((w) => /\?sort/.test(w)),
    'CRM heredado: since y sort=asc chocan con los reservados');
  ok(typeof crm.scores.sync.score === 'number', 'CRM heredado: sync se puntúa porque hay indicios');
  ok(/Referencia circular/.test(JSON.stringify(crm.discovery.collections.accounts.schemas.item)), 'CRM heredado: corta el esquema recursivo');
  validates('CRM heredado', crm.discovery);
}

// Borrador 6: singletons, id_from, subcolecciones anidadas, filtros prohibidos, Content-Type, cache y deprecated.
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
  validates('Borrador 6', d);
  ok(d.restep === '1.0-draft.6', 'Borrador 6: declara 1.0-draft.6');
  ok(d.singletons?.me?.path === '/me' && d.singletons.me.methods.join() === 'GET,PATCH' && d.singletons.me.description === 'The signed-in user.' && d.singletons.me.schemas?.update,
    'Borrador 6: /me es un singleton con GET y PATCH (§5.9)', JSON.stringify(d.singletons));
  ok(!d.singletons?.stats && !d.singletons?.old && finding(r, 'core.non-resource')?.where.some((w) => /\/authors\/stats/.test(w))
    && finding(r, 'core.non-resource').where.some((w) => /DELETE \/old/.test(w)),
    'Borrador 6: no son singleton una ruta bajo una colección ni un recurso con DELETE', JSON.stringify(finding(r, 'core.non-resource')?.where));
  const a = d.collections.authors;
  ok(a.id_from === 'client' && a.schemas.create.properties.id && finding(r, 'core.post.id')?.severity === 'info', 'Borrador 6: un id obligatorio en create da id_from client y se queda en el esquema (§5.1)', JSON.stringify(a.id_from));
  ok(a.filter.id.ops.join() === 'eq' && a.filter.active.ops.join() === 'eq', 'Borrador 6: id sin operadores de orden y boolean sin lt (§6.1)', JSON.stringify(a.filter));
  ok(!a.filter['books.title'], 'Borrador 6: no declara un filtro que atraviesa una relación a muchos (§6.1)', JSON.stringify(Object.keys(a.filter)));
  ok(!a.filter.labels && finding(r, 'query.limit.max')?.severity === 'warning', 'Borrador 6: limit sin máximo es un aviso (§6.4)');
  const books = Object.entries(d.collections).find(([, c]) => c.path === '/authors/{id}/books');
  const reviews = Object.entries(d.collections).find(([, c]) => /reviews$/.test(c.path));
  ok(books && books[1].parent === 'authors' && reviews && reviews[1].path === '/authors/{id}/books/{book_id}/reviews' && reviews[1].parent === books[0],
    'Borrador 6: subcolecciones con parent y variables distintas (§4.2)', JSON.stringify(reviews));
  ok(finding(r, 'core.request.media')?.where.some((w) => /POST \/uploads \(multipart/.test(w)), 'Borrador 6: un POST con multipart da un error de Content-Type (§3)');
  ok(d.profiles.includes('cache') === false && r.scores.cache.score === 100, 'Borrador 6: sin Cache-Control en todas las lecturas no anuncia cache, pero lo puntúa', JSON.stringify(d.profiles));
  ok(finding(r, 'core.deprecated')?.where.some((w) => /\?legacy/.test(w)) && finding(r, 'core.deprecated').where.some((w) => /GET \/old/.test(w)) && !d.deprecations,
    'Borrador 6: lo deprecated se anota sin inventar announced (§5.5)');
  ok(Object.values(d.collections).every((c) => !c.filter || Object.keys(c.filter).every((k) => /^[A-Za-z][A-Za-z0-9_-]{0,63}(\.[A-Za-z][A-Za-z0-9_-]{0,63})*$/.test(k))), 'Borrador 6: los nombres siguen la gramática (§3)');
}

// La puntuación ordena las API de más lejos a más cerca de Restep.
ok(casi.scores.core.score > pet.scores.core.score || casi.scores.query.score > pet.scores.query.score, 'Puntuación: la casi Restep sale mejor que el Petstore');

// Informe en Markdown
{
  const md = renderReport(pet, { source: 'petstore-ampliada.yaml', validation: { errors: [] } });
  ok(/\| core \| \d+\/100 \|/.test(md) && /\[§5\.4\]\(https:\/\/restep\.wubytes\.com\/es\/1\/#errores\)/.test(md) && /`GET \/pets`/.test(md) && /Validación contra discovery\.json: correcta/.test(md),
    'Informe: tabla por perfil, enlaces a la spec, endpoints y validación');
}

// $ref externos, OpenAPI 3.0 nullable y Swagger 2
{
  const doc = parseDocument(JSON.stringify({ openapi: '3.0.0', info: { title: 'x', version: '1' }, paths: {
    '/things': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: { $ref: 'otro.yaml#/Thing' } }, next: { type: 'string', nullable: true } } } } } } } } },
    '/things/{id}': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string', nullable: true } } } } } } } } } } }));
  const r = analyze(doc);
  ok(r.unresolvedRefs.includes('otro.yaml#/Thing'), 'Un $ref externo se anota sin romper');
  ok(JSON.stringify(r.discovery.collections.things.schemas.item.properties.note.type) === '["string","null"]', 'nullable de OpenAPI 3.0 pasa a type con null');
  throws(() => parseDocument('{"swagger": "2.0", "paths": {}}'), /Swagger 2\.0.*OpenAPI 3/, 'Swagger 2.0 da un error claro');
  throws(() => parseDocument('openapi: 4.0\npaths: {}'), /openapi: 3\.x/, 'Una versión desconocida da un error claro');
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
    ok(a.code === 0 && existsSync(out) && existsSync(rep) && /core\s+100/.test(a.out), 'CLI: --out y --report', a.err || a.out);
    const disc = JSON.parse(readFileSync(out, 'utf8'));
    ok(validate(SCHEMA, disc).length === 0 && disc.restep === '1.0-draft.6', 'CLI: el archivo de --out valida', JSON.stringify(validate(SCHEMA, disc).slice(0, 3)));
    ok(/^# Librería casi Restep/.test(readFileSync(rep, 'utf8')), 'CLI: el informe es Markdown');
    const b = await run([`http://127.0.0.1:${HTTP_PORT}/openapi.yaml`, '--json', '--no-annotations', '--no-schemas']);
    let j = null;
    try { j = JSON.parse(b.out); } catch { /* falla abajo */ }
    ok(b.code === 0 && j?.api.title === 'Petstore ampliada' && j.validation.errors.length === 0, 'CLI: lee una URL y saca JSON', b.err);
    ok(j && !JSON.stringify(j.discovery).includes('x-confidence') && !j.discovery.collections.pets.schemas, 'CLI: --no-annotations y --no-schemas');
    const c = await run([FIX('legado-crm.yaml')]);
    ok(c.code === 0 && /^# CRM heredado/.test(c.out) && /core\.version\.header/.test(c.out), 'CLI: sin --report, el informe va a la salida estándar');
    const d = await run([join(dir, 'no-existe.yaml')]);
    ok(d.code === 1 && /No existe el archivo/.test(d.err), 'CLI: archivo inexistente da 1 y un mensaje claro', d.err);
    const e = await run([]);
    ok(e.code === 2 && /Uso:/.test(e.err), 'CLI: sin argumentos da 2 y el uso');
    const f = await run([FIX('casi-restep.json'), '--nada']);
    ok(f.code === 2 && /Opción desconocida/.test(f.err), 'CLI: opción desconocida da 2');
    const g = await run([`http://127.0.0.1:${HTTP_PORT}/falta.yaml`]);
    ok(g.code === 1 && /404/.test(g.err), 'CLI: una URL que da 404 da 1', g.err);
  } finally {
    httpServer.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(failed ? `\n${failed} de ${passed + failed} pruebas fallan` : `\nLas ${passed} pruebas pasan`);
process.exit(failed ? 1 : 0);
