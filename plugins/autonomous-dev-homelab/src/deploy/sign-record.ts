/**
 * `signDeploymentRecord` / `verifyDeploymentRecord` — homelab-local mirror
 * of autonomous-dev SPEC-023-1-01's record-signing helpers.
 *
 * Reuses the `safety/hmac.ts` HMAC-SHA256 + canonical JSON pipeline so the
 * deploy records share the same secret (`HOMELAB_HMAC_SECRET`) as the rest
 * of the homelab plugin's signed state.
 */

import { signPayload, verifyPayload } from '../safety/hmac.js';
import type { DeploymentRecord, DeploymentRecordPayload } from './types.js';

export function signDeploymentRecord(
  payload: DeploymentRecordPayload,
): DeploymentRecord {
  const signed = signPayload(payload);
  return { payload: signed.payload, hmac: signed.hmac };
}

export function verifyDeploymentRecord(record: DeploymentRecord): boolean {
  return verifyPayload({ payload: record.payload, hmac: record.hmac });
}
