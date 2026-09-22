/** Channel codes as the UI marks them (docs/07). Shared by loaders and the ChannelMark primitive. */
export type ChannelCode = 'WA' | 'WB' | 'AP' | 'EM' | 'VO' | 'IG' | 'SM';

export const CHANNEL_NAMES: Readonly<Record<ChannelCode, string>> = {
  WA: 'WhatsApp',
  WB: 'Web chat',
  AP: 'Mobile app chat',
  EM: 'Email',
  VO: 'Voice',
  IG: 'Instagram DM',
  SM: 'SMS',
};
