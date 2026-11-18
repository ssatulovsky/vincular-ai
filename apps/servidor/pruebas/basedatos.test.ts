import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import pg from 'pg';
import { Cifrador } from '../src/seguridad/cifrado.ts';
import { cargarConfig } from '../src/config/config.ts';

let owner: pg.Pool;
let appBd: pg.Pool;
beforeAll(() => {
  owner = new pg.Pool({ connectionString: inject('urlOwner') });
  appBd = new pg.Pool({ connectionString: inject('urlApp') });
});
afterAll(async () => {
  await owner?.end();
  await appBd?.end();
});

describe('base de datos', () => {
  it('la auditoría no se modifica ni se borra, ni siquiera por el dueño de la tabla', async () => {
    await owner.query(`INSERT INTO registro_auditoria (actor_tipo, accion, recurso_tipo) VALUES ('sistema', 'prueba', 'x')`);
    await expect(owner.query(`UPDATE registro_auditoria SET accion = 'otra'`)).rejects.toThrow(/no admite/);
    await expect(owner.query(`DELETE FROM registro_auditoria`)).rejects.toThrow(/no admite/);
    await expect(owner.query(`TRUNCATE registro_auditoria`)).rejects.toThrow(/no admite/);
  });

  it('la aplicación no puede modificar turnos, planes, intervenciones ni el contenido de un evento de riesgo', async () => {
    for (const sql of [
      `UPDATE turno SET texto_cifrado = '\\x00'`,
      `DELETE FROM turno`,
      `UPDATE plan_terapeutico SET motivo = 'x'`,
      `DELETE FROM plan_terapeutico`,
      `UPDATE intervencion_guardian SET accion = 'regenerar'`,
      `UPDATE evento_riesgo SET nivel = 1`,
      `DELETE FROM evento_riesgo`,
    ]) {
      await expect(appBd.query(sql), sql).rejects.toThrow(/permission denied|permiso denegado/);
    }
  });

  it('la aplicación no puede crear ni borrar tablas', async () => {
    await expect(appBd.query('CREATE TABLE intrusa (id int)')).rejects.toThrow();
    await expect(appBd.query('DROP TABLE turno')).rejects.toThrow();
  });
});

describe('cifrado', () => {
  const c = new Cifrador(Buffer.alloc(32, 1));
  it('cifra y descifra; dos cifrados del mismo texto son distintos', () => {
    const a = c.cifrar('Me quiero morir');
    const b = c.cifrar('Me quiero morir');
    expect(a.equals(b)).toBe(false);
    expect(c.descifrar(a)).toBe('Me quiero morir');
  });
  it('detecta alteraciones', () => {
    const a = c.cifrar('texto');
    a.writeUInt8(a.readUInt8(a.length - 1) ^ 1, a.length - 1);
    expect(() => c.descifrar(a)).toThrow();
  });
  it('no descifra con otra clave', () => {
    expect(() => new Cifrador(Buffer.alloc(32, 2)).descifrar(c.cifrar('x'))).toThrow();
  });
});

