import 'reflect-metadata';
import { lastValueFrom, of, throwError } from 'rxjs';
import { AuditCategory } from '@prisma/client';
import { AUDIT_KEY, AuditSpec } from '../src/audit/audit.decorator';
import { AuditService } from '../src/audit/audit.service';
import { AuditInterceptor } from '../src/audit/audit.interceptor';
import { TournamentController } from '../src/tournament/tournament.controller';
import { ParticipantController } from '../src/tournament/participant/participant.controller';
import { MatchController } from '../src/tournament/match/match.controller';
import { OrganizerController } from '../src/organizer/organizer.controller';
import { InvitationController } from '../src/organizer/invitation.controller';
import { AuthController } from '../src/auth/auth.controller';
import { DevController } from '../src/dev/dev.controller';
import { GameController } from '../src/game/game.controller';
import { TournamentFormatController } from '../src/tournament-format/tournament-format.controller';
import { StoreController } from '../src/store/store.controller';
import { AwardCatalogController, AwardGrantController } from '../src/award/award.controller';
import { SettingsController } from '../src/settings/settings.controller';
import { BackupController } from '../src/backup/backup.controller';

/**
 * The audit log is only worth having if it is complete and if it never leaks.
 * The first block fails the build when a write route lands without @Audit; the
 * rest pin the privacy and reliability rules.
 */

const METHOD_KEY = 'method'; // Nest's RequestMethod metadata on a route handler
const WRITE = new Set([1, 2, 3, 4]); // POST, PUT, DELETE, PATCH

/** Write routes that are deliberately NOT audited, each with its reason. */
const EXEMPT: Record<string, string> = {
  'AuthController.signup': 'self-service registration',
  'AuthController.signin': 'sign-in, not an organizer action',
  'AuthController.submitCode': 'sign-in step',
  'AuthController.submitRecovery': 'sign-in step',
  'AuthController.resendCode': 'sign-in step',
  'AuthController.signInWithGoogle': 'sign-in',
  'AuthController.linkGoogle': "a user managing their own account",
  'AuthController.unlinkGoogle': "a user managing their own account",
  'AuthController.updateMe': "a user editing their own profile",
};

describe('audit coverage', () => {
  const controllers = [
    TournamentController, ParticipantController, MatchController, OrganizerController,
    InvitationController, AuthController, DevController, GameController,
    TournamentFormatController, StoreController, AwardCatalogController, AwardGrantController,
    SettingsController, BackupController,
  ];

  for (const ctrl of controllers) {
    const proto = ctrl.prototype as Record<string, unknown>;
    const writes = Object.getOwnPropertyNames(proto).filter((name) => {
      const fn = proto[name];
      return typeof fn === 'function' && WRITE.has(Reflect.getMetadata(METHOD_KEY, fn as object));
    });
    it.each(writes)(`${ctrl.name}.%s is audited or explicitly exempt`, (name) => {
      const key = `${ctrl.name}.${name}`;
      const spec = Reflect.getMetadata(AUDIT_KEY, proto[name] as object) as AuditSpec | undefined;
      if (EXEMPT[key]) {
        expect(spec).toBeUndefined();
      } else {
        expect(spec).toBeDefined();
        expect(spec!.action).toMatch(/^[a-z]+\.[a-z_]+$/);
      }
    });
  }
});

function build() {
  const prisma: any = {
    user: { findUnique: jest.fn(async ({ where }: any) => ({ username: `u-${where.id}`, displayName: `Name ${where.id}` })) },
    tournament: { findUnique: jest.fn(async () => ({ name: 'Winter Open' })) },
    match: { findUnique: jest.fn() },
    tournamentOrganizer: { findUnique: jest.fn() },
    award: { findUnique: jest.fn(async () => ({ name: 'Top Ten' })) },
    auditLog: { create: jest.fn(async () => ({})) },
  };
  return { prisma, audit: new AuditService(prisma) };
}
const actor = { id: 'admin-1', username: 'admin', roles: ['ADMIN'] };

