import { en } from '@elysium/i18n/locales/sections/staff.en';

import { registerSection } from './catalogue.js';

/**
 * Staff activity (M57, D-607's pattern): the team table, a person's page, their timeline, the
 * mistakes and the settings. Imported for its effect by those screens, so the strings travel in
 * their lazy chunks rather than in the first download. Registering twice is harmless.
 */
registerSection({ en });
