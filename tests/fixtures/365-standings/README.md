# Ejemplos 365Scores para `contexto_liga` (26/10/2026)

Sacados desde el navegador (GET públicos, sin auth). **Recortados**: se quitaron campos cosméticos (`color`, `awayColor`, `imageVersion`, `popularityRank`, `nameForURL`, `symbolicName`, `hide*`, `has*` de UI, `sports`, `countries`, `bookmakers`, `competitors`, `destinations`) y en standings `rows[].detailedRecentForm` y `rows[].nextMatch`. Todo lo demás está tal cual.

Base: `https://webws.365scores.com/web/` · Query común: `appTypeId=5&langId=29&timezoneName=America/Bogota&userCountryId=101`

## Endpoints
| Archivo | URL (después de la base + query común) |
|---|---|
| premier-standings-total | `standings/?…&competitions=7` |
| premier-standings-local | `standings/?…&competitions=7&type=2` |
| premier-standings-visitante | `standings/?…&competitions=7&type=3` |
| premier-standings-anterior-total | `standings/?…&competitions=7&seasonNum=131` |
| premier-standings-anterior-local | `standings/?…&competitions=7&seasonNum=131&type=2` |
| betplay-standings-clausura-total | `standings/?…&competitions=620` (fase actual) |
| betplay-standings-clausura-local | `standings/?…&competitions=620&type=2` |
| betplay-standings-reclasificacion-2026 | `standings/?…&competitions=620&seasonNum=130&stageNum=2` |
| betplay-standings-apertura-2026-local | `standings/?…&competitions=620&seasonNum=130&stageNum=3&type=2` |
| betplay-standings-2025-apertura | `standings/?…&competitions=620&seasonNum=127&stageNum=3` |
| betplay-standings-2025-finalizacion | `standings/?…&competitions=620&seasonNum=127&stageNum=6` |

## Hallazgos
- **Standings trae el split casa/fuera**: `type=1` total (default), `type=2` local, `type=3` visitante (`filterTypes` en la respuesta). Cada fila: `competitor.id`, `position`, `gamePlayed`, `gamesWon/Even/Lost`, `for`, `against`, `points`. Con esto sale todo `contexto_liga` (gf/gc casa y fuera por equipo con su n, y promedios de liga sumando filas) en **3 llamadas por temporada/fase**, sin bajar partido por partido.
  - Chequeo Premier 2026/27 (8 fechas): tabla local 80 partidos, 121 goles local (1.51/p) y 101 visitante (1.26/p); cuadra con la total (160 filas-partido, 222 goles).
- **Temporada anterior**: `seasonNum=<n>`. Premier: actual 132 (2026/27), anterior 131 (38 fechas). Liga BetPlay: actual 130 (2026); la anterior es **127** (128 y 129 vienen vacías): los números **no son consecutivos**.
- **`stageNum` solo funciona junto con `seasonNum`**; si no, devuelve la fase actual. Un `stageNum` que no existe devuelve otra fase **sin error** (ojo: validar `standings[0].stageNum` en la respuesta).
- **Fases Liga BetPlay** (`competitions[0].seasons[].stages[]`): 2026 = 1 Promedios, 2 Reclasificación, 3 Apertura, 4–6 Cuartos/Semis/Final, 7 Clausura, 8 Cuadrangulares, 9 Final. 2025 (127) = 3 Apertura, 6 Finalización, 4/7 Cuadrangulares (numeración distinta). La respuesta solo trae la lista de fases de la temporada **actual**.
  - **Reclasificación (stageNum 2)** = tabla de todo el año (todos contra todos + playoffs). Útil para no partir los promedios en Apertura/Clausura cortos. ⚠️ incluye partidos de eliminación/cuadrangulares.
  - **Promedios (stageNum 1)** es la tabla del descenso (varios años): no usar.
- **Resultados** (`games/results`): ~20–25 partidos por página, todos `statusGroup 4` en el ejemplo, con `seasonNum`, `stageNum`, `roundNum`, `homeCompetitor/awayCompetitor.score`. Paginación con `paging.previousPage` / `nextPage` (`/web/games/?...&aftergame=<id>&direction=-1|1`). Ignora `seasonNum`. Para la temporada completa harían falta muchas páginas → mejor standings.
- Los standings de temporadas pasadas no traen `detailedRecentForm`.

## MLS (agregado el 26/10/2026, `userCountryId=109`)
| Archivo | URL |
|---|---|
| mls-standings-total | `standings/?…&competitions=104` |
| mls-standings-local | `standings/?…&competitions=104&type=2` |
| mls-standings-visitante | `standings/?…&competitions=104&type=3` |

Las dos conferencias (`groups`: 1 Este, 2 Oeste) vienen en el mismo `standings[0]`, con `groupNum` en cada fila y `position` dentro de la conferencia. Mismo recorte que los demás archivos.
