import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { MODULE_METADATA, PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants.js';
import { ACCESS_KEY } from '../../src/common/decorators.js';
import { FEATURE_MODULES } from '../../src/app.module.js';

type Ctor = new (...args: never[]) => unknown;

function controllersOf(modules: readonly Ctor[]): Ctor[] {
  return modules.flatMap((m) => (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, m) as Ctor[] | undefined) ?? []);
}

/**
 * Deny-by-default coverage (T1.5.4): every HTTP route must declare exactly one
 * access rule. A new route without @Public/@Authenticated/@RequirePermission
 * fails this test before it can ship.
 */
describe('route access coverage', () => {
  const controllers = controllersOf(FEATURE_MODULES as unknown as Ctor[]);

  it('finds controllers', () => {
    expect(controllers.length).toBeGreaterThan(0);
  });

  it('every route declares an access rule', () => {
    const missing: string[] = [];
    for (const controller of controllers) {
      const proto = controller.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const isRoute = Reflect.hasMetadata(PATH_METADATA, handler) && Reflect.hasMetadata(METHOD_METADATA, handler);
        if (!isRoute) continue;
        const rule = Reflect.getMetadata(ACCESS_KEY, handler) ?? Reflect.getMetadata(ACCESS_KEY, controller);
        if (!rule) missing.push(`${controller.name}.${name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
