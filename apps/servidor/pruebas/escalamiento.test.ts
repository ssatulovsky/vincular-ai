import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardiaDeTurno } from '../src/escalamiento/guardia.ts';
import { nombreCorto, textoLlamada, textoSms, tipoDeAviso } from '../src/escalamiento/mensajes.ts';
import { cicloEscalamiento, iniciarEscalamiento } from '../src/escalamiento/motor.ts';
import { elegirProtocolo } from '../src/escalamiento/protocolos.ts';
import { enmascarar, normalizarTelefono } from '../src/escalamiento/telefonos.ts';
import { firmaTwilio, firmaValida, twimlLlamada } from '../src/escalamiento/twilio.ts';
import { abrirSesion, insertarTurno } from '../src/conversacion/repositorio.ts';
import { crearEscenario, pedir, type Escenario } from './escenario.ts';

/**
 * Escalamiento. Twilio apunta a un puerto cerrado: los envíos fallan de verdad, y así se prueba
 * que la cadena no se queda esperando a quien no recibió nada. El acuse por SMS y por llamada se
 * prueba con los webhooks firmados como los firma Twilio.
 */
let e: Escenario;
let guardiaId: string;
const TEL = { camila: '+56911112222', guardia: '+56922223333', supervisor: '+56933334444', enfermera: '+56944445555' };
const motivo = 'Configuración inicial del piloto';

beforeAll(async () => {
  e = await crearEscenario();
  guardiaId = (await e.owner.query<{ id: string }>(`SELECT id FROM cuenta WHERE rol = 'guardia' ORDER BY creada_en DESC LIMIT 1`)).rows[0]!.id;
  for (const [id, t] of [
    [guardiaId, TEL.guardia],
    [e.ids.supervisor, TEL.supervisor],
    [e.ids.enfermera, TEL.enfermera],
  ] as const) {
    expect((await pedir(e.f, 'PUT', `/api/cuentas/${id}/telefono`, e.tokens.admin, { telefono: t })).estado).toBe(200);
  }
  // La escena crea a Camila (cuidadora) con teléfono, pero sin el hash (es anterior al Sprint 5).
  await e.owner.query('UPDATE contacto SET telefono_hash = $2 WHERE id = $1', [e.ids.contacto, e.app.escalamiento.hashes.hash(TEL.camila)]);
  const turno = await pedir(e.f, 'POST', '/api/guardia/turnos', e.tokens.admin, { turno: { nombre: 'Guardia 24/7', institucion: 'CESFAM', cuentaId: guardiaId }, motivo });
  expect(turno.estado).toBe(201);
});
afterAll(async () => e?.cerrar());

const notificaciones = async (escId: string) =>
  (
    await e.owner.query<{ paso: number; canal: string; estado: string; destinatario_contacto_id: string | null; destinatario_cuenta_id: string | null; turno_guardia_id: string | null; error: string | null }>(
      'SELECT paso, canal, estado, destinatario_contacto_id, destinatario_cuenta_id, turno_guardia_id, error FROM notificacion WHERE escalamiento_id = $1 ORDER BY paso, canal',
      [escId],
    )
  ).rows;

