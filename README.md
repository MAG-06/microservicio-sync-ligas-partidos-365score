# sync-365

Mantiene en Supabase los **partidos programados de 365Scores** de las ligas mapeadas, guarda una **foto diaria de sus standings** (tabla total, local y visitante) y **resuelve el `game_id`** de 365Scores a partir de casa + liga de la casa + fecha + equipos. No descarga estadísticas ni usa IA. Es común a todas las casas: la traducción liga de la casa → competición de 365 sale de la tabla `equivalencias_liga` (la llena el servicio equivalencias-365).

**Lugar en el flujo:** casa → **sync-365** → stats-365 → IA → gateway. El gateway le pide el `game_id` de cada partido de la casa y usa `/equivalencias` para marcar qué ligas tienen estadísticas (`mapeada`).

**Puerto:** 8003

## Cómo correrlo

```bash
npm install
cp .env.example .env   # y llenar los valores
npm run dev            # desarrollo con recarga (tsx watch)
npm test               # tests (node:test + tsx; mockean fetch, sin llamadas reales)
npm run build          # compila a dist/
npm start              # producción (node dist/index.js)
```

## Variables de entorno

| Variable | Para qué | Obligatoria |
|---|---|---|
| `SUPABASE_URL` | URL de Supabase (`equivalencias_liga`, `partidos_programados_365`, `equipos_365`, `standings_365`) | **Sí** |
| `SUPABASE_KEY` | Clave de Supabase | **Sí** |
| `PUERTO` | Puerto del servidor (default `8003`) | No |
| `HOST` | Host del servidor (default `127.0.0.1`) | No |
| `CORS_ORIGEN` | Origen permitido (default `*`) | No |
| `SYNC_TOKEN` | Token Bearer de `POST /api/sync` y `POST /api/sync-standings`. Si no está definido, los dos siempre responden 401. | Sí, para sincronizar |
| `API_TOKEN` | Si se define, `/buscar-partido` y `/equivalencias` exigen `Authorization: Bearer <API_TOKEN>`; si no, son públicos | No |

## Endpoints

### `GET /salud`

```json
{ "estado": "ok" }
```

### `GET /buscar-partido`

```
GET /buscar-partido?casa=betplay&liga_casa_id=1000094985&fecha=2026-10-10&local=Millonarios&visitante=Nacional&inicio=2026-10-10T20:00:00-05:00
```

- `casa`, `liga_casa_id` (siempre string), `fecha` (`YYYY-MM-DD`, Bogotá), `local`, `visitante`: obligatorios.
- `inicio` (ISO con zona, opcional): hora de inicio según la casa. Activa el auto-alias y desempata.

```json
{ "game_id": 4512345, "competition_id": 620, "fecha_hora": "2026-10-10T20:00:00-05:00", "local": "Millonarios", "visitante": "Atlético Nacional", "fecha_difiere": false }
```

Cómo busca:

1. Traduce la liga con `equivalencias_liga` (`casa` + `liga_casa_id`, `activa = true`); si no hay → `LIGA_NO_MAPEADA`.
2. Si la liga no se sincronizó en las últimas 3 h, la sincroniza primero.
3. Busca en el día exacto (Bogotá). Los nombres se comparan normalizados (sin tildes, signos ni sufijos FC/CF/Club…) y contra los alias de `equipos_365`.
4. **Tolerancia de fecha:** si el día exacto no da nada, busca en ±3 días (`DIAS_TOLERANCIA_FECHA`) solo coincidencias completas; gana la más cercana a `inicio` (o al mediodía de `fecha`), empate → `PARTIDO_AMBIGUO`. La respuesta agrega `fecha_difiere: true` y `diferencia_minutos` (365Scores menos la hora de referencia).
5. **Auto-alias seguro:** con un único match parcial (un equipo coincide), devuelve el partido y aprende el alias del otro equipo solo si vino `inicio`, la hora difiere ≤ 30 min y el nombre no coincide con otro equipo de la competición. Si no, lo deja en el log `[auto-alias]` sin guardar. En la búsqueda con tolerancia nunca aprende.

### `GET /equivalencias?casa=betplay`

Ligas de la casa con equivalencia activa (la misma regla que usa `/buscar-partido` para `LIGA_NO_MAPEADA`). Pagina contra Supabase y ordena por `liga_casa_id` como texto. Casa sin equivalencias → 200 con `total: 0`.

