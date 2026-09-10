import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { SettingsModule } from '../settings/settings.module';

/** Global for convenience, but consumers import it explicitly too — see the note
 *  in SettingsModule about compiling a module in isolation. */
@Global()
@Module({
  imports: [SettingsModule],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