describe('textos y utilidades', () => {
  it('los avisos no llevan detalles clínicos y piden lo que hay que hacer', () => {
    const base = { nombre: 'Rosa Elena Muñoz', paraGuardia: false, emergencia: { samu: '131', prevencionSuicidio: '*4141' }, aceptaRespuesta: true };
    const emocional = textoSms({ ...base, tipo: tipoDeAviso('riesgo', 3, ['ideacion_suicida']) });
    expect(emocional).toContain('Rosa E.');
    expect(emocional).toContain('SAMU 131');
    expect(emocional).toContain('Responda 1');
    expect(emocional).not.toMatch(/suicid|ideaci|morir/i);
    expect(textoSms({ ...base, tipo: tipoDeAviso('riesgo', 3, ['dolor_toracico']) })).toContain('ayuda médica urgente');
    expect(textoSms({ ...base, tipo: 'dosis_sin_respuesta', hora: '08:00' })).toContain('sus remedios de las 08:00');
    expect(textoSms({ ...base, tipo: 'alerta', aceptaRespuesta: false })).not.toContain('Responda');
    expect(textoLlamada({ ...base, tipo: 'emergencia_medica' }, (n) => n.split('').join(' '))).toContain('SAMU, 1 3 1');
    expect(nombreCorto('Luis Soto')).toBe('Luis S.');
    expect(nombreCorto('María José Soto Pérez')).toBe('María S.');
  });

  it('teléfonos', () => {
    expect(normalizarTelefono('9 1111 2222')).toBe('+56911112222');
    expect(normalizarTelefono('+56 9 1111-2222')).toBe('+56911112222');
    expect(normalizarTelefono('56911112222')).toBe('+56911112222');
    expect(normalizarTelefono('1234')).toBeNull();
    expect(enmascarar('+56911112222')).toBe('+56 9 •••• 2222');
  });

  it('firma de Twilio y TwiML escapado', () => {
    const p = { From: '+56911112222', Body: '1' };
    const f = firmaTwilio('token', 'https://x.cl/webhooks/twilio/sms', p);
    expect(firmaValida('token', 'https://x.cl/webhooks/twilio/sms', p, f)).toBe(true);
    expect(firmaValida('token', 'https://x.cl/webhooks/twilio/sms', { ...p, Body: '2' }, f)).toBe(false);
    expect(firmaValida('otro', 'https://x.cl/webhooks/twilio/sms', p, f)).toBe(false);
    expect(firmaValida('token', 'https://x.cl/webhooks/twilio/sms', p, undefined)).toBe(false);
    const x = twimlLlamada({ texto: 'Rosa <&> "ok"', idioma: 'es-MX', urlRespuesta: 'https://x.cl/w?n=1&a=2' });
    expect(x).toContain('Rosa &lt;&amp;&gt; &quot;ok&quot;');
    expect(x).toContain('action="https://x.cl/w?n=1&amp;a=2"');
  });
});

describe('protocolos parametrizables', () => {
  it('validan lo mínimo: guardia en riesgo, primer paso rápido en emergencia, canales conocidos', async () => {
    const paso = { destino: 'cuidadores', canales: ['sms'], esperarAcuseMin: 30 };
    const malos = [
      { nombre: 'Sin guardia', tipoEvento: 'riesgo', nivel: 2, pasos: [paso] },
      { nombre: 'Lento', tipoEvento: 'riesgo', nivel: 3, pasos: [{ destino: 'guardia', canales: ['sms'], esperarAcuseMin: 20 }] },
      { nombre: 'Push', tipoEvento: 'dosis_sin_respuesta', pasos: [{ destino: 'guardia', canales: ['push'], esperarAcuseMin: 5 }] },
      { nombre: 'Media franja', tipoEvento: 'dosis_sin_respuesta', horaDesde: '22:00', pasos: [paso] },
    ];
    for (const p of malos) expect((await pedir(e.f, 'POST', '/api/protocolos-escalamiento', e.tokens.admin, { protocolo: p, motivo })).estado, p.nombre).toBe(400);
    for (const t of [e.tokens.enfermera, e.tokens.guardia, e.tokens.familiar, e.tokens.dispositivo]) {
      expect((await pedir(e.f, 'GET', '/api/protocolos-escalamiento', t)).estado).toBe(403);
    }
    expect((await pedir(e.f, 'GET', '/api/protocolos-escalamiento', e.tokens.supervisor)).estado).toBe(200);
  });

  it('gana el protocolo más específico que calza con la circunstancia (persona, categoría, horario)', async () => {
    const pasos = [{ destino: 'guardia', canales: ['sms'], esperarAcuseMin: 5 }];
    const crear = async (p: Record<string, unknown>) => (await pedir<{ id: string }>(e.f, 'POST', '/api/protocolos-escalamiento', e.tokens.supervisor, { protocolo: { tipoEvento: 'riesgo', nivel: 3, pasos, ...p }, motivo })).datos.id;
    await crear({ nombre: 'Noche', horaDesde: '22:00', horaHasta: '07:00' });
    await crear({ nombre: 'Rosa: médica', personaId: e.ids.persona, categoria: 'dolor_toracico' });
    const elegir = (categorias: string[], iso: string, personaId = e.ids.persona) => elegirProtocolo(e.app.bd, { tipoEvento: 'riesgo', nivel: 3, categorias, personaId, ahora: new Date(iso) });
    expect((await elegir(['dolor_toracico'], '2030-03-10T15:00:00Z'))!.nombre).toBe('Rosa: médica');
    // 23:30 en Chile (UTC−3) = 02:30 UTC del día siguiente.
    expect((await elegir(['ideacion_suicida'], '2030-03-11T02:30:00Z'))!.nombre).toBe('Noche');
    expect((await elegir(['ideacion_suicida'], '2030-03-10T15:00:00Z'))!.nombre).toBe('Emergencia (nivel 3)');
    expect((await elegir(['dolor_toracico'], '2030-03-10T15:00:00Z', e.ids.personaAjena))!.nombre).toBe('Emergencia (nivel 3)');
  });
});