```json
{ "casa": "betplay", "total": 1, "equivalencias": [{ "liga_casa_id": "1000094985", "competition_id_365": 620 }] }
```

### `POST /api/sync`

Header `Authorization: Bearer <SYNC_TOKEN>`. Toma las `competition_id_365` distintas de `equivalencias_liga` con `activa = true`, pide a 365Scores sus partidos actuales (máx. 2 ligas a la vez, pausa 1–2 s), hace upsert de partidos y equipos y actualiza `ultima_sincronizacion`.

Una competición que falla (365Scores caído o con formato inesperado, error de Supabase…) **no tumba el sync**: se loguea con `console.error`, se agrega a `errores` y se sigue con las demás. Su `ultima_sincronizacion` no se toca. La respuesta es 200 aunque haya errores; solo responde 502 si falla la lectura inicial de `equivalencias_liga`.

```json
{
  "ligas": 12,
  "partidos": 340,
  "errores": [
    { "competition_id": 999, "motivo": "Respuesta de 365Scores con formato inesperado: games.0.id: Expected number, received string; games.0.startTime: Required; games.0.statusText: Required (+3 mas)" }
  ]
}
```

- `ligas`: competiciones intentadas (incluye las que fallaron; sincronizadas = `ligas − errores.length`).
- `partidos`: partidos guardados de las competiciones que salieron bien.
- `errores`: una entrada por competición fallida; `[]` si todo salió bien. Si el fallo es de Zod, `motivo` resume las 3 primeras issues (`path: message`).

En el log del servicio queda el progreso:

```
[sync] Inicio: 12 ligas en 6 lotes
[sync] Lote 1/6 terminado (2/12 ligas)
…
[sync] Fin: 12 ligas, 340 partidos, 1 errores en 18.4 s
```

Se dispara a diario a las 6:30 a. m. (Bogotá) con el workflow `sync-365.yml` del repo `workflow_ligas_automatizacion` (secrets `SYNC365_URL` y `SYNC365_SYNC_TOKEN`).

### `POST /api/sync-standings`

Header `Authorization: Bearer <SYNC_TOKEN>`. Guarda en `standings_365` una **foto por día** (fecha de Bogotá) de la tabla total (`type` 1), local (2) y visitante (3) de cada temporada/fase. stats-365 la lee para `contexto_liga`; como 365Scores no da la tabla "como estaba" en una fecha pasada, lo que no se guarda ese día se pierde.

**Qué ligas:** las `competition_id_365` con equivalencia activa (las mismas de `/api/sync`) que además tienen algún partido en `partidos_programados_365` (columnas `competition_id` y `fecha_hora`) entre hace `DIAS_STANDINGS_ATRAS` (2) días y dentro de `DIAS_STANDINGS` (7) días. Los días hacia atrás hacen que entre la tabla final después de la última fecha, aunque falle una corrida. Una liga sin partidos en la ventana no se pide. Sus tablas se cierran cuando vuelva a tener partidos.

Por liga (máx. 2 ligas a la vez, pausa 1–2 s entre ligas y entre cada llamada a 365 de la misma liga):

