export function buildNoChannelsConnectedMessage(
  installedChannels: string[],
): string {
  if (installedChannels.length === 0) {
    return [
      'No channels connected.',
      'No channel skills are installed.',
      'Run ./scripts/setup.sh to launch the guided installer.',
      'Manual skills: add-whatsapp, add-telegram, add-slack, add-discord.',
    ].join(' ');
  }

  return [
    'No channels connected.',
    `Installed channels: ${installedChannels.join(', ')}.`,
    'Installed channels were detected, but their credentials or chat registrations are incomplete.',
    'Finish channel authentication and registration with ./scripts/setup.sh, or inspect ./scripts/verify.sh.',
  ].join(' ');
}

export function buildRuntimeUnavailableMessage(runtimeError: string): string {
  return [
    'Container runtime is unavailable.',
    runtimeError,
    'Run ./scripts/setup.sh to repair system dependencies or container runtime setup.',
    'If the problem persists, run ./scripts/verify.sh and inspect the reported runtime checks.',
  ].join(' ');
}
