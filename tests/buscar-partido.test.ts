/** Tests del flujo buscar-partido usando fixtures reales */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { esquemaRespuesta365 } from "../src/esquemas/validacion.js";
import { mapearEstado } from "../src/vistas-modelo/estado.js";
import { clasificarCandidatos } from "../src/vistas-modelo/buscar-partido.vm.js";
import { nombresCoinciden } from "../src/utilidades/nombres.js";
import { inicioDelDiaBogota, finDelDiaBogota, fechaEnZonaBogota } from "../src/utilidades/fecha.js";
import type { PartidoProgramadoDB, RespuestaBuscarPartido } from "../src/modelos/tipos.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function cargarFixture(nombre: string): unknown {
  const ruta = join(__dirname, "fixtures", nombre);
  return JSON.parse(readFileSync(ruta, "utf-8"));
}

function simularPartidosDB(fixture: unknown): PartidoProgramadoDB[] {
  const datos = esquemaRespuesta365.parse(fixture);
  return datos.games.map((g) => ({
    game_id: g.id,
    competition_id: g.competitionId,
    fecha_hora: g.startTime,
    estado: mapearEstado(g.statusGroup, g.statusText),
    ronda: g.roundNum ?? null,
    local_id: g.homeCompetitor.id,
    local_nombre: g.homeCompetitor.name,
    visitante_id: g.awayCompetitor.id,
    visitante_nombre: g.awayCompetitor.name,
    actualizado_en: new Date().toISOString(),
  }));
}

function filtrarPorFecha(
  partidos: PartidoProgramadoDB[],
  competitionId: number,
  fecha: string,
): PartidoProgramadoDB[] {
  const inicio = inicioDelDiaBogota(fecha);
  const fin = finDelDiaBogota(fecha);
  return partidos.filter((p) => {
    if (p.competition_id !== competitionId) return false;
    const dt = fechaEnZonaBogota(p.fecha_hora);
    return dt >= inicio && dt <= fin;
  });
}

