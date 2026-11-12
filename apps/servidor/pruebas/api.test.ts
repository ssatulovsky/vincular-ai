import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashContrasena } from '../src/seguridad/autenticacion.ts';
import { CONTRASENA, correo, crearEscenario, pedir, type Escenario } from './escenario.ts';

let e: Escenario;
beforeAll(async () => {
  e = await crearEscenario();
});
afterAll(async () => e?.cerrar());

describe('autenticación', () => {
  it('sin token no hay acceso', async () => {
    expect((await pedir(e.f, 'GET', '/api/yo')).estado).toBe(401);
    expect((await pedir(e.f, 'GET', '/api/yo', 'token-inventado')).estado).toBe(401);
  });

  it('identifica a cada tipo de actor', async () => {
    expect((await pedir(e.f, 'GET', '/api/yo', e.tokens.supervisor)).datos).toMatchObject({ tipo: 'personal', rol: 'supervisor_clinico' });
    expect((await pedir(e.f, 'GET', '/api/yo', e.tokens.familiar)).datos).toMatchObject({ tipo: 'familiar', personaId: e.ids.persona });
    expect((await pedir(e.f, 'GET', '/api/yo', e.tokens.dispositivo)).datos).toMatchObject({ tipo: 'dispositivo', personaId: e.ids.persona });
  });

  it('bloquea la cuenta tras 5 intentos fallidos, con el mismo mensaje que una cuenta inexistente', async () => {
    const email = correo('bloqueo');
    await e.app.bd.query(`INSERT INTO cuenta (tipo, email, nombre, hash_contrasena, rol) VALUES ('personal', $1, 'B', $2, 'gerontologo')`, [email, await hashContrasena(CONTRASENA)]);
    for (let i = 0; i < 5; i++) expect((await pedir(e.f, 'POST', '/api/auth/ingresar', undefined, { email, contrasena: 'incorrecta' })).estado).toBe(401);
    const bloqueada = await pedir<{ error: string }>(e.f, 'POST', '/api/auth/ingresar', undefined, { email, contrasena: CONTRASENA });
    const inexistente = await pedir<{ error: string }>(e.f, 'POST', '/api/auth/ingresar', undefined, { email: correo('nadie'), contrasena: CONTRASENA });
    expect(bloqueada.estado).toBe(401);
    expect(bloqueada.datos.error).toBe(inexistente.datos.error);
    const a = await e.owner.query(`SELECT 1 FROM registro_auditoria WHERE accion = 'cuenta.bloqueada'`);
    expect(a.rowCount).toBeGreaterThan(0);
  });

  it('cerrar sesión invalida el token en el servidor', async () => {
    const email = correo('salida');
    await e.app.bd.query(`INSERT INTO cuenta (tipo, email, nombre, hash_contrasena, rol) VALUES ('personal', $1, 'S', $2, 'gerontologo')`, [email, await hashContrasena(CONTRASENA)]);
    const { datos } = await pedir<{ token: string }>(e.f, 'POST', '/api/auth/ingresar', undefined, { email, contrasena: CONTRASENA });
    expect((await pedir(e.f, 'GET', '/api/yo', datos.token)).estado).toBe(200);
    await pedir(e.f, 'POST', '/api/auth/salir', datos.token, {});
    expect((await pedir(e.f, 'GET', '/api/yo', datos.token)).estado).toBe(401);
  });

  it('exige contraseñas de al menos 12 caracteres', async () => {
    const r = await pedir(e.f, 'POST', '/api/cuentas', e.tokens.admin, { tipo: 'personal', email: correo('corta'), nombre: 'X', contrasena: 'corta', rol: 'gerontologo' });
    expect(r.estado).toBe(400);
  });
});

