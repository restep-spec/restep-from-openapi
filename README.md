# restep-from-openapi (prototype)

Reads an API described in OpenAPI 3.0, 3.1 or 3.2 (JSON or YAML, file or URL) and produces:

1. A **report** of what it lacks to comply with [Restep 1](https://restep.wubytes.com/1/),
   profile by profile, with a rough score per profile. Each finding cites the section of the
   specification and the OpenAPI operations where it shows up (`GET /pets?page`,
   `esquema Pet.id`…), and says what to do.
2. A **draft discovery document** (§4.2) that validates against
   [`discovery.json`](https://restep.wubytes.com/1/schema/discovery.json) and declares
   `"restep": "1.0-draft.6"`, the text the tool follows (§1.1): collections and items from the
   paths, singletons, methods, schemas, filters, named filters, sorting, `max_limit`, relations
   and actions, with low-confidence deductions marked.

It only reads the description: it does not call the API. Whatever the description does not
document (an `ETag`, the error codes) counts as missing. To check a real server there is
[`restep-check`](https://restep.wubytes.com/tools/). One main file plus two modules (YAML and JSON
Schema), Node 18+, no dependencies.

## Usage

```bash
npx restep-from-openapi openapi.yaml               # report on standard output
npx restep-from-openapi openapi.json \
  --out discovery.json --report report.md    # both files and a summary
npx restep-from-openapi https://api.example.com/openapi.yaml --json
```

| Option | What it does |
|---|---|
| `--out <file>` | Writes the draft discovery document (JSON). |
| `--report <file>` | Writes the report in Markdown; only the score summary goes to standard output. Without it, the whole report goes to standard output. |
| `--json` | Outputs the full result as JSON (findings, what already complies, scores, the draft and its validation). |
| `--no-schemas` | Does not copy the OpenAPI schemas into `schemas` or into the actions' `input` (the draft gets much shorter). |
| `--no-annotations` | Without the `x-confidence`, `x-source` and `x-restep-from-openapi` members. |

Exit codes: `0` fine (even with findings), `1` the description could not be read, `2` wrong usage.
If the draft does not validate against the schema, it says so on standard error.

The `discovery.json` schema is looked up in `./schema/` next to the file and, failing that, at `https://restep.wubytes.com/1/schema/discovery.json`.
With none of them, the report says it has not been validated.

## What it detects

By profile; in brackets, the section of the specification. An **error** breaks a MUST that the
description makes visible; a **warning** is a MUST that probably fails, or a SHOULD; a **note**
does not take points off.

| Profile | Findings |
|---|---|
| core | Body of a `POST` to a collection or an action that is not `application/json` (forms, multipart) (3); list as a bare array, without `items` or without `next` (5.2); `PUT`, `PATCH` without Merge Patch or with JSON Patch, `POST` that creates without `201` or without `Location`, `POST` on an item, `DELETE` without `204`, RPC-style paths (`/getContacts`) (5.1); creation body that accepts `id`, which becomes `id_from` (note, 5.1); single-object resources that become singletons and resources outside Restep (notes, 5.9); `deprecated` operations, parameters or fields (note, 5.5); parameters with `$` and reserved ones used with another meaning (`since` as a date, `sort=asc`) (5.3); errors that are not `problem+json`, `problem+json` without `code`, `success`/`ok` in a `200` (5.4); version in a header, query or media type, or `/v1.2/` (5.5); numeric or missing `id`, fields with `_`, 64-bit integers, amounts as numbers, instants as numbers or without a format, mixed camelCase and snake_case (3) |
| query | Pagination by `offset`/`page` (also in the response: `page`, `total_pages`), cursor under another name, `page_size`/`per_page` instead of `limit`, `limit` without a maximum, which draft 6 requires to be declared (6.4); filters with their own names (`status`, `min_price`, `created_after`), with the translation to `filter[price][ge]` (6.1); filters on a field that is a list (`tags`), which become named filters, or that go through one (6.1); `sort_by`/`order` (6.2); `select` (6.3); `include_total` (6.5); searches on their own path (`/pets/findByStatus`) and free text `q`, which becomes a named filter (note) |
| writes | No `ETag` on the item `GET`, no `If-Match` (or `412`) on `PATCH`/`PUT`/`DELETE` (7.2); `POST` without `Idempotency-Key` or with another name (`X-Idempotency-Key`) (7.1) |
| cache | `Cache-Control` undocumented on reads (note, 8). Since draft 6 it is a profile separate from writes; if no read documents `Cache-Control`, it is not scored |
| relations | Relations as a bare identifier (`owner_id`) or a list of identifiers (`pet_ids`) (3); `expand`/`embed` instead of `include` (9) |
| sync | Parameters such as `modified_since`, `/changes` or `/delta` paths, webhooks; if there is any, `:changes` and `state` are missing (10). With no hints, sync is not scored |
| Extensions | Verbs in the URL that should be colon actions (11.1); `/bulk` and `/batch` (11.2); `filter` as a string (11.3); searches via `POST` (11.4); OAuth 2.0 (announce `oauth`) and credentials in the query (11.5) |

It also lists what already complies (problem+json, Merge Patch, `ETag`, `If-Match`,
`Idempotency-Key`, `items`/`next`, `cursor`, `filter[field][op]`, `sort`, `include`, colon
actions…), unless another operation breaks it.

**Score**: 100 minus 15 for each kind of error and 6 for each kind of warning, plus 2 for each
extra place where it repeats (up to 8 per kind); notes take nothing off; minimum 0. A profile with
nothing to evaluate (sync with no hints, writes with no writes) shows as "—". It is a rough guide:
it helps compare APIs and track progress, it does not certify anything.

## The draft discovery document

- **Root**: `servers[0].url` plus the common prefix of the paths if it ends in a version
  (`/api/v2`), which comes from the paths and gives `"version"`.
- **Collections**: a path that ends in a literal segment and lists (an array or a wrapper with an
  array), creates (`POST` with `201`) or has items (`/x/{id}`). Subcollections
  (`/books/{id}/reviews`) carry the template in `path`, name in `parent` the collection they hang
  from, and are also declared as a to-many relation of the parent. Template variables are kept as
  in OpenAPI unless they repeat or are not simple (§4.2): then they are renamed
  (`/authors/{id}/books/{id}/reviews` → `/authors/{id}/books/{book_id}/reviews`). If two
  collections end the same way, the parent's name goes first (`books_reviews`). The keys follow
  the naming grammar (§3).
- **Singletons** (§5.9): a path with no variables, not hanging from a collection, whose `GET`
  returns an object and that allows nothing but `GET`, `PATCH` or `PUT` (which becomes `PATCH`),
  such as `/me` or `/settings`. It gets `methods`, `description` and `item` and `update` schemas. A
  standalone resource with `POST` or `DELETE`, or under a collection's path, is left outside
  Restep with a note.
- **`id_from`** (§5.1): if the creation body accepts `id` without `readOnly`, `"client"` if it is
  required and `"either"` if not, and the `id` stays in `create`.
- **Methods**: OpenAPI's among `GET`, `POST`, `PATCH` and `DELETE`; an item `PUT` becomes `PATCH`,
  with a note.
- **Schemas**: `item` (the item `GET` or the list's), `create` (the `POST` body, without `id`) and
  `update` (the `PATCH` body, or the `PUT` one without `required` and with `null` allowed),
  converted to JSON Schema 2020-12 (`nullable`, `example`, boolean `exclusiveMinimum`) and with
  local `$ref` resolved; a cycle is cut. `title`, `description`, `default` and `examples` pass
  through as they are, because they are what a form uses (§4.3, appendix A); enum labels in
  `x-enumNames` become a `oneOf` of `const` with `title`, and `update` loses `default`, which means
  nothing in a `PATCH`.
- **Filters**: from the list's parameters. `filter[field][op]` and a `deepObject` `filter` are
  read as they are; free names are translated (`min_price` → `price` `ge`, `created_after` →
  `created_at` `gt`, an array → `in`). The type comes from the item's field if there is one
  (`decimal` for amounts and strings with a decimal pattern, `datetime`, `date`, `enum` with its
  `values`). Per §6.1 it does not declare ordering operators on `id`, operators other than `eq`,
  `ne` and `null` on a `boolean`, or a filter (or sort) on a field that is a list, through a to-many
  relation, or down to the `id` of a subcollection item.
- **Named filters** (§6.1): a parameter on a field that is a list (`tags`) and free-text search
  (`q`, `search`) become `named_filters`, with `type` and a description that needs reviewing,
  because it is what gives the filter its meaning.
- **Sorting**: the values of `sort`/`sort_by`/`order_by` when they are an enumeration.
- **`max_limit`**: the `maximum` of `limit`/`per_page`/`page_size`. **`count`**: `exact` if the
  list carries `total` or there is `count`/`include_total`.
- **Relations**: `owner_id` → `owner` (if the `owners` collection exists), `pet_ids` → `pets`, an
  `{id}` object or an embedded schema from another collection; `include: true` if the `include`
  parameter lists it.
- **Actions**: `POST /orders/{id}:cancel` and `POST /orders/{id}/cancel` (a known verb); a `GET`
  action becomes `safe` with `"method": "GET"`; `idempotent` on a `POST` action is a guess
  (`false`).
- **Profiles**: `core`; `query` if there are filters, named filters, sorting or `max_limit`;
  `writes` only if the description shows no writes errors; `cache` if every read documents
  `Cache-Control` and every item `GET`, `ETag`; `relations` if there are relations; the `actions`
  and `oauth` extensions where they apply. No experimental part (§1.2). `status` comes from
  `/health`, `/status` or similar.

Every deduced object carries `x-confidence` (`medium` or `low`) and `x-source` (where it comes
from), and every collection `x-restep-from-openapi` with its confidence and notes. They are `x-`
members, which the spec allows (§4.2), so the draft still validates, but they need reviewing and
removing before publishing it (`--no-annotations` removes them).

## YAML

The YAML parser is its own and covers what OpenAPI descriptions use: block maps and lists, quoted
and unquoted scalars (also multi-line), `|` and `>` blocks with their indicators, flow
collections, comments, anchors, aliases and `<<`. It does not support several documents in one
file (it reads the first), complex keys (`? `) or tabs in indentation, and it does not follow
`$ref` to other files (it notes them in the report). If a YAML file cannot be read, convert it to
JSON and pass the JSON:

```bash
yq -o=json openapi.yaml > openapi.json
npx @redocly/cli bundle openapi.yaml -o openapi.json   # also bundles $ref to other files
```

Swagger 2.0 is not supported: convert it first (`npx swagger2openapi swagger.json -o openapi.json`).

## Tests

```bash
node tools/restep-from-openapi/test.mjs      # from projects/restep
```

They test the YAML parser, the JSON Schema validator (also against the reference server's
discovery document, started on port 8881), the findings and the draft for three fixtures, which
the draft validates against `schema/discovery.json`, an inline description with what is
new in draft 6 (singletons, `id_from`, nested subcollections, filters §6.1 does not allow
declaring, `Content-Type`, cache and `deprecated`), and the CLI (files, `--json`, a URL served on
port 8880 and the errors).

The fixtures in `fixtures/`:

- `petstore-ampliada.yaml` (3.0, YAML): the Petstore with orders and customers and the usual bad
  habits (page-based pagination, bare arrays, `PUT`, JSON Patch, custom errors, numeric `id`, verbs
  in the URL, `findByStatus`).
- `casi-restep.json` (3.1, JSON): an almost-Restep bookshop (problem+json, Merge Patch, `ETag`,
  `If-Match`, `Idempotency-Key`, `filter[…]`, subcollection, `:reserve` action, OAuth 2.0). It must
  come out with no errors or warnings.
- `legado-crm.yaml` (3.1, YAML): a CRM with `/api/v2/getContacts` paths, OData (`$top`), version in
  a header, `since` as a date, `sort=asc`, `nextPageToken`, webhooks, `/bulk` and a key in the
  query.

## Limits

- It deduces from names and shapes. An oddly named filter, a verb not on its list or an unusual
  list wrapper slips through or is misclassified; that is why it marks confidence.
- It does not follow external `$ref` or `callbacks`/`links` beyond noting them.
- It does not detect language maps (§3) or `inherit` (§11.6): in OpenAPI they cannot be told apart
  from any other object.
- What OpenAPI does not say, the draft does not declare: `collations` (§6.1; an undeclared field
  compares by code points), `idempotency.anonymous` (§7.1), `deprecations` (§5.5: the `announced`
  instant is missing; anything `deprecated` comes out as a note), `sync` (§10) or any other
  experimental part, or an estimated `count`.
- It does not check what only shows on the running API: the `415` to other media types, `+` read
  as a space, `_etag` on every item, the origin `403` (§5.8)…
- It does not read each generator's own `x-` extensions (such as `x-pagination`) or the examples.
- Collections without a list `GET` (only `POST` and items) go into the draft with low confidence.

## Questions about the spec

Draft 6 settled three of the questions that were here: standalone resources are singletons or stay
outside Restep (§5.9), the client can choose the `id` with `id_from` (§5.1), and a field that is a
list is not declared in `filter` (§6.1; the tool proposes a named filter).

- **Exact or estimated `count`.** An OpenAPI description does not say; the tool assumes `exact`
  and notes it. It is not a gap in the spec, but a draft cannot know.
- **Singleton under a collection path.** §5.9 forbids a path "that a collection or an item has or
  may have". `/books/featured` is one (it could be an item); it is not clear whether
  `/books/7/summary` is too, which only an undeclared subcollection could have. The tool discards
  any path that starts with a collection's path.

## Code and issues

Code and issues: <https://github.com/restep-spec/restep-from-openapi>. That repository is generated from the Restep
site, where the tool is developed alongside the [specification](https://restep.wubytes.com/1/) and the reference
server: `vendor/` and `schema/` are copies from the site so the tests run on their own.

MIT licensed.