describe('what gets written', () => {
  it('stores only whitelisted fields — never a password', async () => {
    const { prisma, audit } = build();
    const spec: AuditSpec = {
      action: 'user.create', category: AuditCategory.USER, pick: ['username'],
      describe: (c) => `Created @${String(c.body.username)}`,
    };
    const body = { username: 'newbie', password: 'hunter22-secret', email: 'x@y.z' };
    const prepared = await audit.prepare(spec, actor, {}, body);
    await audit.commit(spec, actor, prepared, {}, body, {});
    const row = prisma.auditLog.create.mock.calls[0][0].data;
    expect(row.metadata).toEqual({ username: 'newbie' });
    expect(JSON.stringify(row)).not.toContain('hunter22');
    expect(JSON.stringify(row)).not.toContain('x@y.z');
  });

  it("records a secret setting's name but never its value", async () => {
    const { prisma, audit } = build();
    const spec = Reflect.getMetadata(AUDIT_KEY, SettingsController.prototype.update) as AuditSpec;
    const body = { name: 'MAIL_PASS', value: 'xsmtpsib-real-key' };
    await audit.commit(spec, actor, await audit.prepare(spec, actor, {}, body), {}, body, {});
    const row = prisma.auditLog.create.mock.calls[0][0].data;
    expect(JSON.stringify(row)).not.toContain('xsmtpsib-real-key');
    expect(row.summary).toMatch(/MAIL_PASS.*not recorded/);

    // ...while an ordinary setting keeps its value, which is the useful part.
    const plain = { name: 'BACKUP_ALLOW_RESTORE', value: 'true' };
    await audit.commit(spec, actor, await audit.prepare(spec, actor, {}, plain), {}, plain, {});
    expect(prisma.auditLog.create.mock.calls[1][0].data.summary).toBe('Changed BACKUP_ALLOW_RESTORE to "true"');
  });

  it('names what it deleted, because names are resolved before the action', async () => {
    const { prisma, audit } = build();
    const spec = Reflect.getMetadata(AUDIT_KEY, DevController.prototype.deleteTournament) as AuditSpec;
    const prepared = await audit.prepare(spec, actor, { id: 't-1' }, {});
    prisma.tournament.findUnique.mockResolvedValue(null); // gone after the handler ran
    await audit.commit(spec, actor, prepared, { id: 't-1' }, {}, {});
    const row = prisma.auditLog.create.mock.calls[0][0].data;
    expect(row.summary).toBe('Deleted tournament "Winter Open"');
    expect(row).toMatchObject({ tournamentId: 't-1', tournamentName: 'Winter Open', actorName: 'Name admin-1' });
  });

  it('says "joined" when a player adds themselves, "added X" when staff do', async () => {
    const { prisma, audit } = build();
    const spec = Reflect.getMetadata(AUDIT_KEY, ParticipantController.prototype.join) as AuditSpec;
    const self = { userId: 'admin-1' };
    await audit.commit(spec, actor, await audit.prepare(spec, actor, { tournamentId: 't' }, self), {}, self, {});
    const other = { userId: 'p-9' };
    await audit.commit(spec, actor, await audit.prepare(spec, actor, { tournamentId: 't' }, other), {}, other, {});
    expect(prisma.auditLog.create.mock.calls[0][0].data.summary).toBe('Joined "Winter Open"');
    expect(prisma.auditLog.create.mock.calls[1][0].data.summary).toBe('Added Name p-9 to "Winter Open"');
  });

  it('never throws — a failed audit write must not fail the action', async () => {
    const { prisma, audit } = build();
    prisma.auditLog.create.mockRejectedValue(new Error('db down'));
    prisma.user.findUnique.mockRejectedValue(new Error('db down'));
    const spec: AuditSpec = { action: 'x.y', category: AuditCategory.SYSTEM, describe: () => 'x' };
    const prepared = await audit.prepare(spec, actor, {}, {});
    await expect(audit.commit(spec, actor, prepared, {}, {}, {})).resolves.toBeUndefined();
  });
});

describe('the interceptor', () => {
  const spec: AuditSpec = { action: 'tournament.start', category: AuditCategory.TOURNAMENT, describe: () => 'Started' };
  const ctx = (user: unknown) => ({
    getHandler: () => ({}),
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ user, params: {}, body: {} }) }),
  }) as any;
  const make = () => {
    const audit = { prepare: jest.fn(async () => ({})), commit: jest.fn(async () => undefined) };
    const reflector = { get: jest.fn(() => spec) };
    return { audit, interceptor: new AuditInterceptor(reflector as any, audit as any) };
  };

  it('records after the action succeeds', async () => {
    const { audit, interceptor } = make();
    await lastValueFrom(interceptor.intercept(ctx(actor), { handle: () => of({ ok: true }) }));
    expect(audit.commit).toHaveBeenCalledTimes(1);
  });

  it('records nothing when the action fails — the log is of what happened', async () => {
    const { audit, interceptor } = make();
    await expect(
      lastValueFrom(interceptor.intercept(ctx(actor), { handle: () => throwError(() => new Error('refused')) })),
    ).rejects.toThrow('refused');
    expect(audit.commit).not.toHaveBeenCalled();
  });

  it('skips unauthenticated requests — there is no one to attribute them to', async () => {
    const { audit, interceptor } = make();
    await lastValueFrom(interceptor.intercept(ctx(undefined), { handle: () => of(1) }));
    expect(audit.prepare).not.toHaveBeenCalled();
  });
});