1. Pide `/web/standings/?competitions=<id>&type=1` sin temporada ni fase. De ahí sale `currentSeasonNum`, y esa tabla se reutiliza. La **fase actual** es el `stageNum` de esa tabla (la que 365 muestra ahora), no `currentStageNum`: este puede ser una fase sin tabla (los Cuartos de la Copa de la Liga escocesa, 64), y entonces 365 cae a otra. Si no trae `standings` o `competitions[0].hasStandings` es `false` (copas, fases de eliminación), la liga cuenta en `sin_tabla` y no es error.
2. **Temporada actual.** Si la liga está en `FASES_REGULARES` (config), se piden sus fases de liga regular con `seasonNum` + `stageNum` (no playoffs, Reclasificación ni Promedios). Las fases con número mayor a la actual todavía no empiezan y no se piden. Si la temporada actual no está en el mapa, se guarda solo la fase actual y se avisa en `errores`. Si la liga no está en el mapa, es de una fase: se pide la fase actual (la Premier devuelve 1) con `seasonNum` + `stageNum`. Si la local o la visitante de la fase actual vuelven de otra fase, cuentan en `sin_tabla` (no en `errores`). Con `seasonNum` y sin `stageNum`, 365 elige otra fase o no devuelve nada. Por ejemplo, la 119 viene vacía; la 141 devuelve la Clausura, sin partidos; la 5653 devuelve el Repechaje, sin local/visitante.
3. **Temporada anterior.** Sale de `TEMPORADA_ANTERIOR`. Si la liga no está ahí, se usa la última ya guardada, y si no hay ninguna se prueba `seasonNum − 1`, `− 2` y `− 3` (los números no son consecutivos) y se toma la primera con filas. En una liga sin mapa, la total de la temporada anterior se pide sin `stageNum`, y la local y la visitante con la fase que devolvió esa total.
4. **Lo que ya no es actual** (fases cerradas, temporada anterior) se decide por fase, mirando la foto de su **total**. Se pide si la total no tiene foto, o si su última foto tiene `vigente_al_capturar = true`; en ese caso se pide una vez más para cerrarla. Las 3 tablas de una fase se piden siempre juntas, para validarlas juntas. Si la total quedó cerrada, la fase no se vuelve a pedir, aunque su local y su visitante se hayan descartado: 365 no cambia una fase cerrada. Las tablas cuya última foto quedó vigente y ya no son la actual (cambio de fase o de temporada) también se cierran así, aunque los mapas no estén actualizados.
5. **Validación:** si 365 devuelve un `seasonNum`/`stageNum` distinto al pedido (un `stageNum` inexistente devuelve otra fase sin error), esa consulta no se guarda y va a `errores`. La liga sigue. Hay dos casos que no son error y van a `sin_tabla`:
   - Una consulta que vuelve sin tabla.
   - Un `type` 2 o 3 sobre una tabla sin split local/visitante (sin ese `type` en `filterTypes`, p. ej. una Tabla Anual o la Reclasificación). Ante esa consulta 365 devuelve la tabla total, y guardarla como local o visitante sería falso.
6. **Grupos y conferencias** (MLS, Liga Profesional Argentina, Libertadores, Mundial…). 365 manda todos los grupos en la misma tabla, con `groupNum` en cada fila. Se guardan juntos solo si se puede comprobar que la tabla está completa:
   - **Total:** goles a favor igual a goles en contra, ganados igual a perdidos, sin equipos repetidos. Si falta un grupo, esas sumas no cuadran.
   - **Local/visitante:** solo si su total de la misma fase pasó la comprobación y no traen equipos que no estén en ella.
   - Si 365 devuelve varias tablas separadas en `standings`, o una tabla no pasa la comprobación, no se guarda nada de esa tabla. Cuenta en `sin_tabla` y el motivo va al log (`[standings] competition_id … sin tabla: …`), no a `errores`.
   - En estas ligas, `posicion` es la posición **dentro del grupo** (la MLS tiene dos primeros) y cada fila trae su `grupo`. En las tablas sin grupos, `grupo` es `null`.
7. **Partidos en vivo.** Mientras hay un partido en juego, la total de 365 ya lo cuenta y la local y la visitante no. Las filas de ese partido traen `liveGameId`. Si alguna fila de la total de la fase vigente lo trae, no se escribe ninguna de las 3 tablas de esa fase en esa corrida: quedan las de la última foto, y la tabla final entra en la siguiente corrida. Cuenta en `en_juego` y deja la línea `[standings] competition_id … en juego: N partidos en vivo, no se escribe la fase vigente`.
8. **Total contra local + visitante.** Cada partido suma 2 en la total (uno por equipo) y 1 en la local y 1 en la visitante. Por eso, en cualquier fase con las 3 tablas, los partidos de la total deben ser local + visitante:
   - **Hasta una jornada de diferencia** (equipos / 2 partidos): es el retraso de 365, que al terminar un partido actualiza la total antes que la local y la visitante. Se guarda igual (se corrige en la siguiente corrida) y queda el aviso `[standings] competition_id … no cuadra: total N partidos, local + visitante M (se guarda igual)`.
   - **Equipos que faltan o sobran:** local y visitante no se guardan, aunque la diferencia sea de menos de una jornada, porque el retraso nunca saca un equipo. Por ejemplo, en la temporada anterior de la 5062 a la local y la visitante les faltan 2 de 16 equipos. Un equipo que no aparece en la local pero tiene todos sus partidos en la visitante (todavía no jugó de local) no cuenta como faltante.
   - **Más de una jornada:** no es retraso. Por ejemplo, la Liga Pro 5062 en su fase de grupos tiene una total acumulada desde la temporada regular (542) y una local/visitante solo de la fase (56); otras ligas tienen la local/visitante con equipos de menos. La total se guarda; la local y la visitante no, cuentan en `sin_tabla` y el motivo va al log con los dos números.
