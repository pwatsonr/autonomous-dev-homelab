/**
 * Kubernetes / K3s enumerator stub — issue #27.
 *
 * TODO(#27): Implement enumeration of deployments and pods from the
 * Kubernetes API (`kubectl get deployments -o json`,
 * `kubectl get pods -o json`). Map each Deployment to a `service` entity
 * and each Pod to a `container` entity with a `runs-on` edge to its node.
 *
 * Until implemented, returns empty results so the registry is complete
 * and the DeepEnumerator can handle this platform kind without crashing.
 */

import type { PlatformEnumerator, EnumerationContext, EnumerationResult } from '../enumerator.js';

/**
 * Stub enumerator for Kubernetes / K3s platforms.
 * Returns empty entities and edges until issue #27 K3s work is done.
 */
export class K3sEnumerator implements PlatformEnumerator {
  readonly platformKind = 'kubernetes';

  /**
   * Stub: returns empty result. See TODO above.
   *
   * @param _ctx - Unused until implemented.
   * @returns Empty entities and edges.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async enumerate(_ctx: EnumerationContext): Promise<EnumerationResult> {
    return { entities: [], edges: [] };
  }
}
