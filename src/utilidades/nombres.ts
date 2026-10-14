/** Normalizacion y comparacion de nombres de equipos por palabras */

import { SUFIJOS_EQUIPO } from "../config.js";

export function normalizarNombre(nombre: string): string {
  const n = nombre
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .trim();

  const palabras = n.split(/\s+/).filter((p) => !SUFIJOS_EQUIPO.includes(p));
  return palabras.length > 0 ? palabras.join(" ") : n;
}

export function palabrasNormalizadas(nombre: string): string[] {
  return normalizarNombre(nombre).split(/\s+/).filter(Boolean);
}

export function palabrasCoinciden(palabrasA: string[], palabrasB: string[]): boolean {
  if (palabrasA.length === 0 || palabrasB.length === 0) return false;

  const [cortas, largas] =
    palabrasA.length <= palabrasB.length ? [palabrasA, palabrasB] : [palabrasB, palabrasA];

  return cortas.every((pc) =>
    largas.some((pl) => pl === pc || (pc.length >= 3 && pl.startsWith(pc))),
  );
}

export function nombresCoinciden(
  nombreBuscado: string,
  nombre365: string,
  alias: string[],
): boolean {
  const palBuscado = palabrasNormalizadas(nombreBuscado);
  const pal365 = palabrasNormalizadas(nombre365);

  if (palabrasCoinciden(palBuscado, pal365)) return true;

  for (const a of alias) {
    const palAlias = palabrasNormalizadas(a);
    if (palabrasCoinciden(palBuscado, palAlias)) return true;
  }

  return false;
}
