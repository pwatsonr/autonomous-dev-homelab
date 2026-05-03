/**
 * Public barrel for the safety module. Re-exports the destructiveness
 * ladder, shared types, error classes, and the validator + gate entry
 * points. SPEC-002-2-01.
 */

export {
  type Destructiveness,
  type TrustLevel,
  FLOOR,
  TRUST_RANK,
  meetsFloor,
} from './destructiveness.js';

export type {
  Action,
  OperatorConfig,
  ApprovalResult,
  GateContext,
  SafetyAuditEvent,
} from './types.js';

export { ConfigurationError, ApprovalDeniedError, BackupRequiredError } from './errors.js';

export { validateOperatorConfig } from './validator.js';
export { gateApproval } from './gate.js';