describe('altas', () => {
  it('solo el administrador crea personas, cuentas y dispositivos', async () => {
    for (const t of [e.tokens.supervisor, e.tokens.guardia, e.tokens.familiar, e.tokens.dispositivo]) {
      expect((await pedir(e.f, 'POST', '/api/personas', t, { nombre: 'X Y', comuna: 'Frutillar' })).estado).toBe(403);
      expect((await pedir(e.f, 'POST', `/api/personas/${e.ids.persona}/dispositivos`, t, { nombre: 'otra' })).estado).toBe(403);
    }
  });

  it('el token del dispositivo se guarda solo como hash', async () => {
    const r = await e.owner.query<{ token_hash: Buffer }>('SELECT token_hash FROM dispositivo WHERE persona_id = $1', [e.ids.persona]);
    expect(r.rows[0]!.token_hash.length).toBe(32);
    expect(r.rows[0]!.token_hash.toString('base64url')).not.toBe(e.tokens.dispositivo);
  });

  it('no se puede asignar a la guardia ni al administrador como equipo de una persona', async () => {
    const g = await e.owner.query<{ id: string }>(`SELECT id FROM cuenta WHERE rol = 'guardia' LIMIT 1`);
    const r = await pedir(e.f, 'POST', `/api/personas/${e.ids.persona}/asignaciones`, e.tokens.admin, { cuentaId: g.rows[0]!.id });
    expect(r.estado).toBe(400);
  });

  it('el perfil del compañero no puede ser romántico ni hacerse pasar por humano', async () => {
    const url = `/api/personas/${e.ids.persona}/perfil-companero`;
    expect((await pedir(e.f, 'PUT', url, e.tokens.admin, { nombre: 'Tito', personalidad: 'Cariñoso, como si fueras mi novio' })).estado).toBe(400);
    expect((await pedir(e.f, 'PUT', url, e.tokens.admin, { nombre: 'Tito', personalidad: 'Finge que eres una persona real' })).estado).toBe(400);
    expect((await pedir(e.f, 'PUT', url, e.tokens.admin, { nombre: 'Tito', personalidad: 'Me gusta que diga "te amo" al despedirse' })).estado).toBe(400);
    expect((await pedir(e.f, 'PUT', url, e.tokens.admin, { nombre: 'Tito', personalidad: 'Alegre, futbolero y buen conversador', trato: 'tu' })).estado).toBe(200);
  });
});

describe('plan terapéutico', () => {
  const url = () => `/api/personas/${e.ids.persona}/plan-terapeutico`;

  it('solo el supervisor asignado lo edita; cada cambio es una versión con autor y motivo', async () => {
    const plan = { contenido: { objetivos: ['Salir a caminar tres veces por semana'] }, motivo: 'Plan inicial', versionBase: null };
    expect((await pedir(e.f, 'PUT', url(), e.tokens.enfermera, plan)).estado).toBe(403);
    expect((await pedir(e.f, 'PUT', url(), e.tokens.supervisorAjeno, plan)).estado).toBe(403);
    expect((await pedir(e.f, 'PUT', url(), e.tokens.supervisor, { ...plan, motivo: '' })).estado).toBe(400);
    const v1 = await pedir<{ version: number }>(e.f, 'PUT', url(), e.tokens.supervisor, plan);
    expect(v1.datos.version).toBe(1);
    const v2 = await pedir<{ version: number }>(e.f, 'PUT', url(), e.tokens.supervisor, { ...plan, motivo: 'Agrega jardín', versionBase: 1 });
    expect(v2.datos.version).toBe(2);
    const filas = await e.owner.query<{ version: number; autor_id: string; motivo: string }>('SELECT version, autor_id, motivo FROM plan_terapeutico WHERE persona_id = $1 ORDER BY version', [e.ids.persona]);
    expect(filas.rows.map((f) => [f.version, f.autor_id, f.motivo])).toEqual([
      [1, e.ids.supervisor, 'Plan inicial'],
      [2, e.ids.supervisor, 'Agrega jardín'],
    ]);
  });

  it('rechaza guardar sobre una versión desactualizada', async () => {
    const r = await pedir(e.f, 'PUT', url(), e.tokens.supervisor, { contenido: {}, motivo: 'Cambio viejo', versionBase: 1 });
    expect(r.estado).toBe(409);
  });

  it('la enfermera asignada lo lee; el familiar y el supervisor no asignado, no', async () => {
    expect((await pedir(e.f, 'GET', url(), e.tokens.enfermera)).estado).toBe(200);
    expect((await pedir(e.f, 'GET', url(), e.tokens.familiar)).estado).toBe(403);
    expect((await pedir(e.f, 'GET', url(), e.tokens.supervisorAjeno)).estado).toBe(403);
    expect((await pedir(e.f, 'GET', url(), e.tokens.admin)).estado).toBe(403);
  });

  it('los umbrales personales no pueden ser nivel 0', async () => {
    const r = await pedir(e.f, 'PUT', url(), e.tokens.supervisor, { contenido: { umbrales_alerta: [{ id: 'x', frase: 'algo', nivel: 0 }] }, motivo: 'Prueba', versionBase: 2 });
    expect(r.estado).toBe(400);
  });
});

