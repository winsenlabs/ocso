'use client';

import { linkify, type ChatMessage, type ChoiceOption, type Part } from '@winsendotai/ocso-chat';
import { useState } from 'react';
import { Image, Linking, Pressable, Text, View } from 'react-native';
import type { OcsoChatLabels } from '../core/labels.js';
import type { OcsoChatStyles } from './theme.js';

const open = (url: string) => void Linking.openURL(url).catch(() => undefined);

export function NativeRichText({ text, styles, customer }: { text: string; styles: OcsoChatStyles; customer: boolean }) {
  return (
    <Text style={[styles.text, customer ? styles.textCustomer : null]}>
      {linkify(text).map((seg, i) =>
        seg.type === 'link' ? (
          <Text key={i} style={styles.link} accessibilityRole="link" onPress={() => open(seg.href)}>
            {seg.text}
          </Text>
        ) : (
          seg.text
        ),
      )}
    </Text>
  );
}

export function NativeChoiceButtons({ options, disabled, onChoose, styles, label }: { options: ChoiceOption[]; disabled: boolean; onChoose: (c: ChoiceOption) => Promise<void>; styles: OcsoChatStyles; label: string }) {
  const [chosen, setChosen] = useState<string | null>(null);
  return (
    <View style={styles.choices} accessibilityLabel={label}>
      {options.map((option) => {
        const active = chosen === option.id;
        const off = disabled || chosen !== null;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="button"
            accessibilityState={{ disabled: off, selected: active }}
            disabled={off}
            style={[styles.choice, active ? styles.choiceActive : null, off && !active ? styles.choiceDisabled : null]}
            onPress={() => {
              setChosen(option.id);
              void onChoose(option).catch(() => setChosen(null));
            }}
          >
            <Text style={[styles.choiceText, active ? styles.choiceTextActive : null]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function NativePart({ part, message, latest, styles, labels, onChoose }: { part: Part; message: ChatMessage; latest: boolean; styles: OcsoChatStyles; labels: OcsoChatLabels; onChoose: (c: ChoiceOption) => Promise<void> }) {
  const customer = message.role === 'customer';
  switch (part.type) {
    case 'text':
      return <NativeRichText text={part.text} styles={styles} customer={customer} />;
    case 'media':
      if (part.kind === 'image') return <Image source={{ uri: part.url }} style={styles.image} resizeMode="cover" accessibilityLabel={part.name ?? 'Image'} />;
      return (
        <Text style={[styles.text, customer ? styles.textCustomer : null, styles.link]} accessibilityRole="link" onPress={() => open(part.url)}>
          {part.name ?? part.kind}
        </Text>
      );
    case 'choices':
      return (
        <View>
          {part.prompt ? <NativeRichText text={part.prompt} styles={styles} customer={customer} /> : null}
          <NativeChoiceButtons options={part.options} disabled={!latest} onChoose={onChoose} styles={styles} label={part.prompt ?? labels.choicesGroup} />
        </View>
      );
    case 'unavailable':
      return <Text style={styles.muted}>{labels.unavailable}</Text>;
    default:
      return null;
  }
}