describe('guardia parametrizable', () => {
  it('elige por día, hora, período, tipo de evento y prioridad', async () => {
    const crear = (turno: Record<string, unknown>) => pedir<{ id: string }>(e.f, 'POST', '/api/guardia/turnos', e.tokens.admin, { turno, motivo });
    await crear({ nombre: 'Fin de semana noche', telefono: '+56955556666', dias: [6, 7], horaDesde: '20:00', horaHasta: '08:00', prioridad: 10 });
    await crear({ nombre: 'Solo emergencias de marzo', telefono: '+56966667777', cubre: ['riesgo:3'], vigenteDesde: '2030-03-01', vigenteHasta: '2030-03-31', prioridad: 5 });
    expect((await crear({ nombre: 'Sin destino' })).estado).toBe(400);
    const turno = (iso: string, nivel = 3, tipo = 'riesgo') => guardiaDeTurno(e.app.bd, e.app.cifrador, { tipoEvento: tipo, nivel, ahora: new Date(iso), zona: 'America/Santiago' }).then((g) => g.map((x) => x.nombre));
    // Sábado 16-03-2030 23:00 en Chile.
    expect(await turno('2030-03-17T02:00:00Z')).toEqual(['Fin de semana noche']);
    // Martes 12-03-2030 15:00: la de marzo (prioridad 5) cubre emergencias; para dosis, la 24/7.
    expect(await turno('2030-03-12T18:00:00Z')).toEqual(['Solo emergencias de marzo']);
    expect(await turno('2030-03-12T18:00:00Z', 1, 'dosis_sin_respuesta')).toEqual(['Guardia 24/7']);
    expect(await turno('2030-04-09T18:00:00Z')).toEqual(['Guardia 24/7']);
    // Se desactivan los turnos de prueba para no afectar al resto del archivo.
    await e.owner.query(`UPDATE turno_guardia SET activo = false WHERE nombre <> 'Guardia 24/7'`);
  });
});

