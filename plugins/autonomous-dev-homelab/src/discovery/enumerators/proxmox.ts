/**
 * Proxmox VE enumerator stub — issue #27.
 *
 * TODO(#27): Implement enumeration of VMs and LXC containers from the
 * Proxmox REST API (`GET /nodes/{node}/qemu` for VMs,
 * `GET /nodes/{node}/lxc` for containers). Map each VM/LXC to a
 * `container` entity and a `runs-on` edge to its node.
 *
 * Until implemented, returns empty results so the registry is complete
 * and the DeepEnumerator can handle this platform kind without crashing.
 */

import type { PlatformEnumerator, EnumerationContext, EnumerationResult } from '../enumerator.js';

/**
 * Stub enumerator for Proxmox VE platforms.
 * Returns empty entities and edges until issue #27 Proxmox work is done.
 */
export class ProxmoxEnumerator implements PlatformEnumerator {
  readonly platformKind = 'proxmox-ve';

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
