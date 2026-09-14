import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The deploy artifacts must carry what the code needs.
 *
 * Two production outages in one day, same shape — the code needed something and
 * the artifact that ships it did not carry it, with nothing failing until a real
 * deployment tried:
 *
 *  - `prisma/seed.ts` imports from `src/`, which the runtime image did not copy.
 *    `prisma db seed` died on "Cannot find module", which failed the whole start
 *    command and crash-looped the container. Every image built after 2026-09-04.
 *  - `SETTINGS_ENCRYPTION_KEY` was never passed to the container, so no SMTP
 *    password could be saved and no full backup could be written — on every
 *    deployment the framework has ever scaffolded.
 *
 * Neither is catchable by a unit test of the application. Both are catchable by
 * reading the Dockerfile and the compose fragment, which is what this does.
 */
describe('deploy artifacts', () => {
  const repo = join(__dirname, '..');
  const read = (p: string) => readFileSync(join(repo, p), 'utf8');

  describe('the production image ships what the seed imports', () => {
    const dockerfile = read('deploy/Dockerfile.prod');
    const seed = read('prisma/seed.ts');

    /** Top-level dirs the runtime stage copies out of the build stage. */
    const copied = new Set(
      [...dockerfile.matchAll(/COPY --from=build \/app\/([^\s/]+)/g)].map(
        (m) => m[1],
      ),
    );

    /** `../src/user/user-slug.util` -> `src`. Bare package imports are skipped:
     *  node_modules is copied wholesale. */
    const importedDirs = [
      ...seed.matchAll(/from\s+'(\.\.\/[^']+)'/g),
    ].map((m) => m[1].replace(/^\.\.\//, '').split('/')[0]);

    it('copies every directory the seed reaches into', () => {
      // The seed runs through ts-node at container start, so it needs SOURCE,
      // not just the compiled dist.
      expect(importedDirs.length).toBeGreaterThan(0);
      for (const dir of new Set(importedDirs)) {
        expect(copied.has(dir)).toBe(true);
      }
    });

    it('still copies the pieces prisma db seed itself needs', () => {
      for (const required of ['prisma', 'tsconfig.json', 'node_modules']) {
        expect(dockerfile).toContain(`/app/${required}`);
      }
    });
  });

  describe('compose passes the variables the backend cannot boot or work without', () => {
    const compose = read('deploy/compose.server.yml');
    const ecosystem = read('deploy/ecosystem.config.js.tmpl');

    // Each of these fails LATE and quietly if missing — at a sign-in, at a
    // settings save, at the first backup — rather than at boot. That is what
    // makes them worth pinning rather than trusting to review.
    const REQUIRED: [name: string, why: string][] = [
      ['DATABASE_URL', 'no database'],
      ['JWT_SECRET', 'the backend refuses to boot (security.config.ts)'],
      [
        'SETTINGS_ENCRYPTION_KEY',
        'the SMTP password cannot be stored and no full backup can be written',
      ],
      ['NODE_ENV', 'gates the Secure cookie and the enforced CORS allowlist'],
      ['ALLOWED_ORIGINS', 'browser requests are refused in production'],
      ['SOCKET_ALLOWED_ORIGINS', 'live updates silently fall back to polling'],
    ];

    it.each(REQUIRED)('compose.server.yml passes %s (else: %s)', (name) => {
      expect(compose).toContain(`${name}=`);
    });

    // The pm2 path renders the same configuration for a host runtime; a variable
    // present in one and absent from the other is the same bug, half-fixed.
    it.each(REQUIRED.filter(([n]) => n !== 'DATABASE_URL'))(
      'the pm2 ecosystem template passes %s too',
      (name) => {
        expect(ecosystem).toContain(name);
      },
    );

    it('never hard-codes a secret as a default', () => {
      // `${VAR:-}` (empty) is fine; `${VAR:-hunter2}` ships a working secret to
      // every deployment that forgets to set one.
      for (const secret of ['JWT_SECRET', 'SETTINGS_ENCRYPTION_KEY']) {
        const fallback = new RegExp(`\\$\\{${secret}:-(.+?)\\}`).exec(compose);
        if (fallback) expect(fallback[1]).toBe('');
      }
    });
  });
});