9. **Local y visitante van juntas o ninguna.** Si una de las dos no se puede guardar (sin split, otra fase, grupos que no cuadran) o no tiene partidos mientras la otra sí, la otra tampoco se guarda. Cuenta en `sin_tabla` con el motivo en el log. La total se guarda igual.
10. **Solo se escribe lo que cambió:** se compara con la última foto de la misma clave (sin la fecha). Si las filas y `vigente_al_capturar` son iguales, o no hay partidos jugados, no se escribe nada. Si el sync corre dos veces el mismo día, la foto de ese día se reemplaza.

Una liga que falla (365 caído o con formato inesperado, error de Supabase…) no tumba el resto y no escribe nada de esa liga. Responde 200 al terminar, aunque haya errores. Solo responde 502 si falla la lectura inicial de `equivalencias_liga` o de `partidos_programados_365`.

**Una corrida a la vez.** Si llega otra llamada mientras una corrida sigue (por ejemplo el workflow y una corrida manual), responde **409 `SYNC_EN_CURSO`** sin hacer nada, y la corrida que estaba en curso sigue normal. El token se valida antes, así que sin token sigue siendo 401. El control es un flag en memoria: funciona porque Render corre una sola instancia, y se libera al terminar la corrida aunque falle.

```json
{
  "ligas": 12,
  "fotos_nuevas": 9,
  "sin_cambios": 27,
  "sin_tabla": 2,
  "en_juego": 1,
  "errores": [
    { "competition_id": 620, "motivo": "365 devolvio seasonNum 127 stageNum 3 al pedir seasonNum 127 stageNum 6 type 2: no se guarda" }
  ],
  "duracion_s": 41.2
}
```

- `ligas`: ligas activas con partidos en la ventana (incluye las que fallaron).
- `fotos_nuevas`: fotos escritas.
- `sin_cambios`: tablas pedidas a 365 que no generaron foto (iguales a la última o sin partidos).
- `sin_tabla`: consultas a 365 sin tabla, sin split local/visitante para ese `type`, con grupos que no se pudieron comprobar completos o con local/visitante que no cuadran con la total por más de una jornada. No son error.
- `en_juego`: fases vigentes que no se escribieron porque tenían un partido en vivo.
- `errores`: ligas que fallaron, consultas descartadas y avisos de config. Puede haber varias entradas por liga.
- `duracion_s`: segundos del sync completo.

Log: `[standings] Inicio: 12 de 199 ligas activas con partidos (-2/+7 dias) en 6 lotes (fecha 2026-10-27)`, una línea de progreso cada 10 lotes (`[standings] Lote 10/85 terminado (20/170 ligas)`, sirve de latido en Render) y `[standings] Fin: 12 ligas, 9 fotos nuevas, 27 sin cambios, 2 sin tabla, 1 en juego, 1 errores en 41.2 s`. Un día normal hace unas 3 llamadas a 365 por liga. La primera corrida también pide la temporada anterior.

Cada foto escrita deja una línea en el log que dice qué cambió respecto a la última foto de su clave. La comparación se hace por `equipo_id`, sin importar el orden de las filas.

```
[standings] competition_id 620 seasonNum 130 stageNum 7 type 1 foto nueva: 2 equipos cambiaron (partidos, ganados, perdidos, gf, gc, puntos)
[standings] competition_id 7 seasonNum 131 stageNum 1 type 2 foto nueva: primera foto (20 equipos)
[standings] competition_id 620 seasonNum 130 stageNum 3 type 1 foto nueva: vigente_al_capturar true -> false
```