describe('cadena de escalamiento', () => {
  it('emergencia: guardia, cuidadores y equipo en orden; si nada llega, avanza hasta agotarse sin esperar', async () => {
    const id = (await iniciarEscalamiento(e.app.bd, { personaId: e.ids.personaAjena, tipoEvento: 'riesgo', nivel: 3, categorias: ['ideacion_suicida'], ahora: new Date() }))!;
    // Twilio no responde: cada mensaje se reintenta (3 intentos) y luego se da por fallido.
    let fallidas = 0;
    for (let i = 0; i < 12; i++) fallidas += (await cicloEscalamiento(e.app.escalamiento, new Date())).fallidas;
    expect(fallidas).toBeGreaterThan(0);
    const n = await notificaciones(id);
    // Paso 1: guardia por llamada y SMS. Luis no tiene cuidadores. Paso 3: su supervisor no tiene
    // teléfono, así que no hay a quién.
    expect(n.filter((x) => x.paso === 1).map((x) => x.canal).sort()).toEqual(['llamada', 'sms']);
    expect(n.filter((x) => x.paso === 1).every((x) => x.turno_guardia_id !== null)).toBe(true);
    expect(n.every((x) => x.estado === 'fallida' && x.error)).toBe(true);
    // Todo falló: la cadena no se quedó esperando acuses y se agotó.
    const esc = await e.owner.query('SELECT estado, paso_actual FROM escalamiento WHERE id = $1', [id]);
    expect(esc.rows[0]).toEqual({ estado: 'agotado', paso_actual: 5 });
    const a = await e.owner.query(`SELECT 1 FROM registro_auditoria WHERE accion = 'escalamiento.agotado' AND recurso_id = $1`, [id]);
    expect(a.rowCount).toBe(1);
  });

  it('en riesgo vital avisa a los cuidadores aunque no tengan permiso de alertas; en alerta, solo si lo tienen', async () => {
    const id3 = (await iniciarEscalamiento(e.app.bd, { personaId: e.ids.persona, tipoEvento: 'riesgo', nivel: 3, categorias: ['signos_acv'], ahora: new Date('2030-03-10T15:00:00Z') }))!;
    await cicloEscalamiento(e.app.escalamiento, new Date('2030-03-10T15:00:01Z'));
    expect((await notificaciones(id3)).some((x) => x.destinatario_contacto_id === e.ids.contacto)).toBe(true);
    await e.owner.query(`UPDATE escalamiento SET estado = 'cancelado' WHERE id = $1`, [id3]);

    const id2 = (await iniciarEscalamiento(e.app.bd, { personaId: e.ids.persona, tipoEvento: 'riesgo', nivel: 2, categorias: ['estafa'], ahora: new Date() }))!;
    await cicloEscalamiento(e.app.escalamiento, new Date());
    const n2 = await notificaciones(id2);
    expect(n2.some((x) => x.destinatario_contacto_id === e.ids.contacto)).toBe(false);
    expect(n2.some((x) => x.destinatario_cuenta_id === e.ids.enfermera)).toBe(true);
    await e.owner.query(`UPDATE escalamiento SET estado = 'cancelado' WHERE id = $1`, [id2]);
  });

  it('un evento de mayor nivel reemplaza la cadena en curso; uno de igual nivel se suma a ella', async () => {
    const a = (await iniciarEscalamiento(e.app.bd, { personaId: e.ids.personaAjena, tipoEvento: 'riesgo', nivel: 2, categorias: ['caida'], ahora: new Date() }))!;
    expect(await iniciarEscalamiento(e.app.bd, { personaId: e.ids.personaAjena, tipoEvento: 'riesgo', nivel: 2, categorias: ['estafa'], ahora: new Date() })).toBe(a);
    const b = (await iniciarEscalamiento(e.app.bd, { personaId: e.ids.personaAjena, tipoEvento: 'riesgo', nivel: 3, categorias: ['dolor_toracico'], ahora: new Date() }))!;
    expect(b).not.toBe(a);
    const r = await e.owner.query('SELECT id, estado FROM escalamiento WHERE id = ANY($1::uuid[]) ORDER BY creado_en', [[a, b]]);
    expect(r.rows.map((x) => x.estado)).toEqual(['cancelado', 'en_curso']);
    await e.owner.query(`UPDATE escalamiento SET estado = 'cancelado' WHERE id = $1`, [b]);
  });

  it('si la persona deja de responder durante la emergencia, la cadena se acelera y lo informa', async () => {
    const sesion = await abrirSesion(e.app.bd, e.ids.personaAjena, null, 'persona', 'texto');
    await insertarTurno(e.app.bd, e.app.cifrador, sesion, e.ids.personaAjena, 'persona', 'me duele el pecho', 'persona');
    const ev = await e.owner.query<{ id: string }>(
      `INSERT INTO evento_riesgo (persona_id, sesion_id, nivel, nivel_reglas, fuente, categorias, fragmento_cifrado, accion, acuse_requerido) VALUES ($1, $2, 3, 3, 'reglas', '{dolor_toracico}', '\\x00', 'prueba', true) RETURNING id`,
      [e.ids.personaAjena, sesion],
    );
    const id = (await iniciarEscalamiento(e.app.bd, { personaId: e.ids.personaAjena, tipoEvento: 'riesgo', nivel: 3, categorias: ['dolor_toracico'], eventoRiesgoId: ev.rows[0]!.id, ahora: new Date() }))!;
    await e.owner.query(`UPDATE escalamiento SET proximo_paso_en = now() + interval '1 hour' WHERE id = $1`, [id]);
    const r = await cicloEscalamiento(e.app.escalamiento, new Date(Date.now() + 11 * 60_000));
    expect(r.acelerados).toBe(1);
    const esc = await e.owner.query('SELECT detalle, paso_actual FROM escalamiento WHERE id = $1', [id]);
    expect(esc.rows[0].detalle.personaSinResponder).toBe(true);
    expect(esc.rows[0].paso_actual).toBeGreaterThan(0);
    await e.owner.query(`UPDATE escalamiento SET estado = 'cancelado' WHERE id = $1`, [id]);
  });
});

