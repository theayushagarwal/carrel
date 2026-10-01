export const participantColors = [
  '#E4572E',
  '#4FA39A',
  '#D9A441',
  '#8FB339',
  '#4A7FD6',
  '#C46BA0',
  '#9A7BD1',
  '#E08E79',
] as const;

function channel(hex: string): number {
  const value = Number.parseInt(hex, 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const clean = hex.replace('#', '');
    const rgb = [clean.slice(0, 2), clean.slice(2, 4), clean.slice(4, 6)].map(channel);
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  };
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function readableTextOn(hex: string): '#14110F' | '#EDE6DA' {
  return contrastRatio('#14110F', hex) >= 4.5 ? '#14110F' : '#EDE6DA';
}
export * from './protocol.js';
