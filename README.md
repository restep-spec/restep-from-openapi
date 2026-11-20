# restep-from-openapi (prototipo)

Lee una API descrita en OpenAPI 3.0, 3.1 o 3.2 (JSON o YAML, archivo o URL) y produce:

1. Un **informe** de lo que le falta para cumplir [Restep 1](https://restep.wubytes.com/es/1/),
   perfil a perfil, con una puntuación orientativa por perfil. Cada hallazgo cita el apartado de
   la especificación y las operaciones de OpenAPI donde aparece (`GET /pets?page`,
   `esquema Pet.id`…), y dice qué hacer.
2. Un **borrador del documento de descubrimiento** (§4.2) que valida contra
   [`discovery.json`](https://restep.wubytes.com/1/schema/discovery.json): colecciones y
   elementos por las rutas, métodos, esquemas, filtros, orden, `max_limit`, relaciones y
   acciones, con lo deducido con poca confianza marcado.

Solo lee la descripción: no llama a la API. Lo que la descripción no documenta (una `ETag`, los
códigos de error) cuenta como ausente. Para comprobar un servidor de verdad está
[`restep-check`](https://restep.wubytes.com/es/herramientas/). Un archivo principal más dos
módulos (YAML y JSON Schema), Node 18+, sin dependencias.

## Uso

```bash
node tools/restep-from-openapi/restep-from-openapi.mjs openapi.yaml                  # informe por la salida estándar
node tools/restep-from-openapi/restep-from-openapi.mjs openapi.json \
  --out discovery.json --report informe.md                                          # los dos archivos y un resumen
node tools/restep-from-openapi/restep-from-openapi.mjs https://api.example.com/openapi.yaml --json
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
| core | Lista como array suelto, sin `items` o sin `next` (5.2); `PUT`, `PATCH` sin Merge Patch o con JSON Patch, `POST` que crea sin `201` o sin `Location`, cuerpo de creación que admite `id`, `POST` sobre un elemento, `DELETE` sin `204`, rutas estilo RPC (`/getContacts`), recursos que no son colección ni elemento (5.1); parámetros con `$` y reservados usados con otro significado (`since` como fecha, `sort=asc`) (5.3); errores que no son `problem+json`, `problem+json` sin `code`, `success`/`ok` en un `200` (5.4); versión en cabecera, query o tipo de medio, o `/v1.2/` (5.5); `id` numérico o ausente, campos con `_`, enteros de 64 bits, importes como número, instantes como número o sin formato, mezcla de camelCase y snake_case (3) |
| query | Paginación por `offset`/`page` (también en la respuesta: `page`, `total_pages`), cursor con otro nombre, `page_size`/`per_page` en vez de `limit`, `limit` sin máximo (6.4); filtros con nombres propios (`status`, `min_price`, `created_after`), con la traducción a `filter[price][ge]` (6.1); `sort_by`/`order` (6.2); `select` (6.3); `include_total` (6.5); búsquedas en su propia ruta (`/pets/findByStatus`) y texto libre `q` (nota) |
| writes | Sin `ETag` en el `GET` del elemento, sin `If-Match` (ni `412`) en `PATCH`/`PUT`/`DELETE` (7.2); `POST` sin `Idempotency-Key` o con otro nombre (`X-Idempotency-Key`) (7.1); `Cache-Control` sin documentar (7.3, nota) |
| relations | Relaciones como identificador suelto (`owner_id`) o lista de identificadores (`pet_ids`) (3); `expand`/`embed` en vez de `include` (8) |
| sync | Parámetros como `modified_since`, rutas `/changes` o `/delta`, webhooks; si hay alguno, falta `:changes` y `state` (9). Sin indicios, sync no se puntúa |
| Extensiones | Verbos en la URL que deberían ser acciones con dos puntos (10.1); `/bulk` y `/batch` (10.2); `filter` como cadena (10.3); búsquedas por `POST` (10.4); OAuth 2.0 (anunciar `oauth`) y credenciales en la query (10.5) |

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
  (`/books/{id}/reviews`) llevan la plantilla en `path` y se declaran también como relación a
  muchos del padre. Si dos colecciones acaban igual, la del padre va delante (`books_reviews`).
- **Métodos**: los de OpenAPI entre `GET`, `POST`, `PATCH` y `DELETE`; un `PUT` de elemento
  pasa a `PATCH`, con nota.
- **Esquemas**: `item` (el `GET` del elemento o el de la lista), `create` (cuerpo del `POST`, sin
  `id`) y `update` (cuerpo del `PATCH`, o el del `PUT` sin `required` y con `null` admitido),
  pasados a JSON Schema 2020-12 (`nullable`, `example`, `exclusiveMinimum` booleano) y con los
  `$ref` locales resueltos; un ciclo se corta.
- **Filtros**: de los parámetros de la lista. `filter[campo][op]` y un `filter` `deepObject` se
  leen tal cual; los nombres libres se traducen (`min_price` → `price` `ge`, `created_after` →
  `created_at` `gt`, un array → `in`). El tipo sale del campo del elemento si existe (`decimal`
  para importes y cadenas con patrón decimal, `datetime`, `date`, `enum` con sus `values`).
- **Orden**: los valores de `sort`/`sort_by`/`order_by` cuando son una enumeración.
- **`max_limit`**: el `maximum` de `limit`/`per_page`/`page_size`. **`count`**: `exact` si la
  lista lleva `total` o hay `count`/`include_total`.
- **Relaciones**: `owner_id` → `owner` (si existe la colección `owners`), `pet_ids` → `pets`,
  un objeto `{id}` o un esquema de otra colección incrustado; `include: true` si el parámetro
  `include` lo enumera.
- **Acciones**: `POST /orders/{id}:cancel` y `POST /orders/{id}/cancel` (un verbo conocido); una
  acción `GET` queda como `safe` con `"method": "GET"`; `idempotent` en una acción `POST` es una
  suposición (`false`).
- **Perfiles**: `core`; `query` si hay filtros, orden o `max_limit`; `relations` si hay
  relaciones; `writes` solo si la descripción no deja ver errores de writes; extensiones
  `actions` y `oauth` si toca. `status` sale de `/health`, `/status` o parecidas.

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
fixtures, que el borrador valida contra `schema/discovery.json`, y la CLI (archivos,
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
- No detecta mapas de idioma (§3) ni `inherit` (§5.7): en OpenAPI no se distinguen de un objeto
  cualquiera.
- No lee `x-` propias de cada generador (como `x-pagination`) ni los ejemplos.
- Las colecciones sin `GET` de lista (solo `POST` y elementos) entran en el borrador con
  confianza baja.

## Dudas sobre la spec

- **Recursos que no son colecciones.** §5.1 y el descubrimiento solo hablan de colecciones y
  elementos. No queda claro si una API Restep puede tener además recursos sueltos (`/me`,
  `/store/inventory`, `/settings`) a los que se apliquen 5.3–5.4 y 7.3, ni cómo se anuncian. La
  herramienta los deja fuera del borrador con una nota.
- **Identificadores elegidos por el cliente.** §5.1 dice que el servidor DEBE asignar el `id` y dar
  `422` a un `POST` que lo trae. Muchas API usan claves naturales (`/users/{username}`) que elige
  el cliente al crear, a menudo con `PUT`. Restep 1 no ofrece camino para esas colecciones salvo
  separar `id` de la clave natural; quizá merezca una frase.
- **Filtros sobre campos que son listas.** Los tipos de §4.2 no incluyen listas, y §6.1 no dice qué
  significa `filter[tags]=a` sobre un campo array (¿contiene?). Es un caso muy común en OpenAPI
  (`tags`); la herramienta lo declara como `string` con confianza media.
- **`count` exacto o estimado.** Una descripción OpenAPI no lo dice; la herramienta supone `exact`
  y lo anota. No es un hueco de la spec, pero un borrador no puede saberlo.

## Código y avisos

Código y avisos: <https://github.com/restep-spec/restep-from-openapi>. Ese repositorio se genera desde la web de
Restep, donde la herramienta se desarrolla junto a la [especificación](https://restep.wubytes.com/1/) y el servidor de
referencia: `vendor/` y `schema/` son copias de la web para que las pruebas funcionen solas.

Licencia MIT.
