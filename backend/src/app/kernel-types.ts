/** Shared kernel identifier and role model types used across settings, kernels, and accounts. */

/** The agent runtime that runs sessions. */
export type Kernel = "antigravity";

/** A model choice for one role. */
export interface RoleModel {
  /** The provider (`antigravity`). */
  provider: string;
  /** The model id. */
  model: string;
}
