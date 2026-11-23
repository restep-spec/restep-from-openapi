# restep-from-openapi (prototipo)

Lee una API descrita en OpenAPI 3.0, 3.1 o 3.2 (JSON o YAML, archivo o URL) y produce:

1. Un **informe** de lo que le falta para cumplir [Restep 1](https://restep.wubytes.com/es/1/),
   perfil a perfil, con una puntuación orientativa por perfil. Cada hallazgo cita el apartado de
   la especificación y las operaciones de OpenAPI donde aparece (`GET /pets?page`,
   `esquema Pet.id`…), y dice qué hacer.
2. Un **borrador del documento de descubrimiento** (§4.2) que valida contra
   [`discovery.json`](https://restep.wubytes.com/1/schema/discovery.json) y declara
   `"restep": "1.0-draft.6"`, el texto que sigue la herramienta (§1.1): colecciones y elementos
   por las rutas, singletons, métodos, esquemas, filtros, filtros con nombre, orden,
   `max_limit`, relaciones y acciones, con lo deducido con poca confianza marcado.

Solo lee la descripción: no llama a la API. Lo que la descripción no documenta (una `ETag`, los
códigos de error) cuenta como ausente. Para comprobar un servidor de verdad está
[`restep-check`](https://restep.wubytes.com/es/herramientas/). Un archivo principal más dos
módulos (YAML y JSON Schema), Node 18+, sin dependencias.

## Uso

```bash
npx restep-from-openapi openapi.yaml               # informe por la salida estándar
npx restep-from-openapi openapi.json \
  --out discovery.json --report informe.md   # los dos archivos y un resumen
npx restep-from-openapi https://api.example.com/openapi.yaml --json
```

| Opción | Qué hace |
|---|---|
| `--out <archivo>` | Escribe el borrador del descubrimiento (JSON). |
| `--report <archivo>` | Escribe el informe en Markdown; por la salida estándar sale solo el resumen de puntuaciones. Sin ella, el informe entero va a la salida estándar. |
| `--json` | Saca el resultado completo en JSON (hallazgos, lo que ya cumple, puntuaciones, borrador y su validación). |
| `--no-schemas` | No copia los esquemas de OpenAPI en `schemas` ni en el `input` de las acciones (el borrador queda mucho más corto). |
| `--no-annotations` | Sin los miembros `x-confidence`, `x-source` y `x-restep-from-openapi`. |

Códigos de salida: `0` bien (aunque haya hallazgos), `1` no se pudo leer la descripción, `2` uso
incorrecto. Si el borrador no validara contra el esquema, lo avisa por la salida de errores.

El esquema `discovery.json` se busca en `./schema/` junto al archivo y, si no está, en `https://restep.wubytes.com/1/schema/discovery.json`.
Sin ninguno, el informe dice que no se ha validado.

## Qué detecta

Por perfil; entre paréntesis, el apartado de la especificación. Un **error** incumple un DEBE
que la descripción deja ver; un **aviso** es un DEBE que probablemente falla o un DEBERÍA; una
**nota** no resta puntos.

| Perfil | Hallazgos |
|---|---|
| core | Cuerpo de un `POST` a una colección o una acción que no es `application/json` (formularios, multipart) (3); lista como array suelto, sin `items` o sin `next` (5.2); `PUT`, `PATCH` sin Merge Patch o con JSON Patch, `POST` que crea sin `201` o sin `Location`, `POST` sobre un elemento, `DELETE` sin `204`, rutas estilo RPC (`/getContacts`) (5.1); cuerpo de creación que admite `id`, que pasa a `id_from` (nota, 5.1); recursos de un solo objeto que pasan a singleton y recursos fuera de Restep (notas, 5.9); operaciones, parámetros o campos `deprecated` (nota, 5.5); parámetros con `$` y reservados usados con otro significado (`since` como fecha, `sort=asc`) (5.3); errores que no son `problem+json`, `problem+json` sin `code`, `success`/`ok` en un `200` (5.4); versión en cabecera, query o tipo de medio, o `/v1.2/` (5.5); `id` numérico o ausente, campos con `_`, enteros de 64 bits, importes como número, instantes como número o sin formato, mezcla de camelCase y snake_case (3) |
| query | Paginación por `offset`/`page` (también en la respuesta: `page`, `total_pages`), cursor con otro nombre, `page_size`/`per_page` en vez de `limit`, `limit` sin máximo, que el borrador 6 exige declarar (6.4); filtros con nombres propios (`status`, `min_price`, `created_after`), con la traducción a `filter[price][ge]` (6.1); filtros sobre un campo que es una lista (`tags`), que pasan a filtro con nombre, o que atraviesan una (6.1); `sort_by`/`order` (6.2); `select` (6.3); `include_total` (6.5); búsquedas en su propia ruta (`/pets/findByStatus`) y texto libre `q`, que pasa a filtro con nombre (nota) |
| writes | Sin `ETag` en el `GET` del elemento, sin `If-Match` (ni `412`) en `PATCH`/`PUT`/`DELETE` (7.2); `POST` sin `Idempotency-Key` o con otro nombre (`X-Idempotency-Key`) (7.1) |
| cache | `Cache-Control` sin documentar en las lecturas (nota, 8). Desde el borrador 6 es un perfil aparte de writes; si ninguna lectura documenta `Cache-Control`, no se puntúa |
| relations | Relaciones como identificador suelto (`owner_id`) o lista de identificadores (`pet_ids`) (3); `expand`/`embed` en vez de `include` (9) |
| sync | Parámetros como `modified_since`, rutas `/changes` o `/delta`, webhooks; si hay alguno, falta `:changes` y `state` (10). Sin indicios, sync no se puntúa |
| Extensiones | Verbos en la URL que deberían ser acciones con dos puntos (11.1); `/bulk` y `/batch` (11.2); `filter` como cadena (11.3); búsquedas por `POST` (11.4); OAuth 2.0 (anunciar `oauth`) y credenciales en la query (11.5) |

También lista lo que ya cumple (problem+json, Merge Patch, `ETag`, `If-Match`,
`Idempotency-Key`, `items`/`next`, `cursor`, `filter[campo][op]`, `sort`, `include`, acciones con
dos puntos…), salvo que otra operación lo incumpla.

**Puntuación**: 100 menos 15 por cada tipo de error y 6 por cada tipo de aviso, más 2 por cada
lugar extra donde se repite (hasta 8 por tipo); las notas no restan; mínimo 0. Un perfil sin nada
que evaluar (sync sin indicios, writes sin escrituras) sale como «—». Es orientativa: sirve para
comparar API y seguir el progreso, no certifica nada.

## El borrador del descubrimiento

- **Raíz**: `servers[0].url` más el prefijo común de las rutas si acaba en una versión (`/api/v2`),
  que sale de las rutas y da `"version"`.
- **Colecciones**: una ruta que acaba en un segmento literal y lista (array o envoltorio con un
  array), crea (`POST` con `201`) o tiene elementos (`/x/{id}`). Las subcolecciones
  (`/books/{id}/reviews`) llevan la plantilla en `path`, nombran en `parent` la colección de la
  que cuelgan y se declaran también como relación a muchos del padre. Las variables de la
  plantilla se dejan como en OpenAPI salvo que se repitan o no sean simples (§4.2): entonces se
  renombran (`/authors/{id}/books/{id}/reviews` → `/authors/{id}/books/{book_id}/reviews`). Si
  dos colecciones acaban igual, la del padre va delante (`books_reviews`). Las claves siguen la
  gramática de nombres (§3).
- **Singletons** (§5.9): una ruta sin variables, que no cuelga de una colección, cuyo `GET`
  devuelve un objeto y que no admite más que `GET`, `PATCH` o `PUT` (que pasa a `PATCH`), como
  `/me` o `/settings`. Lleva `methods`, `description` y esquemas `item` y `update`. Un recurso
  suelto con `POST` o `DELETE`, o bajo la ruta de una colección, queda fuera de Restep con una
  nota.
- **`id_from`** (§5.1): si el cuerpo de creación admite `id` sin `readOnly`, `"client"` si es
  obligatorio y `"either"` si no, y el `id` se queda en `create`.
- **Métodos**: los de OpenAPI entre `GET`, `POST`, `PATCH` y `DELETE`; un `PUT` de elemento
  pasa a `PATCH`, con nota.
- **Esquemas**: `item` (el `GET` del elemento o el de la lista), `create` (cuerpo del `POST`, sin
  `id`) y `update` (cuerpo del `PATCH`, o el del `PUT` sin `required` y con `null` admitido),
  pasados a JSON Schema 2020-12 (`nullable`, `example`, `exclusiveMinimum` booleano) y con los
  `$ref` locales resueltos; un ciclo se corta. `title`, `description`, `default` y `examples`
  pasan tal cual, porque son lo que usa un formulario (§4.3, apéndice A); las etiquetas de un enum
  en `x-enumNames` pasan a un `oneOf` de `const` con `title`, y `update` se queda sin `default`,
  que en un `PATCH` no significa nada.
- **Filtros**: de los parámetros de la lista. `filter[campo][op]` y un `filter` `deepObject` se
  leen tal cual; los nombres libres se traducen (`min_price` → `price` `ge`, `created_after` →
  `created_at` `gt`, un array → `in`). El tipo sale del campo del elemento si existe (`decimal`
  para importes y cadenas con patrón decimal, `datetime`, `date`, `enum` con sus `values`). Por
  §6.1 no declara operadores de orden en `id` ni otros que `eq`, `ne` y `null` en un `boolean`,
  ni un filtro (u orden) sobre un campo que es una lista, por una relación a muchos o hasta el
  `id` del elemento de una subcolección.
- **Filtros con nombre** (§6.1): un parámetro sobre un campo que es una lista (`tags`) y la
  búsqueda libre (`q`, `search`) pasan a `named_filters`, con `type` y una descripción que hay
  que revisar, porque es lo que da su significado al filtro.
- **Orden**: los valores de `sort`/`sort_by`/`order_by` cuando son una enumeración.
- **`max_limit`**: el `maximum` de `limit`/`per_page`/`page_size`. **`count`**: `exact` si la
  lista lleva `total` o hay `count`/`include_total`.
- **Relaciones**: `owner_id` → `owner` (si existe la colección `owners`), `pet_ids` → `pets`,
  un objeto `{id}` o un esquema de otra colección incrustado; `include: true` si el parámetro
  `include` lo enumera.
- **Acciones**: `POST /orders/{id}:cancel` y `POST /orders/{id}/cancel` (un verbo conocido); una
  acción `GET` queda como `safe` con `"method": "GET"`; `idempotent` en una acción `POST` es una
  suposición (`false`).
- **Perfiles**: `core`; `query` si hay filtros, filtros con nombre, orden o `max_limit`;
  `writes` solo si la descripción no deja ver errores de writes; `cache` si todas las lecturas
  documentan `Cache-Control` y todos los `GET` de elemento, `ETag`; `relations` si hay
  relaciones; extensiones `actions` y `oauth` si toca. Ninguna parte experimental (§1.2).
  `status` sale de `/health`, `/status` o parecidas.

Cada objeto deducido lleva `x-confidence` (`medium` o `low`) y `x-source` (de dónde sale), y cada
colección `x-restep-from-openapi` con su confianza y notas. Son miembros `x-` que la spec permite
(§4.2), así que el borrador valida igual, pero hay que revisarlos y quitarlos antes de publicarlo
(`--no-annotations` los quita).

## YAML

El analizador YAML es propio y cubre lo que usan las descripciones OpenAPI: mapas y listas por
bloques, escalares con y sin comillas (también en varias líneas), bloques `|` y `>` con sus
indicadores, colecciones en línea, comentarios, anclas, alias y `<<`. No admite varios documentos
en un archivo (lee el primero), claves complejas (`? `) ni tabuladores en el sangrado, y no sigue
`$ref` a otros archivos (los anota en el informe). Si un YAML no se puede leer, conviértelo a JSON
y pásale el JSON:

```bash
yq -o=json openapi.yaml > openapi.json
npx @redocly/cli bundle openapi.yaml -o openapi.json   # también junta los $ref a otros archivos
```

Swagger 2.0 no está admitido: conviértelo antes (`npx swagger2openapi swagger.json -o openapi.json`).

## Pruebas

```bash
node tools/restep-from-openapi/test.mjs      # desde projects/restep
```

Prueban el analizador YAML, el validador JSON Schema (también contra el descubrimiento del
servidor de referencia, que arranca en el puerto 8881), los hallazgos y el borrador de tres
fixtures, que el borrador valida contra `schema/discovery.json`, una descripción en
línea con lo nuevo del borrador 6 (singletons, `id_from`, subcolecciones anidadas, filtros que
§6.1 no deja declarar, `Content-Type`, cache y `deprecated`), y la CLI (archivos,
`--json`, una URL servida en el puerto 8880 y los errores).

Los fixtures de `fixtures/`:

- `petstore-ampliada.yaml` (3.0, YAML): el Petstore con pedidos y clientes y los vicios habituales
  (paginación por página, arrays sueltos, `PUT`, JSON Patch, errores propios, `id` numérico,
  verbos en la URL, `findByStatus`).
- `casi-restep.json` (3.1, JSON): una librería casi Restep (problem+json, Merge Patch, `ETag`,
  `If-Match`, `Idempotency-Key`, `filter[…]`, subcolección, acción `:reserve`, OAuth 2.0). Debe
  salir sin errores ni avisos.
- `legado-crm.yaml` (3.1, YAML): un CRM con rutas `/api/v2/getContacts`, OData (`$top`),
  versión en cabecera, `since` como fecha, `sort=asc`, `nextPageToken`, webhooks, `/bulk` y
  clave en la query.

## Límites

- Deduce por nombres y formas. Un filtro con nombre raro, un verbo que no está en su lista o un
  envoltorio de lista poco habitual se le escapan o se clasifican mal; por eso marca la confianza.
- No sigue `$ref` externos ni `callbacks`/`links` más allá de anotarlos.
- No detecta mapas de idioma (§3) ni `inherit` (§11.6): en OpenAPI no se distinguen de un objeto
  cualquiera.
- Lo que OpenAPI no dice, el borrador no lo declara: `collations` (§6.1; un campo sin declarar
  compara por puntos de código), `idempotency.anonymous` (§7.1), `deprecations` (§5.5: falta el
  instante `announced`; lo `deprecated` sale como nota), `sync` (§10) ni ninguna otra parte
  experimental, ni `count` estimado.
- No comprueba lo que solo se ve en la API en marcha: el `415` a otros tipos de medio, el `+`
  leído como espacio, `_etag` en cada elemento, el `403` del origen (§5.8)…
- No lee `x-` propias de cada generador (como `x-pagination`) ni los ejemplos.
- Las colecciones sin `GET` de lista (solo `POST` y elementos) entran en el borrador con
  confianza baja.

## Dudas sobre la spec

El borrador 6 resolvió tres de las dudas que había aquí: los recursos sueltos son singletons o
quedan fuera de Restep (§5.9), el cliente puede elegir el `id` con `id_from` (§5.1) y un campo
que es una lista no se declara en `filter` (§6.1; la herramienta propone un filtro con nombre).

- **`count` exacto o estimado.** Una descripción OpenAPI no lo dice; la herramienta supone `exact`
  y lo anota. No es un hueco de la spec, pero un borrador no puede saberlo.
- **Singleton bajo una ruta de colección.** §5.9 prohíbe una ruta «que una colección o un elemento
  tenga o pueda tener». `/books/featured` lo es (podría ser un elemento); no queda claro si lo es
  también `/books/7/summary`, que solo una subcolección no declarada podría tener. La herramienta
  descarta cualquier ruta que empiece por la de una colección.

## Código y avisos

Código y avisos: <https://github.com/restep-spec/restep-from-openapi>. Ese repositorio se genera desde la web de
Restep, donde la herramienta se desarrolla junto a la [especificación](https://restep.wubytes.com/1/) y el servidor de
referencia: `vendor/` y `schema/` son copias de la web para que las pruebas funcionen solas.

Licencia MIT.
