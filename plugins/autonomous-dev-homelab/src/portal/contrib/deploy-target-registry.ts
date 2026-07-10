/**
 * Deploy-target registry for the portal deploy-target selection UI.
 *
 * Implements the GOVERNING INVARIANT (#674 / model-driven portal): targets
 * are registered at runtime; the portal enumerates whatever is registered.
 * No target IDs, backend names, or node names are hard-coded here.
 *
 * Implements Issue #673.
 */

/**
 * Availability of a deploy target. An unavailable target is shown in the UI
 * with an explanation but is NOT selectable.
 */
export type TargetAvailability = "available" | "unavailable";

/**
 * Trust level of a deploy target. An untrusted target (e.g. cert mismatch,
 * revoked credential) is shown in the UI with an explanation but is NOT
 * selectable.
 */
export type TargetTrust = "trusted" | "untrusted";

/**
 * A single deploy target registered with the portal. Covers both homelab
 * and cloud targets without hardcoding either.
 */
export interface DeployTarget {
  /** Unique identifier used as the `--target` override value. */
  id: string;
  /** Broad location category: 'homelab' | 'cloud' | any other string. */
  location: string;
  /** Node or host identifier (e.g. 'proxmox-node-01', 'k3s-cluster-prod'). */
  node: string;
  /** Backend name (e.g. 'proxmox', 'unraid', 'docker-swarm', 'k3s'). */
  backend: string;
  /** Whether this target is currently reachable and healthy. */
  availability: TargetAvailability;
  /** Human-readable reason when availability === 'unavailable'. */
  unavailableReason?: string;
  /** Whether this target's credentials / certificates are valid. */
  trust: TargetTrust;
  /** Human-readable reason when trust === 'untrusted'. */
  trustReason?: string;
}

/**
 * In-memory registry of deploy targets. Populated at plugin activation from
 * the configured platforms in the inventory; new entries appear automatically
 * without code changes (model-driven portal, invariant #674).
 */
export class DeployTargetRegistry {
  private readonly targets = new Map<string, DeployTarget>();

  /**
   * Register a deploy target.
   *
   * @param target - The target to register.
   * @throws Error if a target with the same `id` is already registered.
   */
  register(target: DeployTarget): void {
    if (this.targets.has(target.id)) {
      throw new Error(`deploy target '${target.id}' is already registered`);
    }
    this.targets.set(target.id, target);
  }

  /**
   * Return all registered targets in insertion order.
   */
  list(): DeployTarget[] {
    return [...this.targets.values()];
  }

  /**
   * Look up a target by id. Returns undefined when not found.
   */
  get(id: string): DeployTarget | undefined {
    return this.targets.get(id);
  }
}
