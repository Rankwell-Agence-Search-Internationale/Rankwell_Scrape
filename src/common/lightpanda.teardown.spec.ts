import { ConfigService } from '@nestjs/config';
import { LightpandaService } from './lightpanda.service';

/**
 * The guard is a process-level listener installed once by the service, so the
 * test drives it the way playwright-extra does: reject a detached promise and
 * assert the process is not taken down for a teardown race, but still is for
 * a real bug.
 */
describe('browser teardown guard', () => {
  const emit = (reason: unknown) =>
    (process.listeners('unhandledRejection') as any[])
      .map(fn => {
        try {
          fn(reason, Promise.resolve());
          return null;
        } catch (e) {
          return e;
        }
      })
      .find(e => e !== null) ?? null;

  let before: number;

  beforeAll(() => {
    before = process.listeners('unhandledRejection').length;
    const config = { get: (_k: string, d?: string) => d } as unknown as ConfigService;
    new LightpandaService(config);
    new LightpandaService(config); // second instance must not add a second listener
  });

  it('installs exactly one listener however many services are constructed', () => {
    expect(process.listeners('unhandledRejection').length).toBe(before + 1);
  });

  it.each([
    'cdpSession.send: Target page, context or browser has been closed',
    'Target page, context or browser has been closed',
    'Target browser has been closed',
  ])('swallows the teardown race: %s', message => {
    expect(emit(new Error(message))).toBeNull();
  });

  it('still rethrows an unrelated rejection', () => {
    const real = new Error('Cannot read properties of undefined (reading id)');
    expect(emit(real)).toBe(real);
  });

  it('handles a non-Error rejection without crashing on .message', () => {
    expect(emit('Target page, context or browser has been closed')).toBeNull();
  });
});
