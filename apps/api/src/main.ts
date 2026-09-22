import { Logger } from 'nestjs-pino';
import { SETUP_TOKEN } from './infrastructure/tokens.js';
import { SetupService } from '@ocso/application';
import { createApp } from './bootstrap.js';

const app = await createApp();
const port = Number(process.env['PORT'] ?? 4000);
await app.listen(port, '0.0.0.0');

const logger = app.get(Logger);
logger.log(`OCSO API listening on :${port}`);
// First run: surface the one-time setup token in the log (no CLI needed, ADR-010).
if (await app.get(SetupService).isSetupRequired()) {
  const token = app.get<string>(SETUP_TOKEN);
  logger.warn(`First-run setup required. Open /setup in the web UI and use setup token: ${token}`);
}
