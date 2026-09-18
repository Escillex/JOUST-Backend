import { ForbiddenException } from '@nestjs/common';
import { BackupService } from './backup.service';

/**
 * The reset is the one action in the application that destroys data outright
 * rather than replacing it with other data, so what matters is what it refuses
 * and what it spares — not that TRUNCATE works.
 *
 * Driven through a fake `psql`, which is also the only honest way to assert the
 * keep-list: the real thing would need a database to empty.
 */

const ALL_TABLES = [
  'AuditLog',
  'Award',
  'ContentReport',
  'GalleryImage',
  'Game',
  'HomeBlock',
  'Match',
  'Notification',
  'Round',
  'SiteAsset',
  'StoreProduct',
  'SystemSetting',
  'Tournament',
  'TournamentFormat',
  'TournamentParticipant',
  'User',
  'UserGlobalStats',
  '_prisma_migrations',
].join('\n');

function build(opts: { allowRestore?: boolean } = {}) {
  const statements: string[] = [];

  const service = new BackupService(
    { systemSetting: { findMany: jest.fn().mockResolvedValue([]) } } as any,
    {
      getBoolean: jest.fn().mockResolvedValue(opts.allowRestore ?? true),
      getNumber: jest.fn().mockResolvedValue(14),
      get: jest.fn().mockResolvedValue(null),
      clearCache: jest.fn(),
    } as any,
  );

  // Stub the process boundaries: this spec is about the decisions, not pg.
  (service as any).psql = jest.fn(async (_url: string, sql: string) => {
    statements.push(sql);
    return sql.includes('pg_tables') ? ALL_TABLES : '';
  });
  (service as any).databaseUrl = () =>
    'postgres://user:pw@localhost:5432/joust';
  (service as any).databaseName = () => 'joust';
  jest
    .spyOn(service, 'create')
    .mockResolvedValue({ name: 'joust-safety.joustql' } as any);

  return { service, statements };
}

const truncateOf = (statements: string[]) =>
  statements.find((s) => s.startsWith('TRUNCATE')) ?? '';

describe('BackupService.resetData', () => {
  it('refuses when restoring is switched off', async () => {
    // A reset is as destructive as a restore, so it answers to the same switch
    // rather than inventing a second one somebody has to know about.
    const { service } = build({ allowRestore: false });
    await expect(
      service.resetData({ scope: 'content', callerId: 'admin-1' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('takes a safety copy before emptying anything', async () => {
    const { service } = build();
    const spy = jest.spyOn(service, 'create');
    await service.resetData({ scope: 'content', callerId: 'admin-1' });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'pre-restore' }),
    );
  });

  it('spares the catalogues a content reset should not make you rebuild', async () => {
    const { service, statements } = build();
    await service.resetData({ scope: 'content', callerId: 'admin-1' });
    const truncate = truncateOf(statements);

    for (const kept of [
      'User',
      'Game',
      'TournamentFormat',
      'Award',
      'StoreProduct',
      'SystemSetting',
      'HomeBlock',
      '_prisma_migrations',
    ]) {
      expect(truncate).not.toContain(`"public"."${kept}"`);
    }
    for (const cleared of ['Tournament', 'Match', 'Round', 'UserGlobalStats']) {
      expect(truncate).toContain(`"public"."${cleared}"`);
    }
  });

  it('clears the catalogues too when asked for everything', async () => {
    const { service, statements } = build();
    await service.resetData({ scope: 'everything', callerId: 'admin-1' });
    const truncate = truncateOf(statements);

    for (const cleared of [
      'Game',
      'Award',
      'StoreProduct',
      'TournamentFormat',
    ]) {
      expect(truncate).toContain(`"public"."${cleared}"`);
    }
    // Still never these: the server has to keep running afterwards.
    expect(truncate).not.toContain('"public"."SystemSetting"');
    expect(truncate).not.toContain('"public"."_prisma_migrations"');
  });

  it('never deletes the administrator who asked', async () => {
    const { service, statements } = build();
    await service.resetData({ scope: 'everything', callerId: 'admin-1' });

    // "User" is held out of the TRUNCATE for exactly this reason: an admin who
    // empties the database must still be able to sign in afterwards.
    expect(truncateOf(statements)).not.toContain('"public"."User"');
    const del =
      statements.find((s) => s.startsWith('DELETE FROM "User"')) ?? '';
    expect(del).toContain(`"id" <> 'admin-1'`);
  });

  it('leaves accounts alone on a content reset', async () => {
    const { service, statements } = build();
    await service.resetData({ scope: 'content', callerId: 'admin-1' });
    expect(statements.some((s) => s.startsWith('DELETE FROM "User"'))).toBe(
      false,
    );
  });

  it('empties in one transactional statement, not table by table', async () => {
    // A half-emptied database is worse than a failed reset, and TRUNCATE is
    // transactional only if it is one statement.
    const { service, statements } = build();
    await service.resetData({ scope: 'content', callerId: 'admin-1' });
    expect(statements.filter((s) => s.startsWith('TRUNCATE'))).toHaveLength(1);
    expect(truncateOf(statements)).toMatch(/RESTART IDENTITY CASCADE;$/);
  });

  it('discovers tables instead of carrying a hardcoded list', async () => {
    const { service, statements } = build();
    await service.resetData({ scope: 'content', callerId: 'admin-1' });
    // A table added next month must be emptied without anyone remembering to
    // add it here.
    expect(statements[0]).toContain('pg_tables');
  });
});
