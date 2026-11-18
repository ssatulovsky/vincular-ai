import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTRASENA, correo, crearEscenario, pedir, type Escenario } from './escenario.ts';

let e: Escenario;
beforeAll(async () => {
  e = await crearEscenario();
});
afterAll(async () => e?.cerrar());

type Persona = { id: string; nombre: string; edad: number | null; alertasPendientes: number; tablets?: number; profesionales?: string[]; ultimaSesion?: unknown; nivelUltimos7Dias?: number };

describe('panel: listado de pacientes', () => {
  it('el administrador ve a todas, con datos administrativos y sin indicadores clínicos', async () => {
    const r = await pedir<{ personas: Persona[] }>(e.f, 'GET', '/api/personas', e.tokens.admin);
    expect(r.estado).toBe(200);
    const rosa = r.datos.personas.find((p) => p.id === e.ids.persona)!;
    expect(rosa).toMatchObject({ nombre: 'Rosa Elena Muñoz', tablets: 1 });
    expect(rosa.edad).toBeGreaterThan(80);
    expect(rosa.profesionales).toHaveLength(2);
    expect(rosa).not.toHaveProperty('ultimaSesion');
    expect(rosa).not.toHaveProperty('nivelUltimos7Dias');
    expect(rosa).not.toHaveProperty('alertasPendientes');
    expect(r.datos.personas.some((p) => p.id === e.ids.personaAjena)).toBe(true);
  });

  it('un clínico ve solo a sus asignadas, con indicadores clínicos', async () => {
    const r = await pedir<{ personas: Persona[] }>(e.f, 'GET', '/api/personas', e.tokens.supervisor);
    expect(r.datos.personas.map((p) => p.id)).toEqual([e.ids.persona]);
    expect(r.datos.personas[0]).toHaveProperty('nivelUltimos7Dias', 0);
  });

  it('la guardia ve a todas, solo con lo necesario para las alertas', async () => {
    const r = await pedir<{ personas: Persona[] }>(e.f, 'GET', '/api/personas', e.tokens.guardia);
    expect(r.datos.personas.length).toBeGreaterThanOrEqual(2);
    expect(r.datos.personas[0]).not.toHaveProperty('profesionales');
    expect(r.datos.personas[0]).not.toHaveProperty('ultimaSesion');
  });

  it('familiares y tablets no listan pacientes', async () => {
    expect((await pedir(e.f, 'GET', '/api/personas', e.tokens.familiar)).estado).toBe(403);
    expect((await pedir(e.f, 'GET', '/api/personas', e.tokens.dispositivo)).estado).toBe(403);
  });
});

