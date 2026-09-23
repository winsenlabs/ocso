/** Theme of the React Native components (plain values; no StyleSheet types in the public API). */
export interface OcsoChatTheme {
  accent: string;
  onAccent: string;
  background: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  danger: string;
  radius: number;
  fontFamily?: string;
  fontSize: number;
  customerBubble?: string;
  customerText?: string;
  assistantBubble?: string;
  assistantText?: string;
}

export const lightTheme: OcsoChatTheme = {
  accent: '#0f766e',
  onAccent: '#ffffff',
  background: '#ffffff',
  surface: '#f4f5f7',
  text: '#16181d',
  muted: '#5d6470',
  border: '#dfe2e7',
  danger: '#b42318',
  radius: 14,
  fontSize: 15,
};

export const darkTheme: OcsoChatTheme = {
  ...lightTheme,
  background: '#121417',
  surface: '#1e2227',
  text: '#eef0f3',
  muted: '#a3aab5',
  border: '#2c3138',
  danger: '#f97066',
};

export function makeStyles(t: OcsoChatTheme) {
  const font = { fontSize: t.fontSize, ...(t.fontFamily ? { fontFamily: t.fontFamily } : {}) };
  return {
    root: { flex: 1, backgroundColor: t.background },
    header: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.border },
    title: { ...font, fontWeight: '600' as const, color: t.text, fontSize: t.fontSize + 1 },
    subtitle: { ...font, color: t.muted, fontSize: t.fontSize - 2, marginTop: 2 },
    banner: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: t.surface },
    bannerText: { ...font, color: t.muted, fontSize: t.fontSize - 2 },
    list: { flex: 1 },
    listContent: { padding: 12, gap: 8 },
    row: { flexDirection: 'row' as const, marginVertical: 4 },
    rowCustomer: { justifyContent: 'flex-end' as const },
    rowSystem: { justifyContent: 'center' as const },
    bubble: { maxWidth: '82%' as const, paddingHorizontal: 12, paddingVertical: 8, borderRadius: t.radius, backgroundColor: t.assistantBubble ?? t.surface },
    bubbleCustomer: { backgroundColor: t.customerBubble ?? t.accent },
    author: { ...font, fontSize: t.fontSize - 3, fontWeight: '600' as const, color: t.muted, marginBottom: 2 },
    text: { ...font, color: t.assistantText ?? t.text },
    textCustomer: { color: t.customerText ?? t.onAccent },
    link: { textDecorationLine: 'underline' as const },
    muted: { ...font, color: t.muted, fontSize: t.fontSize - 2 },
    failed: { ...font, color: t.danger, fontSize: t.fontSize - 3, marginTop: 4 },
    image: { width: 220, height: 160, borderRadius: t.radius * 0.6, marginTop: 4 },
    choices: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 6, marginTop: 8 },
    choice: { borderWidth: 1, borderColor: t.accent, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: t.background },
    choiceActive: { backgroundColor: t.accent },
    choiceDisabled: { opacity: 0.55 },
    choiceText: { ...font, color: t.accent },
    choiceTextActive: { color: t.onAccent },
    typing: { ...font, color: t.muted, fontSize: t.fontSize - 2, paddingHorizontal: 16, minHeight: 20 },
    composer: { borderTopWidth: 1, borderTopColor: t.border, padding: 8 },
    composerRow: { flexDirection: 'row' as const, alignItems: 'flex-end' as const, gap: 8 },
    input: { ...font, flex: 1, minHeight: 40, maxHeight: 140, paddingHorizontal: 12, paddingVertical: 9, borderWidth: 1, borderColor: t.border, borderRadius: t.radius * 0.75, color: t.text, backgroundColor: t.background },
    button: { minHeight: 40, paddingHorizontal: 16, justifyContent: 'center' as const, borderRadius: t.radius * 0.75, backgroundColor: t.accent },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { ...font, color: t.onAccent, fontWeight: '600' as const },
    attach: { minWidth: 40, minHeight: 40, alignItems: 'center' as const, justifyContent: 'center' as const, borderWidth: 1, borderColor: t.border, borderRadius: t.radius * 0.75 },
    attachText: { ...font, color: t.muted, fontSize: t.fontSize + 3 },
    chips: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 6, marginBottom: 8 },
    chip: { flexDirection: 'row' as const, gap: 6, alignItems: 'center' as const, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: t.surface },
    chipText: { ...font, color: t.text, fontSize: t.fontSize - 2 },
  };
}

export type OcsoChatStyles = ReturnType<typeof makeStyles>;