describe('acuse de recibo', () => {
  const firmar = (ruta: string, p: Record<string, string>) => firmaTwilio('token-de-prueba', `https://vincular.ejemplo.cl${ruta}`, p);
  const webhook = (ruta: string, p: Record<string, string>, firma = firmar(ruta, p)) =>
    e.f.inject({ method: 'POST', url: ruta, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': firma }, payload: new URLSearchParams(p).toString() });

  /** Cadena en curso con un SMS ya enviado a Camila (como si Twilio lo hubiera aceptado). */
  async function cadenaConSmsEnviado(): Promise<{ escId: string; eventoId: string; notifId: string }> {
    const ev = await e.owner.query<{ id: string }>(
      `INSERT INTO evento_riesgo (persona_id, nivel, nivel_reglas, fuente, categorias, fragmento_cifrado, accion, acuse_requerido) VALUES ($1, 3, 3, 'reglas', '{signos_acv}', '\\x00', 'prueba', true) RETURNING id`,
      [e.ids.persona],
    );
    const escId = (await iniciarEscalamiento(e.app.bd, { personaId: e.ids.persona, tipoEvento: 'riesgo', nivel: 3, categorias: ['signos_acv'], eventoRiesgoId: ev.rows[0]!.id, ahora: new Date() }))!;
    await e.owner.query(`UPDATE escalamiento SET paso_actual = 2, proximo_paso_en = now() + interval '5 minutes' WHERE id = $1`, [escId]);
    const n = await e.owner.query<{ id: string }>(
      `INSERT INTO notificacion (persona_id, tipo, destinatario_contacto_id, destino_telefono_cifrado, destino_telefono_hash, escalamiento_id, paso, canal, estado, proveedor_id)
       VALUES ($1, 'riesgo', $2, $3, $4, $5, 2, 'sms', 'enviada', 'SM-' || md5(random()::text)) RETURNING id`,
      [e.ids.persona, e.ids.contacto, e.app.cifrador.cifrar(TEL.camila), e.app.escalamiento.hashes.hash(TEL.camila), escId],
    );
    await e.owner.query(
      `INSERT INTO notificacion (persona_id, tipo, destinatario_cuenta_id, destino_telefono_cifrado, destino_telefono_hash, escalamiento_id, paso, canal)
       VALUES ($1, 'riesgo', $2, $3, $4, $5, 3, 'sms')`,
      [e.ids.persona, e.ids.supervisor, e.app.cifrador.cifrar(TEL.supervisor), e.app.escalamiento.hashes.hash(TEL.supervisor), escId],
    );
    return { escId, eventoId: ev.rows[0]!.id, notifId: n.rows[0]!.id };
  }

  it('un SMS con "1" de la cuidadora detiene la cadena y acusa el evento a su nombre', async () => {
    const c = await cadenaConSmsEnviado();
    expect((await webhook('/webhooks/twilio/sms', { From: TEL.camila, Body: 'Hola' })).body).not.toContain('Gracias');
    const r = await webhook('/webhooks/twilio/sms', { From: '+56 9 1111 2222', Body: ' 1 ' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/xml');
    expect(r.body).toContain('Quedó registrado');
    const esc = await e.owner.query('SELECT estado, acusado_via, acusado_por_contacto FROM escalamiento WHERE id = $1', [c.escId]);
    expect(esc.rows[0]).toEqual({ estado: 'acusado', acusado_via: 'sms', acusado_por_contacto: e.ids.contacto });
    const ev = await e.owner.query('SELECT acusado_en, acusado_por, acusado_por_contacto FROM evento_riesgo WHERE id = $1', [c.eventoId]);
    expect(ev.rows[0].acusado_en).not.toBeNull();
    expect(ev.rows[0].acusado_por_contacto).toBe(e.ids.contacto);
    // El mensaje pendiente del paso siguiente ya no sale.
    expect((await notificaciones(c.escId)).find((x) => x.paso === 3)?.estado).toBe('descartada');
  });

  it('rechaza webhooks sin firma válida', async () => {
    const c = await cadenaConSmsEnviado();
    expect((await webhook('/webhooks/twilio/sms', { From: TEL.camila, Body: '1' }, 'firma-falsa')).statusCode).toBe(403);
    const esc = await e.owner.query('SELECT estado FROM escalamiento WHERE id = $1', [c.escId]);
    expect(esc.rows[0].estado).toBe('en_curso');
    await e.owner.query(`UPDATE escalamiento SET estado = 'cancelado' WHERE id = $1`, [c.escId]);
  });

  it('presionar 1 en la llamada acusa la cadena', async () => {
    const c = await cadenaConSmsEnviado();
    const llamada = await e.owner.query<{ id: string }>(
      `INSERT INTO notificacion (persona_id, tipo, destinatario_cuenta_id, destino_telefono_cifrado, escalamiento_id, paso, canal, estado) VALUES ($1, 'riesgo', $2, $3, $4, 2, 'llamada', 'enviada') RETURNING id`,
      [e.ids.persona, guardiaId, e.app.cifrador.cifrar(TEL.guardia), c.escId],
    );
    const ruta = `/webhooks/twilio/llamada?n=${llamada.rows[0]!.id}`;
    const r = await webhook(ruta, { Digits: '1', CallSid: 'CA1' });
    expect(r.body).toContain('Quedó registrado');
    const esc = await e.owner.query('SELECT estado, acusado_via, acusado_por_cuenta FROM escalamiento WHERE id = $1', [c.escId]);
    expect(esc.rows[0]).toEqual({ estado: 'acusado', acusado_via: 'llamada', acusado_por_cuenta: guardiaId });
  });

  it('un SMS no entregado cuenta como falla y la cadena deja de esperar', async () => {
    const c = await cadenaConSmsEnviado();
    await e.owner.query(`UPDATE notificacion SET estado = 'fallida' WHERE escalamiento_id = $1 AND paso = 3`, [c.escId]);
    await e.owner.query(`UPDATE escalamiento SET paso_actual = 2 WHERE id = $1`, [c.escId]);
    const prov = (await e.owner.query<{ proveedor_id: string }>('SELECT proveedor_id FROM notificacion WHERE id = $1', [c.notifId])).rows[0]!.proveedor_id;
    expect((await webhook('/webhooks/twilio/estado', { MessageSid: prov, MessageStatus: 'undelivered' })).statusCode).toBe(204);
    expect((await notificaciones(c.escId)).find((x) => x.paso === 2)?.estado).toBe('fallida');
    await cicloEscalamiento(e.app.escalamiento, new Date());
    const esc = await e.owner.query<{ paso_actual: number }>('SELECT paso_actual FROM escalamiento WHERE id = $1', [c.escId]);
    expect(esc.rows[0]!.paso_actual).toBeGreaterThan(2);
    await e.owner.query(`UPDATE escalamiento SET estado = 'cancelado' WHERE id = $1`, [c.escId]);
  });
});

describe('de la conversación a la guardia', () => {
  it('una emergencia en la conversación inicia la cadena; la guardia la ve y la acusa desde el panel', async () => {
    const { sesionId } = (await pedir<{ sesionId: string }>(e.f, 'POST', '/api/conversacion/sesiones', e.tokens.dispositivo, {})).datos;
    await pedir(e.f, 'POST', `/api/conversacion/sesiones/${sesionId}/turnos`, e.tokens.dispositivo, { texto: 'No puedo mover el brazo derecho' });
    const esc = await e.owner.query<{ id: string; nivel: number; evento_riesgo_id: string }>(
      `SELECT e.id, e.nivel, e.evento_riesgo_id FROM escalamiento e JOIN evento_riesgo ev ON ev.id = e.evento_riesgo_id WHERE ev.sesion_id = $1`,
      [sesionId],
    );
    expect(esc.rows).toHaveLength(1);
    expect(esc.rows[0]!.nivel).toBe(3);
    const accion = await e.owner.query<{ accion: string }>('SELECT accion FROM evento_riesgo WHERE id = $1', [esc.rows[0]!.evento_riesgo_id]);
    expect(accion.rows[0]!.accion).toContain('guia_samu');
    expect(accion.rows[0]!.accion).toContain('escalamiento');

    const lista = await pedir<{ escalamientos: Array<{ id: string }> }>(e.f, 'GET', '/api/escalamientos', e.tokens.guardia);
    expect(lista.datos.escalamientos.some((x) => x.id === esc.rows[0]!.id)).toBe(true);
    expect((await pedir<{ escalamientos: unknown[] }>(e.f, 'GET', '/api/escalamientos', e.tokens.supervisorAjeno)).datos.escalamientos.some((x) => (x as { id: string }).id === esc.rows[0]!.id)).toBe(false);
    expect((await pedir(e.f, 'GET', '/api/escalamientos', e.tokens.admin)).estado).toBe(403);

    await cicloEscalamiento(e.app.escalamiento, new Date());
    const detalle = await pedir<{ notificaciones: Array<{ telefono: string; destino: string }> }>(e.f, 'GET', `/api/escalamientos/${esc.rows[0]!.id}`, e.tokens.guardia);
    expect(detalle.datos.notificaciones.length).toBeGreaterThan(0);
    expect(detalle.datos.notificaciones.every((x) => x.telefono.includes('••••'))).toBe(true);

    expect((await pedir(e.f, 'POST', `/api/escalamientos/${esc.rows[0]!.id}/acuse`, e.tokens.supervisorAjeno, {})).estado).toBe(403);
    expect((await pedir(e.f, 'POST', `/api/escalamientos/${esc.rows[0]!.id}/acuse`, e.tokens.guardia, {})).estado).toBe(200);
    expect((await pedir(e.f, 'POST', `/api/escalamientos/${esc.rows[0]!.id}/acuse`, e.tokens.guardia, {})).estado).toBe(409);
    const ev = await e.owner.query('SELECT acusado_por FROM evento_riesgo WHERE id = $1', [esc.rows[0]!.evento_riesgo_id]);
    expect(ev.rows[0].acusado_por).toBe(guardiaId);
  });
});

/**
 * Twilio real con credenciales de prueba (no envían ni cobran): VINCULAR_PRUEBA_TWILIO_REAL=1,
 * TWILIO_TEST_ACCOUNT_SID y TWILIO_TEST_AUTH_TOKEN. Usa los números mágicos de Twilio.
 */
describe.runIf(process.env.VINCULAR_PRUEBA_TWILIO_REAL === '1')('Twilio con credenciales de prueba', () => {
  it('acepta un SMS y una llamada', async () => {
    const { CanalTwilio } = await import('../src/escalamiento/twilio.ts');
    const canal = new CanalTwilio({ accountSid: process.env.TWILIO_TEST_ACCOUNT_SID!, authToken: process.env.TWILIO_TEST_AUTH_TOKEN!, origen: '+15005550006' });
    expect((await canal.enviarSms({ a: '+56911112222', texto: 'Prueba Vincular-IA' })).id).toMatch(/^SM/);
    expect((await canal.llamar({ a: '+56911112222', twiml: twimlLlamada({ texto: 'Prueba', idioma: 'es-MX' }) })).id).toMatch(/^CA/);
  }, 30_000);
});
