import type { ReactNode } from 'react';
import styles from './icons.module.css';

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className={styles.icon}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const SunIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
  </Icon>
);

export const MoonIcon = () => (
  <Icon>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5Z" />
  </Icon>
);

export const AscendantIcon = () => (
  <Icon>
    <path d="M3 18h18M12 14V4M7.5 8.5 12 4l4.5 4.5" />
  </Icon>
);

export const LockIcon = () => (
  <Icon>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Icon>
);

export const ShareIcon = () => (
  <Icon>
    <path d="M12 15V3M7.5 7.5 12 3l4.5 4.5M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
  </Icon>
);

export const AlertIcon = () => (
  <Icon>
    <path d="M12 4 2.8 19.5h18.4L12 4ZM12 10v4.5M12 17.2v.1" />
  </Icon>
);

export const InfoIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.6v.1" />
  </Icon>
);

export const SearchIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Icon>
);

export const PinIcon = () => (
  <Icon>
    <path d="M12 21s7-5.8 7-11a7 7 0 1 0-14 0c0 5.2 7 11 7 11Z" />
    <circle cx="12" cy="10" r="2.5" />
  </Icon>
);

export const BackIcon = () => (
  <Icon>
    <path d="M14.5 5 8 12l6.5 7" />
  </Icon>
);

export const StarsIcon = () => (
  <Icon>
    <path d="M10 3.5 11.8 8l4.7 1.8-4.7 1.8L10 16l-1.8-4.4L3.5 9.8 8.2 8 10 3.5ZM18 14l.9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9L18 14Z" />
  </Icon>
);

export const CheckIcon = () => (
  <Icon>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);

export const DocumentIcon = () => (
  <Icon>
    <path d="M7 3h7l4 4v14H7V3ZM14 3v4h4M10 12h5M10 16h5" />
  </Icon>
);

export const GearIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" />
  </Icon>
);

export const DownloadIcon = () => (
  <Icon>
    <path d="M12 3v12M7.5 10.5 12 15l4.5-4.5M5 20h14" />
  </Icon>
);
