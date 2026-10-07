export const easing = {
  out: [0.22, 1, 0.36, 1] as const,
  inOut: [0.65, 0, 0.35, 1] as const,
  cssOut: 'cubic-bezier(0.22, 1, 0.36, 1)',
  cssInOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
};
export const durations = { instant: 120, fast: 200, medium: 320, slow: 600 } as const;
export const spring = { stiffness: 400, damping: 40 } as const;
