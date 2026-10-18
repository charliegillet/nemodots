// The live suite's team config: the one production function, nothing else.
import { incidentTeamConfig } from '../../../../src/server/nemodots/team/index.js';

export function liveTeamConfig(model: string, host: string) {
  return incidentTeamConfig({ model, provider: { host, mode: 'live' } });
}
