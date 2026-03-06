import { describe, expect, it } from 'vitest';

import { buildNoChannelsConnectedMessage } from './startup-guidance.js';

describe('buildNoChannelsConnectedMessage', () => {
  it('guides the user to guided setup when no channel skills are installed', () => {
    const message = buildNoChannelsConnectedMessage([]);

    expect(message).toContain('./scripts/setup.sh');
    expect(message).toContain('add-whatsapp');
    expect(message).toContain('add-telegram');
  });

  it('guides the user to auth and verify when channels are installed', () => {
    const message = buildNoChannelsConnectedMessage(['telegram', 'discord']);

    expect(message).toContain('Installed channels: telegram, discord.');
    expect(message).toContain('./scripts/verify.sh');
  });
});
