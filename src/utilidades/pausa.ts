/** Pausa aleatoria entre peticiones para evitar rate-limit */

import { PAUSA_MIN_MS, PAUSA_MAX_MS } from "../config.js";

export function pausaAleatoria(): Promise<void> {
  const ms = PAUSA_MIN_MS + Math.random() * (PAUSA_MAX_MS - PAUSA_MIN_MS);
  return new Promise((resolver) => setTimeout(resolver, ms));
}
