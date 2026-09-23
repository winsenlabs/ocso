'use client';

import type { ChatMessage, NativeFile, OcsoChatClient, OcsoChatOptions, Part } from '@winsendotai/ocso-chat';
import { useMemo, useRef, type ReactNode } from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { OcsoChatProvider } from '../core/context.js';
import { useOcsoChat } from '../core/hooks.js';
import { defaultLabels, type OcsoChatLabels } from '../core/labels.js';
import { NativePart } from './parts.js';
import { darkTheme, lightTheme, makeStyles, type OcsoChatStyles, type OcsoChatTheme } from './theme.js';

export interface OcsoChatViewProps {
  /** Colours, radius and font; merged over the light (or dark, per channel branding) theme. */
  theme?: Partial<OcsoChatTheme>;
  labels?: Partial<OcsoChatLabels>;
  /** Header title (default: channel branding title or name). `null` hides the header. */
  title?: ReactNode | null;
  placeholder?: string;
  /** Show an attach button that calls this (e.g. an image or document picker) and stages what it returns. */
  onPickAttachment?: () => Promise<NativeFile | NativeFile[] | null | undefined>;
  renderMessage?: (message: ChatMessage, defaultRender: () => ReactNode) => ReactNode;
  renderPart?: (part: Part, message: ChatMessage, defaultRender: () => ReactNode) => ReactNode;
  /** Passed to the root View. */
  style?: unknown;
  client?: OcsoChatClient;
  options?: OcsoChatOptions;
}

function authorOf(message: ChatMessage, labels: OcsoChatLabels): string | null {
  if (message.role === 'customer' || message.role === 'system') return null;
  return message.author?.name ?? (message.role === 'agent' ? labels.agent : labels.assistant);
}

