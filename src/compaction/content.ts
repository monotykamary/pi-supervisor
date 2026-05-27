import type { Message } from '@earendil-works/pi-ai';

export const clip = (text: string, max = 200): string => {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(' ', max);
  let end = cut > max * 0.6 ? cut : max;
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
  }
  return text.slice(0, end);
};

export const clipSentence = (text: string, max = 200): string => {
  if (text.length <= max) return text;
  const window = text.slice(0, max);
  const matches = [...window.matchAll(/[.!?](?:\s|$)/g)];
  if (matches.length > 0) {
    const last = matches[matches.length - 1];
    const end = (last.index ?? 0) + 1;
    if (end >= max * 0.5) return text.slice(0, end);
  }
  return clip(text, max);
};

export const nonEmptyLines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

export const firstLine = (text: string, max = 200): string => clip(text.split('\n')[0] ?? '', max);

const textParts = (content: Message['content']): string[] => {
  if (!content) return [];
  if (typeof content === 'string') return [content];
  return content.filter((part) => part.type === 'text').map((part) => part.text);
};

export const textOf = (content: Message['content']): string => textParts(content).join('\n');