describe('configuración', () => {
  const base = { DATABASE_URL: 'postgres://x', CLAVE_CIFRADO: 'a'.repeat(64) };
  it('en producción no arranca con números de emergencia sin verificar', () => {
    expect(() => cargarConfig({ ...base, NODE_ENV: 'production', IA_MODELO_CONVERSACION: 'm', IA_MODELO_GUARDIAN: 'm', IA_MODELO_RIESGO: 'm' })).toThrow(/no están verificados/);
  });
  it('acepta proveedores distintos por tarea', () => {
    const c = cargarConfig({ ...base, IA_PROVEEDOR: 'gemini', IA_PROVEEDOR_GUARDIAN: 'anthropic', IA_MODELO_CONVERSACION: 'g', IA_MODELO_GUARDIAN: 'c' });
    expect(c.ia.tareas.conversacion).toMatchObject({ proveedor: 'gemini', modelo: 'g' });
    expect(c.ia.tareas.guardian).toMatchObject({ proveedor: 'anthropic', modelo: 'c' });
    expect(c.tareasSinModelo).toEqual(['riesgo', 'extraccion', 'informes', 'embeddings', 'imagenes']);
  });
  it('trata las variables vacías del .env como no definidas', () => {
    const c = cargarConfig({ ...base, BASE_URL_PUBLICA: '', GEMINI_URL: '', TWILIO_ACCOUNT_SID: '', IA_MODELO_CONVERSACION: '' });
    expect(c.escalamiento.urlPublica).toBeNull();
    expect(c.escalamiento.twilio).toBeNull();
    expect(c.tareasSinModelo).toContain('conversacion');
  });
  it('el .env.example copiado tal cual, con la base y la clave completadas, es válido', () => {
    const ejemplo = Object.fromEntries(
      readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8')
        .split('\n')
        .filter((l) => /^[A-Z0-9_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    expect(() => cargarConfig({ ...ejemplo, ...base })).not.toThrow();
  });
  it('la conversación tiene respaldo: el modelo del guardián, salvo que se configure otro', () => {
    const c = cargarConfig({ ...base, IA_MODELO_CONVERSACION: 'grande', IA_MODELO_GUARDIAN: 'rapido', IA_PROVEEDOR_GUARDIAN: 'anthropic' });
    expect(c.ia.tareas.conversacion_respaldo).toMatchObject({ proveedor: 'anthropic', modelo: 'rapido', timeoutMs: 10_000 });
    expect(c.ia.tareas.conversacion.timeoutMs).toBe(15_000);
    expect(c.tareasSinModelo).not.toContain('conversacion_respaldo');
    const otro = cargarConfig({ ...base, IA_MODELO_GUARDIAN: 'rapido', IA_MODELO_CONVERSACION_RESPALDO: 'otro' });
    expect(otro.ia.tareas.conversacion_respaldo.modelo).toBe('otro');
  });
  it('la conversación razona en low por defecto; se puede cambiar o dejar el del modelo', () => {
    expect(cargarConfig(base).ia.tareas.conversacion.razonamiento).toBe('low');
    expect(cargarConfig(base).ia.tareas.riesgo.razonamiento).toBeUndefined();
    expect(cargarConfig({ ...base, IA_RAZONAMIENTO_CONVERSACION: 'medium' }).ia.tareas.conversacion.razonamiento).toBe('medium');
    expect(cargarConfig({ ...base, IA_RAZONAMIENTO_CONVERSACION: 'predeterminado' }).ia.tareas.conversacion.razonamiento).toBeUndefined();
    expect(() => cargarConfig({ ...base, IA_RAZONAMIENTO_CONVERSACION: 'minimal' })).toThrow(/low, medium, high/);
  });
  it('sigue rechazando una URL pública mal escrita', () => {
    expect(() => cargarConfig({ ...base, BASE_URL_PUBLICA: 'vincular.cl' })).toThrow(/BASE_URL_PUBLICA/);
  });
  it('rechaza una clave de API pegada en lugar del nombre del modelo', () => {
    expect(() => cargarConfig({ ...base, IA_MODELO_CONVERSACION: 'AQ.Ab8RNejemploNoEsUnaClaveReal' })).toThrow(/clave de API/);
    expect(() => cargarConfig({ ...base, IA_MODELO_GUARDIAN: 'AIzaSyEjemploNoReal' })).toThrow(/clave de API/);
    expect(() => cargarConfig({ ...base, IA_MODELO_RIESGO: 'sk-ant-ejemplo' })).toThrow(/clave de API/);
  });
  it('rechaza un idioma de voz escrito como palabra y acepta códigos', () => {
    expect(() => cargarConfig({ ...base, VOZ_STT_IDIOMA: 'spanish' })).toThrow(/VOZ_STT_IDIOMA/);
    expect(cargarConfig({ ...base, VOZ_STT_PROVEEDOR: 'elevenlabs', VOZ_STT_IDIOMA: 'es' }).voz.servicios.reconocimiento.idioma).toBe('es');
    expect(cargarConfig({ ...base, VOZ_STT_IDIOMA: 'es-US' }).voz.servicios.reconocimiento.idioma).toBe('es-US');
  });
  it('rechaza una cuenta de servicio de Google que no existe o con ruta relativa', () => {
    expect(() => cargarConfig({ ...base, VOZ_GOOGLE_CUENTA_SERVICIO: 'google-voz-key.json' })).toThrow(/VOZ_GOOGLE_CUENTA_SERVICIO/);
    expect(() => cargarConfig({ ...base, VOZ_GOOGLE_CUENTA_SERVICIO: '/no/existe/google.json' })).toThrow(/VOZ_GOOGLE_CUENTA_SERVICIO/);
  });
  it('rechaza una clave de cifrado inválida', () => {
    expect(() => cargarConfig({ ...base, CLAVE_CIFRADO: 'corta' })).toThrow(/CLAVE_CIFRADO/);
  });
});