describe("buscar-partido (flujo completo con fixture)", () => {
  const fixture = cargarFixture("partidos-actuales.json");
  const partidos = simularPartidosDB(fixture);
  const aliasMap = new Map<number, string[]>([
    [101, ["Nacional", "Verdolaga"]],
    [102, ["Millos"]],
    [103, []],
    [104, ["America", "Diablos Rojos"]],
    [105, ["Santa Fe", "Cardenal"]],
    [106, ["Junior", "Tiburon"]],
    [107, []],
    [108, []],
    [109, []],
    [110, []],
  ]);

  // Test 1 — Zod parsea correctamente la fixture
  it("parsea la fixture de partidos actuales con Zod", () => {
    const datos = esquemaRespuesta365.parse(fixture);
    assert.equal(datos.games.length, 5);
    assert.equal(datos.games[0].id, 3847291);
    assert.equal(datos.games[0].homeCompetitor.name, "Atlético Nacional");
  });

  // Test 2 — partido encontrado por nombre exacto
  it("encuentra partido por nombre exacto", () => {
    const enRango = filtrarPorFecha(partidos, 620, "2025-02-15");
    const { completos } = clasificarCandidatos(enRango, "Atlético Nacional", "Millonarios FC", aliasMap);
    assert.equal(completos.length, 1);
    assert.equal(completos[0].game_id, 3847291);
  });

  // Test 3 — partido encontrado por alias
  it("encuentra partido usando alias", () => {
    const enRango = filtrarPorFecha(partidos, 620, "2025-02-15");
    const { completos } = clasificarCandidatos(enRango, "Nacional", "Millos", aliasMap);
    assert.equal(completos.length, 1);
    assert.equal(completos[0].game_id, 3847291);
  });

  // Test 4 — partido no encontrado (nombre incorrecto)
  it("no encuentra partido con nombre incorrecto", () => {
    const enRango = filtrarPorFecha(partidos, 620, "2025-02-15");
    const { completos, parciales } = clasificarCandidatos(enRango, "Real Madrid", "Barcelona", aliasMap);
    assert.equal(completos.length, 0);
    assert.equal(parciales.length, 0);
  });

  // Test 5 — partido no encontrado (fecha incorrecta)
  it("no encuentra partido en otra fecha", () => {
    const enRango = filtrarPorFecha(partidos, 620, "2025-02-17");
    assert.equal(enRango.length, 0);
  });

  // Test 6 — liga no mapeada (simulado con competitionId distinto)
  it("no encuentra partido si la competicion no coincide", () => {
    const enRango = filtrarPorFecha(partidos, 999, "2025-02-15");
    assert.equal(enRango.length, 0);
  });

  // Test 7 — multiples candidatos ambiguos (ambos equipos con alias iguales)
  it("devuelve multiples candidatos completos cuando hay ambiguedad", () => {
    const aliasAmbiguo = new Map<number, string[]>([
      [101, ["Equipo Verde"]],
      [102, ["Equipo Azul"]],
      [107, ["Equipo Verde"]],
      [108, ["Equipo Azul"]],
    ]);
    const enRango = filtrarPorFecha(partidos, 620, "2025-02-15");
    const { completos } = clasificarCandidatos(enRango, "Equipo Verde", "Equipo Azul", aliasAmbiguo);
    assert.ok(completos.length > 1);
  });

  // Test 8 — partido del dia 16 no aparece al buscar el 15
  it("filtra correctamente por zona horaria Bogota", () => {
    const enRango = filtrarPorFecha(partidos, 620, "2025-02-15");
    const { completos } = clasificarCandidatos(enRango, "Independiente Santa Fe", "Junior FC", aliasMap);
    assert.equal(completos.length, 0);
  });

  // Test 9 — partido del dia 16 si aparece al buscar el 16
  it("encuentra partido del dia correcto en Bogota", () => {
    const enRango = filtrarPorFecha(partidos, 620, "2025-02-16");
    const { completos } = clasificarCandidatos(enRango, "Santa Fe", "Junior", aliasMap);
    assert.equal(completos.length, 1);
    assert.equal(completos[0].game_id, 3847293);
  });

  // Test 10 — prefijo "Atl. Nacional" coincide con "Atletico Nacional"
  it("encuentra partido con prefijo Atl. Nacional", () => {
    const enRango = filtrarPorFecha(partidos, 620, "2025-02-15");
    const { completos } = clasificarCandidatos(enRango, "Atl. Nacional", "Millonarios", aliasMap);
    assert.equal(completos.length, 1);
    assert.equal(completos[0].game_id, 3847291);
  });

  // Test 11 — prefijo "Dep. Cali" coincide con "Deportivo Cali"
  it("encuentra partido con prefijo Dep. Cali", () => {
    const enRango = filtrarPorFecha(partidos, 620, "2025-02-15");
    const { completos } = clasificarCandidatos(enRango, "Dep. Cali", "America", aliasMap);
    assert.equal(completos.length, 1);
    assert.equal(completos[0].game_id, 3847292);
  });

  // Test 12 — match parcial: un equipo coincide, el otro no, candidato unico
  it("detecta candidato parcial cuando solo un equipo coincide", () => {
    const enRango = filtrarPorFecha(partidos, 620, "2025-02-15");
    const { completos, parciales } = clasificarCandidatos(
      enRango, "Atlético Nacional", "Embajadores", aliasMap,
    );
    assert.equal(completos.length, 0);
    assert.equal(parciales.length, 1);
    assert.equal(parciales[0].partido.game_id, 3847291);
    assert.equal(parciales[0].equipoSinMatch, "visitante");
    assert.equal(parciales[0].equipoId, 102);
    assert.equal(parciales[0].nombreBuscado, "Embajadores");
  });

  // Test 13 — match parcial ambiguo: un nombre coincide con locales de 2+ partidos
  it("multiples parciales generan ambiguedad", () => {
    // "Boyaca Chico" coincide con 109 (local) y nada mas como visitante "Desconocido"
    // Pero con alias vacios, solo Boyaca Chico matchea por prefijo
    const enRango = filtrarPorFecha(partidos, 620, "2025-02-15");
    // Buscamos un visitante que no existe en ningun partido
    const { completos, parciales } = clasificarCandidatos(
      enRango, "Desconocido", "Millonarios", aliasMap,
    );
    assert.equal(completos.length, 0);
    // "Millonarios" coincide como visitante del partido 3847291
    assert.equal(parciales.length, 1);
    assert.equal(parciales[0].equipoSinMatch, "local");
  });

  // Test 14 — sin coincidencia total ni parcial
  it("no devuelve nada si ningun equipo coincide", () => {
    const enRango = filtrarPorFecha(partidos, 620, "2025-02-15");
    const { completos, parciales } = clasificarCandidatos(
      enRango, "Real Madrid", "Manchester United", aliasMap,
    );
    assert.equal(completos.length, 0);
    assert.equal(parciales.length, 0);
  });
});