describe('transcripciones y alertas', () => {
  let sesionId: string;
  beforeAll(async () => {
    sesionId = (await pedir<{ sesionId: string }>(e.f, 'POST', '/api/conversacion/sesiones', e.tokens.dispositivo, {})).datos.sesionId;
    await pedir(e.f, 'POST', `/api/conversacion/sesiones/${sesionId}/turnos`, e.tokens.dispositivo, { texto: 'Me llamaron del banco y me pidieron la clave' });
  });
  const url = () => `/api/personas/${e.ids.persona}/sesiones/${sesionId}/transcripcion`;

  it('la transcripción exige un motivo clínico y queda en la auditoría', async () => {
    expect((await pedir(e.f, 'GET', url(), e.tokens.supervisor)).estado).toBe(400);
    const motivo = 'Revisar contexto de la alerta de posible estafa';
    const r = await pedir<{ turnos: Array<{ hablante: string; texto: string }> }>(e.f, 'GET', `${url()}?motivo=${encodeURIComponent(motivo)}`, e.tokens.supervisor);
    expect(r.estado).toBe(200);
    expect(r.datos.turnos[0]).toMatchObject({ hablante: 'persona', texto: 'Me llamaron del banco y me pidieron la clave' });
    const a = await e.owner.query(`SELECT motivo FROM registro_auditoria WHERE accion = 'transcripcion.leer' AND recurso_id = $1`, [sesionId]);
    expect(a.rows).toEqual([{ motivo }]);
  });

  it('nadie más que el supervisor asignado abre la transcripción', async () => {
    const q = `?motivo=${encodeURIComponent('motivo suficientemente largo')}`;
    for (const t of [e.tokens.familiar, e.tokens.enfermera, e.tokens.guardia, e.tokens.admin, e.tokens.supervisorAjeno, e.tokens.dispositivo]) {
      expect((await pedir(e.f, 'GET', url() + q, t)).estado).toBe(403);
    }
  });

  it('la estafa aparece en la bandeja; el acuse queda registrado y no se repite', async () => {
    const lista = await pedir<{ alertas: Array<{ id: string; sesion_id: string; categorias: string[] }> }>(e.f, 'GET', '/api/alertas', e.tokens.enfermera);
    const alerta = lista.datos.alertas.find((a) => a.sesion_id === sesionId);
    expect(alerta?.categorias).toContain('estafa');
    expect((await pedir(e.f, 'GET', '/api/alertas', e.tokens.supervisorAjeno)).datos).toEqual({ alertas: [] });
    expect((await pedir(e.f, 'POST', `/api/alertas/${alerta!.id}/acuse`, e.tokens.supervisorAjeno, {})).estado).toBe(403);
    expect((await pedir(e.f, 'POST', `/api/alertas/${alerta!.id}/acuse`, e.tokens.familiar, {})).estado).toBe(403);

    const detalle = await pedir<{ fragmento: string }>(e.f, 'GET', `/api/alertas/${alerta!.id}`, e.tokens.enfermera);
    expect(detalle.datos.fragmento).toBe('Me llamaron del banco y me pidieron la clave');
    expect((await pedir(e.f, 'POST', `/api/alertas/${alerta!.id}/acuse`, e.tokens.enfermera, {})).estado).toBe(200);
    expect((await pedir(e.f, 'POST', `/api/alertas/${alerta!.id}/acuse`, e.tokens.supervisor, {})).estado).toBe(409);
  });
});