function View_({ theme, labels: overrides, title, placeholder, onPickAttachment, renderMessage, renderPart, style }: OcsoChatViewProps) {
  const chat = useOcsoChat();
  const labels = { ...defaultLabels, ...overrides };
  const branding = chat.config?.branding;
  const base = branding?.theme === 'dark' ? darkTheme : lightTheme;
  const t: OcsoChatTheme = { ...base, ...(branding?.accentColor ? { accent: branding.accentColor } : {}), ...theme };
  const themeKey = JSON.stringify(t);
  const styles: OcsoChatStyles = useMemo(() => makeStyles(JSON.parse(themeKey) as OcsoChatTheme), [themeKey]);
  const list = useRef<FlatList<ChatMessage> | null>(null);
  const heading = title === undefined ? (branding?.title ?? chat.config?.name ?? null) : title;
  const latest = [...chat.messages].reverse().find((m) => m.role !== 'system');
  const canSend = chat.status !== 'error' && (chat.input.trim().length > 0 || chat.attachments.length > 0);

  const pick = async () => {
    const picked = await onPickAttachment?.();
    if (!picked) return;
    const files = Array.isArray(picked) ? picked : [picked];
    const max = chat.config?.maxAttachmentsPerMessage ?? files.length;
    chat.setAttachments([...chat.attachments, ...files].slice(0, max || undefined));
  };

  const renderBubble = (message: ChatMessage) => {
    const customer = message.role === 'customer';
    const body = () => {
      if (message.role === 'system') return <Text style={styles.muted}>{message.parts.map((p) => (p.type === 'text' ? p.text : '')).join(' ')}</Text>;
      const author = authorOf(message, labels);
      return (
        <View style={[styles.bubble, customer ? styles.bubbleCustomer : null]}>
          {author ? <Text style={styles.author}>{author}</Text> : null}
          {message.parts.map((part, i) => {
            const fallback = () => <NativePart part={part} message={message} latest={message === latest} styles={styles} labels={labels} onChoose={chat.sendChoice} />;
            return <View key={i}>{renderPart ? renderPart(part, message, fallback) : fallback()}</View>;
          })}
          {message.status === 'failed' ? (
            <Text style={styles.failed}>
              {labels.failed}{' '}
              <Text accessibilityRole="button" style={styles.link} onPress={() => void chat.retry(message.id).catch(() => undefined)}>
                {labels.retry}
              </Text>{' '}
              <Text accessibilityRole="button" style={styles.link} onPress={() => chat.discard(message.id)}>
                {labels.discard}
              </Text>
            </Text>
          ) : null}
        </View>
      );
    };
    return (
      <View style={[styles.row, customer ? styles.rowCustomer : null, message.role === 'system' ? styles.rowSystem : null]}>
        {renderMessage ? renderMessage(message, body) : body()}
      </View>
    );
  };

  const banner = chat.status === 'reconnecting' ? labels.reconnecting : chat.status === 'offline' ? labels.offline : chat.status === 'error' ? labels.error : null;

  return (
    <View style={[styles.root, style as object]}>
      {heading !== null ? (
        <View style={styles.header}>
          {typeof heading === 'string' ? <Text style={styles.title} accessibilityRole="header">{heading}</Text> : heading}
          {branding?.subtitle ? <Text style={styles.subtitle}>{branding.subtitle}</Text> : null}
        </View>
      ) : null}
      {banner ? (
        <View style={styles.banner} accessibilityLiveRegion="polite">
          <Text style={styles.bannerText}>{banner}</Text>
          {chat.status !== 'offline' ? (
            <Text accessibilityRole="button" style={[styles.bannerText, styles.link]} onPress={chat.reconnect}>
              {labels.tryAgain}
            </Text>
          ) : null}
        </View>
      ) : null}
      <FlatList
        ref={list}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={chat.messages}
        extraData={latest?.id}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => renderBubble(item)}
        accessibilityLabel={labels.log}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
        {...(branding?.greeting ? { ListEmptyComponent: <Text style={styles.muted}>{branding.greeting}</Text> } : {})}
      />
      <Text style={styles.typing} accessibilityLiveRegion="polite">
        {chat.typing ? labels.typing(chat.typing.name) : ''}
      </Text>
      <View style={styles.composer}>
        {chat.attachments.length ? (
          <View style={styles.chips}>
            {chat.attachments.map((file, i) => (
              <View key={`${file.name ?? 'file'}-${i}`} style={styles.chip}>
                <Text style={styles.chipText}>{file.name ?? 'attachment'}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel={labels.removeAttachment(file.name ?? 'attachment')} onPress={() => chat.setAttachments(chat.attachments.filter((_, j) => j !== i))}>
                  <Text style={styles.chipText}>×</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
        <View style={styles.composerRow}>
          {onPickAttachment ? (
            <Pressable accessibilityRole="button" accessibilityLabel={labels.attach} style={styles.attach} onPress={() => void pick().catch(() => undefined)}>
              <Text style={styles.attachText}>+</Text>
            </Pressable>
          ) : null}
          <TextInput
            style={styles.input}
            value={chat.input}
            onChangeText={chat.setInput}
            placeholder={placeholder ?? labels.placeholder}
            placeholderTextColor={t.muted}
            accessibilityLabel={labels.input}
            multiline
            {...(chat.config ? { maxLength: chat.config.maxTextLength } : {})}
            editable={chat.status !== 'error'}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSend }}
            disabled={!canSend}
            style={[styles.button, canSend ? null : styles.buttonDisabled]}
            onPress={() => void chat.handleSubmit()}
          >
            <Text style={styles.buttonText}>{labels.send}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/**
 * The full chat for React Native: header, message list (FlatList), typing
 * line and composer. Inside an `OcsoChatProvider` it uses that client;
 * otherwise pass `options` (or `client`).
 */
export function OcsoChatView({ client, options, ...rest }: OcsoChatViewProps) {
  if (client) return <OcsoChatProvider client={client}><View_ {...rest} /></OcsoChatProvider>;
  if (options) return <OcsoChatProvider options={options}><View_ {...rest} /></OcsoChatProvider>;
  return <View_ {...rest} />;
}
