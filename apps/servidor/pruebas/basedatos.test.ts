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
    expect(c.tareasSinModelo).toEqual(['riesgo', 'extraccion', 'informes']);
  });
  it('rechaza una clave de cifrado inválida', () => {
    expect(() => cargarConfig({ ...base, CLAVE_CIFRADO: 'corta' })).toThrow(/CLAVE_CIFRADO/);
  });
});
