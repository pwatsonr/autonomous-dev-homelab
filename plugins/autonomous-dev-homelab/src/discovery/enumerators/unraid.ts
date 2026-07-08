/**
 * Unraid enumerator stub — issue #27.
 *
 * TODO(#27): Implement enumeration of Unraid Docker containers and VMs.
 * Unraid exposes these via the Unraid API or by running `docker ps` /
 * `virsh list` over SSH on the Unraid host. Map each running container
 * to a `container` entity and each VM to a `container` (or dedicated
 * `vm`) entity with a `runs-on` edge to the Unraid node entity.
 *
 * Until implemented, returns empty results so the registry is complete
 * and the DeepEnumerator can handle this platform kind without crashing.
 */

import type { PlatformEnumerator, EnumerationContext, EnumerationResult } from '../enumerator.js';

/**
 * Stub enumerator for Unraid platforms.
 * Returns empty entities and edges until issue #27 Unraid work is done.
 */
export class UnraidEnumerator implements PlatformEnumerator {
  readonly platformKind = 'unraid';

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