describe('panel: ficha administrativa', () => {
  it('el administrador y los clínicos asignados ven la ficha; queda auditado', async () => {
    const r = await pedir<{ nombre: string; contactos: Array<{ nombre: string; telefono: string }>; dispositivos: unknown[]; equipo: unknown[] }>(e.f, 'GET', `/api/personas/${e.ids.persona}/ficha`, e.tokens.admin);
    expect(r.estado).toBe(200);
    expect(r.datos.nombre).toBe('Rosa Elena Muñoz');
    expect(r.datos.contactos[0]).toMatchObject({ nombre: 'Camila Muñoz', telefono: '+56911112222' });
    expect(r.datos.dispositivos).toHaveLength(1);
    expect(r.datos.equipo).toHaveLength(2);
    expect((await pedir(e.f, 'GET', `/api/personas/${e.ids.persona}/ficha`, e.tokens.enfermera)).estado).toBe(200);
    const a = await e.owner.query(`SELECT count(*)::int AS n FROM registro_auditoria WHERE accion = 'persona.ver_datos' AND persona_id = $1`, [e.ids.persona]);
    expect(a.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('un clínico no asignado, la guardia y el familiar no ven la ficha', async () => {
    for (const t of [e.tokens.supervisorAjeno, e.tokens.guardia, e.tokens.familiar]) expect((await pedir(e.f, 'GET', `/api/personas/${e.ids.persona}/ficha`, t)).estado).toBe(403);
  });

  it('solo el administrador edita los datos, y el nombre queda cifrado', async () => {
    const nueva = (await pedir<{ id: string }>(e.f, 'POST', '/api/personas', e.tokens.admin, { nombre: 'Ana Ruiz', comuna: 'Frutillar' })).datos.id;
    const cambio = { nombre: 'Ana María Ruiz', comuna: 'Frutillar', fechaNacimiento: '1950-07-01', estado: 'activa' };
    expect((await pedir(e.f, 'PUT', `/api/personas/${nueva}`, e.tokens.supervisor, cambio)).estado).toBe(403);
    expect((await pedir(e.f, 'PUT', `/api/personas/${nueva}`, e.tokens.admin, cambio)).estado).toBe(200);
    const f = await pedir<{ nombre: string; estado: string; fechaNacimiento: string }>(e.f, 'GET', `/api/personas/${nueva}/ficha`, e.tokens.admin);
    expect(f.datos).toMatchObject({ nombre: 'Ana María Ruiz', estado: 'activa', fechaNacimiento: '1950-07-01' });
    const crudo = await e.owner.query('SELECT nombre_cifrado FROM persona WHERE id = $1', [nueva]);
    expect(crudo.rows[0].nombre_cifrado.toString('utf8')).not.toContain('Ana');
  });

  it('edita contactos y los da de baja; los permisos cambiados quedan auditados', async () => {
    const id = (await pedir<{ id: string }>(e.f, 'POST', `/api/personas/${e.ids.persona}/contactos`, e.tokens.admin, { nombre: 'Pedro', relacion: 'vecino' })).datos.id;
    const cuerpo = { nombre: 'Pedro Díaz', relacion: 'vecino', telefono: '+56 9 3333 4444', esCuidador: false, prioridadEmergencia: 3, permisos: { resumen_bienestar: true, avisos_medicacion: false, hoja_control: false } };
    expect((await pedir(e.f, 'PUT', `/api/personas/${e.ids.persona}/contactos/${id}`, e.tokens.supervisor, cuerpo)).estado).toBe(403);
    expect((await pedir(e.f, 'PUT', `/api/personas/${e.ids.persona}/contactos/${id}`, e.tokens.admin, cuerpo)).estado).toBe(200);
    expect((await pedir(e.f, 'PUT', `/api/personas/${e.ids.persona}/contactos/${id}`, e.tokens.admin, { ...cuerpo, telefono: 'no es un teléfono' })).estado).toBe(400);
    // Un contacto de otra persona no se puede editar por esta ruta.
    expect((await pedir(e.f, 'PUT', `/api/personas/${e.ids.personaAjena}/contactos/${id}`, e.tokens.admin, cuerpo)).estado).toBe(404);
    const a = await e.owner.query(`SELECT detalle FROM registro_auditoria WHERE accion = 'contacto.editar' AND recurso_id = $1`, [id]);
    expect(a.rows[0].detalle.permisos.resumen_bienestar).toBe(true);
    expect((await pedir(e.f, 'DELETE', `/api/personas/${e.ids.persona}/contactos/${id}`, e.tokens.admin)).estado).toBe(200);
  });
});

describe('panel: baja de un contacto', () => {
  it('un contacto de baja desaparece de la ficha, no recibe avisos y su cuenta familiar se cierra; el historial queda', async () => {
    const p = (await pedir<{ id: string }>(e.f, 'POST', '/api/personas', e.tokens.admin, { nombre: 'Inés Mora', comuna: 'Puerto Varas' })).datos.id;
    const k = (await pedir<{ id: string }>(e.f, 'POST', `/api/personas/${p}/contactos`, e.tokens.admin, { nombre: 'Jorge Mora', relacion: 'hijo', telefono: '+56922223333', esCuidador: true, permisos: { resumen_bienestar: true } })).datos.id;
    const email = correo('hijo');
    await pedir(e.f, 'POST', '/api/cuentas', e.tokens.admin, { tipo: 'familiar', email, nombre: 'Jorge', contrasena: CONTRASENA, contactoId: k });
    const token = (await pedir<{ token: string }>(e.f, 'POST', '/api/auth/ingresar', undefined, { email, contrasena: CONTRASENA })).datos.token;
    expect((await pedir(e.f, 'GET', '/api/yo', token)).estado).toBe(200);

    expect((await pedir(e.f, 'DELETE', `/api/personas/${p}/contactos/${k}`, e.tokens.admin)).estado).toBe(200);
    const ficha = await pedir<{ contactos: unknown[] }>(e.f, 'GET', `/api/personas/${p}/ficha`, e.tokens.admin);
    expect(ficha.datos.contactos).toEqual([]);
    expect((await pedir(e.f, 'GET', '/api/yo', token)).estado).toBe(401);
    // Sigue en la base para el historial, marcado como de baja.
    const fila = await e.owner.query('SELECT dado_de_baja_en FROM contacto WHERE id = $1', [k]);
    expect(fila.rows[0].dado_de_baja_en).not.toBeNull();
    // No se puede editar ni usar como representante legal.
    expect((await pedir(e.f, 'POST', `/api/personas/${p}/consentimientos`, e.tokens.admin, { tipo: 'participacion_piloto', version: '1.0', otorgadoPor: 'representante_legal', contactoId: k })).estado).toBe(400);
    expect((await pedir(e.f, 'DELETE', `/api/personas/${p}/contactos/${k}`, e.tokens.admin)).estado).toBe(404);
  });
});

describe('panel: tablets, equipo y cuentas', () => {
  it('revocar una tablet la deja fuera de inmediato', async () => {
    const t = await pedir<{ id: string; token: string }>(e.f, 'POST', `/api/personas/${e.ids.persona}/dispositivos`, e.tokens.admin, { nombre: 'Tablet de repuesto' });
    expect((await pedir(e.f, 'GET', '/api/yo', t.datos.token)).estado).toBe(200);
    expect((await pedir(e.f, 'POST', `/api/personas/${e.ids.persona}/dispositivos/${t.datos.id}/revocar`, e.tokens.supervisor)).estado).toBe(403);
    expect((await pedir(e.f, 'POST', `/api/personas/${e.ids.persona}/dispositivos/${t.datos.id}/revocar`, e.tokens.admin)).estado).toBe(200);
    expect((await pedir(e.f, 'GET', '/api/yo', t.datos.token)).estado).toBe(401);
  });

  it('quitar una asignación saca a la persona del listado del profesional', async () => {
    const p = (await pedir<{ id: string }>(e.f, 'POST', '/api/personas', e.tokens.admin, { nombre: 'Marta Vera', comuna: 'Llanquihue' })).datos.id;
    await pedir(e.f, 'POST', `/api/personas/${p}/asignaciones`, e.tokens.admin, { cuentaId: e.ids.enfermera });
    const antes = await pedir<{ personas: Persona[] }>(e.f, 'GET', '/api/personas', e.tokens.enfermera);
    expect(antes.datos.personas.some((x) => x.id === p)).toBe(true);
    expect((await pedir(e.f, 'DELETE', `/api/personas/${p}/asignaciones/${e.ids.enfermera}`, e.tokens.admin)).estado).toBe(200);
    const despues = await pedir<{ personas: Persona[] }>(e.f, 'GET', '/api/personas', e.tokens.enfermera);
    expect(despues.datos.personas.some((x) => x.id === p)).toBe(false);
  });

  it('el administrador lista y desactiva cuentas; una cuenta desactivada pierde su sesión', async () => {
    const email = correo('gero');
    const id = (await pedir<{ id: string }>(e.f, 'POST', '/api/cuentas', e.tokens.admin, { tipo: 'personal', email, nombre: 'Gerontóloga', contrasena: CONTRASENA, rol: 'gerontologo' })).datos.id;
    const token = (await pedir<{ token: string }>(e.f, 'POST', '/api/auth/ingresar', undefined, { email, contrasena: CONTRASENA })).datos.token;
    const lista = await pedir<{ cuentas: Array<{ id: string; activa: boolean }> }>(e.f, 'GET', '/api/cuentas', e.tokens.admin);
    expect(lista.datos.cuentas.find((c) => c.id === id)?.activa).toBe(true);
    expect((await pedir(e.f, 'GET', '/api/cuentas', e.tokens.supervisor)).estado).toBe(403);
    expect((await pedir(e.f, 'PUT', `/api/cuentas/${id}/activa`, e.tokens.admin, { activa: false })).estado).toBe(200);
    expect((await pedir(e.f, 'GET', '/api/yo', token)).estado).toBe(401);
    expect((await pedir(e.f, 'POST', '/api/auth/ingresar', undefined, { email, contrasena: CONTRASENA })).estado).toBe(401);
  });
});

describe('panel: consentimiento', () => {
  it('registrar un consentimiento fija la vigencia en 6 meses; revocarlo la borra', async () => {
    const p = (await pedir<{ id: string }>(e.f, 'POST', '/api/personas', e.tokens.admin, { nombre: 'Olga Pérez', comuna: 'Puerto Montt' })).datos.id;
    const c = await pedir<{ id: string }>(e.f, 'POST', `/api/personas/${p}/consentimientos`, e.tokens.admin, { tipo: 'participacion_piloto', version: '1.0', otorgadoPor: 'persona' });
    expect(c.estado).toBe(201);
    const f = await pedir<{ consentimientoVigenteHasta: string; consentimientos: unknown[] }>(e.f, 'GET', `/api/personas/${p}/ficha`, e.tokens.admin);
    const meses = (new Date(f.datos.consentimientoVigenteHasta).getTime() - Date.now()) / (30 * 864e5);
    expect(meses).toBeGreaterThan(5.5);
    expect(meses).toBeLessThan(6.5);
    expect((await pedir(e.f, 'POST', `/api/personas/${p}/consentimientos/${c.datos.id}/revocar`, e.tokens.admin)).estado).toBe(200);
    const g = await pedir<{ consentimientoVigenteHasta: string | null }>(e.f, 'GET', `/api/personas/${p}/ficha`, e.tokens.admin);
    expect(g.datos.consentimientoVigenteHasta).toBeNull();
  });

  it('un representante legal debe ser un contacto de la persona', async () => {
    const sin = await pedir(e.f, 'POST', `/api/personas/${e.ids.persona}/consentimientos`, e.tokens.admin, { tipo: 'participacion_piloto', version: '1.0', otorgadoPor: 'representante_legal' });
    expect(sin.estado).toBe(400);
    const ok = await pedir(e.f, 'POST', `/api/personas/${e.ids.persona}/consentimientos`, e.tokens.admin, { tipo: 'participacion_piloto', version: '1.0', otorgadoPor: 'representante_legal', contactoId: e.ids.contacto });
    expect(ok.estado).toBe(201);
    expect((await pedir(e.f, 'POST', `/api/personas/${e.ids.persona}/consentimientos`, e.tokens.supervisor, { tipo: 'x', version: '1', otorgadoPor: 'persona' })).estado).toBe(403);
  });
});

describe('panel: clínico', () => {
  it('el clínico asignado ve las sesiones; el administrador no', async () => {
    await pedir(e.f, 'POST', '/api/conversacion/sesiones', e.tokens.dispositivo, { canal: 'texto' });
    const r = await pedir<{ sesiones: Array<{ canal: string; turnos: number }> }>(e.f, 'GET', `/api/personas/${e.ids.persona}/sesiones`, e.tokens.supervisor);
    expect(r.estado).toBe(200);
    expect(r.datos.sesiones.length).toBeGreaterThan(0);
    expect((await pedir(e.f, 'GET', `/api/personas/${e.ids.persona}/sesiones`, e.tokens.admin)).estado).toBe(403);
  });

  it('el historial del plan muestra autor y motivo', async () => {
    await pedir(e.f, 'PUT', `/api/personas/${e.ids.persona}/plan-terapeutico`, e.tokens.supervisor, { contenido: { objetivos: ['Retomar contacto con la hermana'] }, motivo: 'Plan inicial', versionBase: null });
    const r = await pedir<{ versiones: Array<{ version: number; autor: string; motivo: string }> }>(e.f, 'GET', `/api/personas/${e.ids.persona}/plan-terapeutico/versiones`, e.tokens.enfermera);
    expect(r.datos.versiones[0]).toMatchObject({ version: 1, autor: 'Prof supervisor_clinico', motivo: 'Plan inicial' });
    expect((await pedir(e.f, 'GET', `/api/personas/${e.ids.persona}/plan-terapeutico/versiones`, e.tokens.admin)).estado).toBe(403);
  });

  it('la bandeja de alertas trae el nombre de la persona', async () => {
    await e.owner.query(
      `INSERT INTO evento_riesgo (persona_id, nivel, nivel_reglas, fuente, fragmento_cifrado, accion, acuse_requerido) VALUES ($1, 2, 2, 'reglas', $2, 'avisar', true)`,
      [e.ids.persona, e.app.cifrador.cifrar('fragmento de prueba')],
    );
    const r = await pedir<{ alertas: Array<{ persona_id: string; persona_nombre: string }> }>(e.f, 'GET', '/api/alertas', e.tokens.guardia);
    expect(r.datos.alertas.find((a) => a.persona_id === e.ids.persona)?.persona_nombre).toBe('Rosa Elena Muñoz');
    expect(r.datos.alertas[0]).not.toHaveProperty('nombre_cifrado');
  });
});

describe('panel: página', () => {
  it('se sirve con política de contenido estricta y sin caché', async () => {
    const r = await e.f.inject({ method: 'GET', url: '/panel' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toContain('Panel del equipo');
    // Nada de lo que dice una persona se inserta como HTML.
    expect(r.body).not.toMatch(/innerHTML/);
  });
});
