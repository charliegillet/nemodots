// Redis key names of the flush effect, shared by dispatch and reconcile.
export const effectKey = (prefix: string, actionId: string) =>
  `${prefix}:effect:${actionId}`;
export const fenceKey = (prefix: string) => `${prefix}:fence:cache.namespace`;
