import type { AppDevConfig, StrategyName } from '../core/config.js';
import { LargeStrategy } from './large.js';
import { SmallStrategy } from './small.js';
import type { Strategy } from './types.js';

export * from './types.js';
export { SmallStrategy } from './small.js';
export { LargeStrategy, activeReleaseBranches } from './large.js';

type StrategyFactory = (config: AppDevConfig) => Strategy;

/** The one place strategies are named. Adding a third strategy means adding a row here. */
const REGISTRY: Record<StrategyName, StrategyFactory> = {
  small: (config) => new SmallStrategy(config),
  large: (config) => new LargeStrategy(config),
};

export function createStrategy(config: AppDevConfig): Strategy {
  const factory = REGISTRY[config.strategy];
  if (!factory) {
    throw new Error(
      `Unknown strategy "${config.strategy}" in .app-dev-mcp.json — expected one of: ${Object.keys(REGISTRY).join(', ')}.`,
    );
  }
  return factory(config);
}

export function strategyNames(): StrategyName[] {
  return Object.keys(REGISTRY) as StrategyName[];
}
