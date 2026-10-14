/** Vista-modelo: equivalencias de liga de una casa (las ligas que /buscar-partido acepta) */

import { obtenerEquivalenciasPorCasa } from "../modelos/supabase.js";
import type { EquivalenciaLigaDB, RespuestaEquivalencias } from "../modelos/tipos.js";

/**
 * Regla unica de "liga mapeada": /buscar-partido responde LIGA_NO_MAPEADA cuando no se cumple
 * y /equivalencias lista solo las que la cumplen, asi ambos endpoints nunca se contradicen.
 */
export function equivalenciaActiva(equivalencia: Pick<EquivalenciaLigaDB, "activa">): boolean {
  return Boolean(equivalencia.activa);
}

export async function listarEquivalencias(casa: string): Promise<RespuestaEquivalencias> {
  const filas = await obtenerEquivalenciasPorCasa(casa);
  const equivalencias = filas
    .filter(equivalenciaActiva)
    // El contrato (§5.6) exige string; String() protege por si la columna llega como numero
    .map((f) => ({ liga_casa_id: String(f.liga_casa_id), competition_id_365: f.competition_id_365 }))
    // Orden de texto, no numerico ni de collation
    .sort((a, b) => (a.liga_casa_id < b.liga_casa_id ? -1 : a.liga_casa_id > b.liga_casa_id ? 1 : 0));

  return { casa, total: equivalencias.length, equivalencias };
}
