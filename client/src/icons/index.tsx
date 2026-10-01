import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };
const make = (content: React.ReactNode) =>
  function Icon({ size = 20, ...props }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
        strokeLinejoin="miter"
        aria-hidden="true"
        {...props}
      >
        {content}
      </svg>
    );
  };
export const Crown = make(<path d="M3 15.5h14M4 13.5 3 5l5 4 2-6 2 6 5-4-1 8.5H4Z" />);
export const Lock = make(
  <>
    <rect x="4" y="8" width="12" height="9" rx="1" />
    <path d="M6.5 8V5.8a3.5 3.5 0 0 1 7 0V8" />
  </>,
);
export const LockOpen = make(
  <>
    <rect x="4" y="8" width="12" height="9" rx="1" />
    <path d="M6.5 8V5.8a3.5 3.5 0 0 1 6.2-2.2" />
  </>,
);
export const Door = make(
  <>
    <path d="M5 17V3h10v14M3 17h14M9 10h.01" />
  </>,
);
export const Nib = make(
  <>
    <path d="m4 16 2-5 7-7 2 2-7 7-5 2Z" />
    <path d="m11 5 2 2M6 11l3 3" />
  </>,
);
export const Pin = make(
  <>
    <path d="m6 4 10 10M13 3l4 4-3 1-3 3-1 3-4-4 3-1 3-3 1-3Z" />
    <path d="m7 13-3 3" />
  </>,
);
export const Copy = make(
  <>
    <rect x="7" y="7" width="9" height="9" />
    <path d="M13 7V4H4v9h3" />
  </>,
);
export const Check = make(<path d="m4 10 4 4 8-8" />);
export const Close = make(<path d="m5 5 10 10M15 5 5 15" />);
export const Plus = make(<path d="M10 4v12M4 10h12" />);
export const User = make(
  <>
    <circle cx="10" cy="6" r="3" />
    <path d="M4 17c.8-3 2.8-4.5 6-4.5s5.2 1.5 6 4.5" />
  </>,
);
export const Users = make(
  <>
    <circle cx="7" cy="7" r="2.5" />
    <circle cx="14" cy="8" r="2" />
    <path d="M2.5 16c.6-2.5 2.1-3.7 4.5-3.7s3.9 1.2 4.5 3.7M12 13c2.7-.3 4.5.8 5.3 3" />
  </>,
);
export const Activity = make(<path d="M2 10h3l2-5 4 10 2-5h5" />);
export const Code = make(
  <>
    <path d="m7 5-5 5 5 5M13 5l5 5-5 5" />
    <path d="m11 3-2 14" />
  </>,
);
export const Sun = make(
  <>
    <circle cx="10" cy="10" r="3" />
    <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M15.7 4.3l-1.4 1.4M5.7 14.3l-1.4 1.4" />
  </>,
);
export const Moon = make(<path d="M16.5 12.5A6.5 6.5 0 0 1 7.5 3.8 6.5 6.5 0 1 0 16.5 12.5Z" />);
export const Wifi = make(
  <>
    <path d="M2 7.5a12 12 0 0 1 16 0M5 11a7.5 7.5 0 0 1 10 0M8 14a3 3 0 0 1 4 0" />
    <path d="M10 17h.01" />
  </>,
);
export const WifiOff = make(
  <>
    <path d="M3 7.5a12 12 0 0 1 10-1.9M5 11a7.5 7.5 0 0 1 4.2-.8M8 14a3 3 0 0 1 2 .1" />
    <path d="m3 3 14 14" />
  </>,
);
export const Chevron = make(<path d="m6 8 4 4 4-4" />);
export const LinkIcon = make(
  <>
    <path d="M8 12 12 8M6 14H4a3 3 0 0 1 0-6h3M14 6h2a3 3 0 0 1 0 6h-3" />
  </>,
);
export const Alert = make(
  <>
    <path d="M10 3 18 17H2L10 3Z" />
    <path d="M10 8v4M10 14h.01" />
  </>,
);
export const Refresh = make(
  <>
    <path d="M16 7V3l-2 2a6 6 0 1 0 1.7 6" />
  </>,
);
export const Resize = make(
  <>
    <path d="M4 10h12M10 4v12" />
    <path d="m7 7-3 3 3 3M13 7l3 3-3 3" />
  </>,
);
