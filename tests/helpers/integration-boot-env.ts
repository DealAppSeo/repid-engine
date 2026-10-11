/**
 * jest `setupFiles` entry for jest.integration.config.js — runs in each test file's sandbox,
 * before the file is loaded, so `src/config.ts` (imported transitively by most integration
 * suites) finds a URL and a key and boots instead of throwing. See `applyIntegrationBootEnv`
 * in ./run-integration.ts for why, and for what it deliberately does NOT enable.
 *
 * Must run AFTER `dotenv/config` (jest.integration.config.js pins the order): a developer's
 * real `.env` credentials have to land first, or they would be shadowed by the placeholders.
 */
import { applyIntegrationBootEnv } from './run-integration';

applyIntegrationBootEnv();
