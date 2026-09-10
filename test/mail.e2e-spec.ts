import { MailService } from '../src/mail/mail.service';
import { ConsoleTransport } from '../src/mail/console.transport';

// The contract that matters: a send that fails must be REPORTED, not thrown and
// not swallowed. NotificationService swallows failures on purpose (a lost nudge
// is harmless); a lost 2FA code locks someone out, so the caller has to know.
describe('MailService', () => {
  const settingsWith = (values: Record<string, string | null>) =>
    ({ get: jest.fn(async (name: string) => values[name] ?? null) }) as any;

  it('sends through the console transport by default', async () => {
    const service = new MailService(settingsWith({ MAIL_TRANSPORT: 'console' }));
    const result = await service.send({ to: 'a@example.com', subject: 'Hi', text: 'body' });
    expect(result).toMatchObject({ delivered: true, transport: 'console' });
  });

  it('reports rather than throws when smtp is selected but unconfigured', async () => {
    const service = new MailService(settingsWith({ MAIL_TRANSPORT: 'smtp' }));
    const result = await service.send({ to: 'a@example.com', subject: 'Hi', text: 'body' });
    expect(result.delivered).toBe(false);
    expect(result.error).toMatch(/not configured/i);
  });

  it('reports rather than throws when the transport itself fails', async () => {
    const service = new MailService(settingsWith({ MAIL_TRANSPORT: 'console' }));
    jest
      .spyOn(ConsoleTransport.prototype, 'send')
      .mockRejectedValueOnce(new Error('relay refused'));
    const result = await service.send({ to: 'a@example.com', subject: 'Hi', text: 'body' });
    expect(result).toMatchObject({ delivered: false, error: 'relay refused' });
  });

  it('does not put the reply-to address in the from field', async () => {
    const spy = jest.spyOn(ConsoleTransport.prototype, 'send').mockResolvedValueOnce(undefined);
    const service = new MailService(
      settingsWith({
        MAIL_TRANSPORT: 'console',
        MAIL_FROM: 'JOUST <noreply@joust.test>',
        MAIL_REPLY_TO: 'support@joust.test',
      }),
    );
    await service.send({ to: 'a@example.com', subject: 'Hi', text: 'body' });
    expect(spy).toHaveBeenCalledWith(expect.anything(), 'JOUST <noreply@joust.test>', 'support@joust.test');
  });
});
