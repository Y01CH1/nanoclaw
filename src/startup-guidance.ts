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
    'Finish channel authentication and registration with ./scripts/setup.sh, or inspect ./scripts/verify.sh.',
  ].join(' ');
}
