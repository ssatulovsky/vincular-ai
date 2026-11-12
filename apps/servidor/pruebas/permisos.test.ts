import { describe, expect, it } from 'vitest';
import { decidirPermiso, type Accion, type Actor, type Contexto } from '../src/seguridad/permisos.ts';

const P = 'persona-1';
const OTRA = 'persona-2';
const asignado: Contexto = { asignado: true, esSuContacto: false, permisosContacto: {} };
const noAsignado: Contexto = { asignado: false, esSuContacto: false, permisosContacto: {} };

const personal = (rol: Extract<Actor, { tipo: 'personal' }>['rol']): Actor => ({ tipo: 'personal', id: 'c', rol, nombre: 'x' });
const familiar: Actor = { tipo: 'familiar', id: 'f', contactoId: 'k', personaId: P, nombre: 'Camila' };
const tablet: Actor = { tipo: 'dispositivo', id: 'd', personaId: P };

const TODAS: Accion[] = [
  'cuenta.crear', 'persona.crear', 'persona.ver_ficha', 'dispositivo.crear', 'asignacion.gestionar', 'perfil_companero.editar',
  'plan.leer', 'plan.editar', 'alertas.leer', 'alertas.acusar', 'transcripcion.leer', 'resumen_bienestar.leer', 'conversacion.usar',
  'memoria.propia', 'memoria.ver', 'costos.ver',
];

describe('permisos', () => {
  it('un familiar NUNCA ve transcripciones, planes ni alertas, aunque tenga todos los permisos', () => {
    const ctx: Contexto = { asignado: true, esSuContacto: true, permisosContacto: { resumen_bienestar: true, transcripciones: true, todo: true } };
    for (const a of TODAS.filter((x) => x !== 'resumen_bienestar.leer')) expect(decidirPermiso(familiar, a, P, ctx), a).toBe(false);
  });

  it('un familiar ve el resumen de bienestar solo si la persona lo autorizó', () => {
    expect(decidirPermiso(familiar, 'resumen_bienestar.leer', P, { asignado: false, esSuContacto: true, permisosContacto: { resumen_bienestar: true } })).toBe(true);
    expect(decidirPermiso(familiar, 'resumen_bienestar.leer', P, { asignado: false, esSuContacto: true, permisosContacto: {} })).toBe(false);
    expect(decidirPermiso(familiar, 'resumen_bienestar.leer', P, { asignado: false, esSuContacto: true, permisosContacto: { resumen_bienestar: 'si' } })).toBe(false);
  });

  it('un familiar no ve nada de otra persona', () => {
    expect(decidirPermiso(familiar, 'resumen_bienestar.leer', OTRA, { asignado: false, esSuContacto: true, permisosContacto: { resumen_bienestar: true } })).toBe(false);
  });

  it('la tablet conversa, maneja su memoria y su compañero, y nada más; solo como su propia persona', () => {
    const propias: Accion[] = ['conversacion.usar', 'memoria.propia', 'perfil_companero.editar'];
    for (const a of TODAS) expect(decidirPermiso(tablet, a, P, asignado), a).toBe(propias.includes(a));
    for (const a of propias) expect(decidirPermiso(tablet, a, OTRA, asignado), a).toBe(false);
  });

  it('la memoria la ven los clínicos asignados, nunca el familiar, la guardia ni el administrador', () => {
    expect(decidirPermiso(personal('supervisor_clinico'), 'memoria.ver', P, asignado)).toBe(true);
    expect(decidirPermiso(personal('enfermera_enlace'), 'memoria.ver', P, asignado)).toBe(true);
    expect(decidirPermiso(personal('supervisor_clinico'), 'memoria.ver', P, noAsignado)).toBe(false);
    expect(decidirPermiso(personal('guardia'), 'memoria.ver', P, asignado)).toBe(false);
    expect(decidirPermiso(personal('admin_plataforma'), 'memoria.ver', P, asignado)).toBe(false);
    expect(decidirPermiso(familiar, 'memoria.ver', P, { asignado: true, esSuContacto: true, permisosContacto: { resumen_bienestar: true } })).toBe(false);
  });

  it('solo el administrador ve los costos', () => {
    expect(decidirPermiso(personal('admin_plataforma'), 'costos.ver', null, noAsignado)).toBe(true);
    for (const rol of ['supervisor_clinico', 'enfermera_enlace', 'gerontologo', 'guardia'] as const) expect(decidirPermiso(personal(rol), 'costos.ver', null, asignado)).toBe(false);
  });

  it('el administrador gestiona altas pero nunca contenido clínico', () => {
    const admin = personal('admin_plataforma');
    for (const a of ['cuenta.crear', 'persona.crear', 'dispositivo.crear', 'asignacion.gestionar', 'perfil_companero.editar'] as Accion[]) expect(decidirPermiso(admin, a, P, noAsignado), a).toBe(true);
    for (const a of ['plan.leer', 'plan.editar', 'alertas.leer', 'transcripcion.leer', 'persona.ver_ficha'] as Accion[]) expect(decidirPermiso(admin, a, P, asignado), a).toBe(false);
  });

  it('solo el supervisor asignado edita el plan y abre transcripciones', () => {
    for (const a of ['plan.editar', 'transcripcion.leer'] as Accion[]) {
      expect(decidirPermiso(personal('supervisor_clinico'), a, P, asignado)).toBe(true);
      expect(decidirPermiso(personal('supervisor_clinico'), a, P, noAsignado)).toBe(false);
      expect(decidirPermiso(personal('enfermera_enlace'), a, P, asignado)).toBe(false);
      expect(decidirPermiso(personal('gerontologo'), a, P, asignado)).toBe(false);
      expect(decidirPermiso(personal('guardia'), a, P, asignado)).toBe(false);
    }
  });

  it('los clínicos asignados leen el plan y las alertas; los no asignados, no', () => {
    for (const rol of ['supervisor_clinico', 'enfermera_enlace', 'gerontologo'] as const) {
      expect(decidirPermiso(personal(rol), 'plan.leer', P, asignado)).toBe(true);
      expect(decidirPermiso(personal(rol), 'alertas.acusar', P, asignado)).toBe(true);
      expect(decidirPermiso(personal(rol), 'plan.leer', P, noAsignado)).toBe(false);
      expect(decidirPermiso(personal(rol), 'alertas.leer', P, noAsignado)).toBe(false);
    }
  });

  it('la guardia ve y acusa alertas de cualquier persona, pero no planes ni transcripciones', () => {
    const g = personal('guardia');
    expect(decidirPermiso(g, 'alertas.leer', P, noAsignado)).toBe(true);
    expect(decidirPermiso(g, 'alertas.acusar', P, noAsignado)).toBe(true);
    expect(decidirPermiso(g, 'plan.leer', P, noAsignado)).toBe(false);
    expect(decidirPermiso(g, 'transcripcion.leer', P, noAsignado)).toBe(false);
  });

  it('nadie del personal conversa como la persona', () => {
    for (const rol of ['supervisor_clinico', 'enfermera_enlace', 'gerontologo', 'guardia', 'admin_plataforma'] as const) {
      expect(decidirPermiso(personal(rol), 'conversacion.usar', P, asignado)).toBe(false);
    }
  });
});
