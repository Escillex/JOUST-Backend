/** Plain functions, no template engine: there are three messages and they are
 *  short. Every one includes the code in the SUBJECT as well as the body, so a
 *  phone notification is often enough without opening the mail. */

const wrap = (title: string, body: string) => ({
  subject: title,
  text: `${body}\n\n— JOUST`,
});

export function verificationEmail(code: string) {
  return wrap(
    `${code} is your JOUST verification code`,
    [
      'Welcome to JOUST.',
      '',
      `Your verification code is: ${code}`,
      '',
      'It expires in 15 minutes. If you did not create an account, you can ignore this email.',
    ].join('\n'),
  );
}

export function twoFactorEmail(code: string) {
  return wrap(
    `${code} is your JOUST sign-in code`,
    [
      `Your sign-in code is: ${code}`,
      '',
      'It expires in 10 minutes and can be used once.',
      '',
      'If you did not try to sign in, someone may know your password — change it.',
    ].join('\n'),
  );
}

export function testEmail() {
  return wrap(
    'JOUST test email',
    [
      'This is a test message from your JOUST installation.',
      '',
      'If you are reading it, mail delivery is configured correctly.',
    ].join('\n'),
  );
}
