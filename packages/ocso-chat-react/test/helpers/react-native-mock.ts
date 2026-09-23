/**
 * Minimal react-native stand-in for Node tests (the real package ships Flow
 * source and native modules). Host components render as plain elements named
 * after the RN component, so react-test-renderer trees can be queried by type.
 */
import { createElement, forwardRef, useImperativeHandle, type ReactNode } from 'react';

type Props = Record<string, unknown> & { children?: ReactNode };

const host = (name: string) => {
  const C = (props: Props) => createElement(name, props, props.children);
  C.displayName = name;
  return C;
};

export const View = host('View');
export const Text = host('Text');
export const TextInput = host('TextInput');
export const Pressable = host('Pressable');
export const Image = host('Image');

export const scrollCalls: number[] = [];

interface ListProps {
  data: unknown[];
  renderItem: (info: { item: unknown; index: number }) => ReactNode;
  keyExtractor: (item: unknown) => string;
  ListEmptyComponent?: ReactNode;
  [key: string]: unknown;
}

export const FlatList = forwardRef<unknown, ListProps>(function FlatList(props, ref) {
  useImperativeHandle(ref, () => ({ scrollToEnd: () => void scrollCalls.push(Date.now()) }));
  const { data, renderItem, keyExtractor, ListEmptyComponent, ...rest } = props as ListProps;
  const items = data.length ? data.map((item, index) => createElement('Item', { key: keyExtractor(item) }, renderItem({ item, index }))) : (ListEmptyComponent ?? null);
  return createElement('FlatList', rest, items);
});

export const openedUrls: string[] = [];
export const Linking = { openURL: async (url: string) => void openedUrls.push(url) };
export const StyleSheet = { create: <T,>(s: T) => s, flatten: (s: unknown) => s };
export const Platform = { OS: 'ios', select: <T,>(o: { ios?: T; default?: T }) => o.ios ?? o.default };
