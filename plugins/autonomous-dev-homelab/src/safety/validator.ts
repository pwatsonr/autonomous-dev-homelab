/**
 * `validateOperatorConfig` per SPEC-002-2-01.
 *
 * MUST be called at config-load time (daemon startup). Throws
 * `ConfigurationError` if any `auto_approval.<level>` value is missing
 * or below the FLOOR for that level. Re-validation mid-session is NOT
 * supported — restarting the daemon picks up new config. This is
 * intentional: operators MUST NOT be able to lower their floor by
 * editing the config file mid-session.
 */

import { FLOOR, meetsFloor, type Destructiveness } from './destructiveness.js';
import { ConfigurationError } from './errors.js';
import type { OperatorConfig } from './types.js';

/**
 * Throws `ConfigurationError` if any entry in `config.auto_approval` is
 * missing OR has a configured trust level that is more permissive than
 * the FLOOR for that destructiveness.
 */
export function validateOperatorConfig(config: OperatorConfig): void {
  const levels = Object.keys(FLOOR) as Destructiveness[];
  for (const level of levels) {
    const configured = config.auto_approval?.[level];
    if (configured === undefined || configured === null) {
      throw new ConfigurationError({
        destructiveness: level,
        configured: 'undefined',
        floor: FLOOR[level],
      });
    }
    if (!meetsFloor(configured, FLOOR[level])) {
      throw new ConfigurationError({
        destructiveness: level,
        configured,
        floor: FLOOR[level],
      });
    }
  }
}
