import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Consultable } from '../db/conexion.ts';

/**
 * Costo de los modelos por conversación y por persona al mes, a partir de `uso_modelo`.
 * Los precios vienen de configuración (config/precios-modelos.json), nunca del código.
 */

const esquemaPrecios = z.object({
  verificadoEn: z.string().nullable().default(null),
  precios: z.record(z.string(), z.object({ entradaUsdPorMillon: z.number().nonnegative(), salidaUsdPorMillon: z.number().nonnegative() })).default({}),
});

export type TablaPrecios = z.infer<typeof esquemaPrecios>;

export function cargarPrecios(ruta: string): TablaPrecios {
  return esquemaPrecios.parse(JSON.parse(readFileSync(ruta, 'utf8')));
}

export function costoUsd(p: TablaPrecios, proveedor: string, modelo: string, entrada: number, salida: number): number | null {
  const precio = p.precios[`${proveedor}/${modelo}`];
  if (!precio) return null;
  return (entrada * precio.entradaUsdPorMillon + salida * precio.salidaUsdPorMillon) / 1_000_000;
}

interface FilaUso {
  persona_id: string | null;
  sesion_id: string | null;
  tarea: string;
  proveedor: string;
  modelo: string;
  entrada: string;
  salida: string;
  llamadas: string;
  fallidas: string;
}

export interface ResumenCosto {
  tokensEntrada: number;
  tokensSalida: number;
  llamadas: number;
  fallidas: number;
  /** null si algún modelo usado no tiene precio configurado. */
  usd: number | null;
  modelosSinPrecio: string[];
  porTarea: Record<string, { tokensEntrada: number; tokensSalida: number; usd: number | null }>;
}

function acumular(filas: FilaUso[], precios: TablaPrecios): ResumenCosto {
  const r: ResumenCosto = { tokensEntrada: 0, tokensSalida: 0, llamadas: 0, fallidas: 0, usd: 0, modelosSinPrecio: [], porTarea: {} };
  for (const f of filas) {
    const e = Number(f.entrada);
    const s = Number(f.salida);
    const usd = costoUsd(precios, f.proveedor, f.modelo, e, s);
    r.tokensEntrada += e;
    r.tokensSalida += s;
    r.llamadas += Number(f.llamadas);
    r.fallidas += Number(f.fallidas);
    if (usd === null) {
      r.usd = null;
      const clave = `${f.proveedor}/${f.modelo}`;
      if (!r.modelosSinPrecio.includes(clave)) r.modelosSinPrecio.push(clave);
    } else if (r.usd !== null) r.usd += usd;
    const t = (r.porTarea[f.tarea] ??= { tokensEntrada: 0, tokensSalida: 0, usd: 0 });
    t.tokensEntrada += e;
    t.tokensSalida += s;
    t.usd = usd === null || t.usd === null ? null : t.usd + usd;
  }
  return r;
}

/** Mes en formato AAAA-MM, en hora de Chile. */
export async function costosDelMes(bd: Consultable, precios: TablaPrecios, mes: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) throw Object.assign(new Error('El mes debe tener formato AAAA-MM'), { estado: 400 });
  const r = await bd.query<FilaUso>(
    `SELECT persona_id, sesion_id, tarea, proveedor, modelo,
            sum(tokens_entrada) AS entrada, sum(tokens_salida) AS salida, count(*) AS llamadas, count(*) FILTER (WHERE NOT ok) AS fallidas
       FROM uso_modelo
      WHERE creado_en >= ($1 || '-01')::date AT TIME ZONE 'America/Santiago'
        AND creado_en < (($1 || '-01')::date + interval '1 month') AT TIME ZONE 'America/Santiago'
      GROUP BY persona_id, sesion_id, tarea, proveedor, modelo`,
    [mes],
  );
  const porPersona = new Map<string, FilaUso[]>();
  const sesiones = new Map<string, Set<string>>();
  for (const f of r.rows) {
    const clave = f.persona_id ?? 'sin_persona';
    (porPersona.get(clave) ?? porPersona.set(clave, []).get(clave)!).push(f);
    if (f.sesion_id) (sesiones.get(clave) ?? sesiones.set(clave, new Set()).get(clave)!).add(f.sesion_id);
  }
  const personas = [...porPersona.entries()].map(([personaId, filas]) => {
    const total = acumular(filas, precios);
    const n = sesiones.get(personaId)?.size ?? 0;
    return { personaId, sesiones: n, usdPorConversacion: total.usd !== null && n > 0 ? total.usd / n : null, ...total };
  });
  return { mes, preciosVerificadosEn: precios.verificadoEn, total: acumular(r.rows, precios), personas };
}

export async function costoDeSesion(bd: Consultable, precios: TablaPrecios, sesionId: string): Promise<ResumenCosto> {
  const r = await bd.query<FilaUso>(
    `SELECT persona_id, sesion_id, tarea, proveedor, modelo, sum(tokens_entrada) AS entrada, sum(tokens_salida) AS salida, count(*) AS llamadas, count(*) FILTER (WHERE NOT ok) AS fallidas
       FROM uso_modelo WHERE sesion_id = $1 GROUP BY persona_id, sesion_id, tarea, proveedor, modelo`,
    [sesionId],
  );
  return acumular(r.rows, precios);
}