Se dispara a diario a las 2:00 a. m. (Bogotá), cuando ya terminaron los partidos de la noche, con el workflow `standings-365.yml` del repo `workflow_ligas_automatizacion`. Va aparte de `sync-365.yml`, con los mismos secrets: primero despierta Render con `/salud`, después hace el POST con `curl --max-time 1800` (en las pruebas tardó entre 547 y 974 s con ~200 ligas activas) y queda en rojo si la respuesta no es 2xx.

**Cada temporada hay que actualizar** `FASES_REGULARES` y `TEMPORADA_ANTERIOR` en `src/config.ts`: Liga BetPlay (620) y Torneo BetPlay (5080) en enero, Premier (7) en agosto. Los números salen de la respuesta de `/web/standings/`: el `seasonNum` de `competitions[0].currentSeasonNum` y el `stageNum` de cada fase de `competitions[0].seasons[].stages[]`. Esa lista solo trae las fases de la temporada actual; las de una temporada pasada salen de `standings[0].stageNum` al pedirla. Una liga con Apertura/Clausura que no está en `FASES_REGULARES` se trata como de una fase. Su temporada anterior, pedida sin `stageNum`, puede devolver una tabla anual. Conviene agregarla al mapa.

#### Tabla `standings_365`

El SQL está en [`sql/standings_365.sql`](sql/standings_365.sql). Este servicio no la crea.

**Va sin RLS** por decisión temporal, igual que las demás tablas del proyecto. ⚠️ Sin RLS, cualquiera que tenga la clave anon de Supabase puede leer, escribir y borrar la tabla vía PostgREST. Esa clave no debe quedar en un frontend, un repo ni un log; hay que activar RLS con políticas antes de exponerla en cualquier lado.

| Columna | Tipo | Qué es |
|---|---|---|
| `id` | bigint identity | PK |
| `competition_id` | integer | competition de 365 |
| `season_num` | integer | `standings[0].seasonNum` |
| `stage_num` | integer not null | `standings[0].stageNum` (también en ligas de una fase) |
| `type` | smallint | 1 total, 2 local, 3 visitante |
| `fecha` | date | día de la foto (Bogotá) |
| `rows` | jsonb | `[{ equipo_id, nombre, posicion, partidos, ganados, empatados, perdidos, gf, gc, puntos, grupo }]`. `grupo` es el `groupNum` de 365 (conferencia/grupo, `posicion` es dentro de él) o `null` si la tabla no tiene grupos |
| `vigente_al_capturar` | boolean | si esa temporada/fase era la actual de 365 al tomar la foto |
| `actualizado_en` | timestamptz | cuándo se escribió |

Clave única: `(competition_id, season_num, stage_num, type, fecha)`. La tabla que había el día D es la foto más reciente con `fecha <= D` de esa clave.

## Errores

Formato: `{ "error": { "codigo": "…", "mensaje": "…" } }`

| Código | HTTP | Cuándo |
|---|---|---|
| `VALIDACION` | 400 | Query inválida (trae `detalles` con los issues de Zod) o JSON mal formado y cualquier otro 4xx de Fastify (Content-Type no soportado, cuerpo muy grande…). Los 4xx de Fastify se loguean con `console.warn` (método, URL, status original y mensaje; nunca cuerpo ni headers) |
| `NO_AUTORIZADO` | 401 | Token faltante o inválido |
| `LIGA_NO_MAPEADA` | 404 | La liga de la casa no tiene equivalencia activa en 365 |
| `PARTIDO_NO_ENCONTRADO` | 404 | No hay partido para esa fecha y equipos |
| `RUTA_NO_ENCONTRADA` | 404 | Ruta inexistente |
| `PARTIDO_AMBIGUO` | 409 | Varios candidatos; trae `candidatos` |
| `SYNC_EN_CURSO` | 409 | `POST /api/sync-standings` mientras otra corrida sigue en curso |
| `STATS_NO_DISPONIBLE` | 502 | Falló 365Scores o Supabase, o 365Scores respondió con un formato que no pasa Zod (p. ej. al sincronizar una liga desde `/buscar-partido`). El detalle va al log con `console.error` |
| `ERROR_INTERNO` | 500 | Error no previsto (el detalle solo va al log) |

---

El detalle del contrato (§5.6 `liga_casa_id`, §12 `/buscar-partido`, §12.1 `/equivalencias`) está en `DOCS/CONTRATO-ARQUITECTURA.md`, que es la fuente de verdad.
