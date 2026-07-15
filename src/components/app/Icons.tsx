import type { ReactNode, SVGProps } from "react";

type AppIconProps = SVGProps<SVGSVGElement> & {
  children: ReactNode;
  size?: number;
};

export function AppIcon({ children, className = "", size = 18, viewBox = "0 0 24 24", ...props }: AppIconProps) {
  return (
    <svg
      aria-hidden="true"
      className={`app-icon ${className}`.trim()}
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox={viewBox}
      width={size}
      {...props}
    >
      {children}
    </svg>
  );
}

export const CloseIcon = () => <AppIcon><path d="M18 6 6 18M6 6l12 12" /></AppIcon>;
export const ChevronLeftIcon = () => <AppIcon><path d="m15 18-6-6 6-6" /></AppIcon>;
export const ChevronRightIcon = () => <AppIcon><path d="m9 18 6-6-6-6" /></AppIcon>;
export const PlusIcon = () => <AppIcon><path d="M12 5v14M5 12h14" /></AppIcon>;
export const SunIcon = () => <AppIcon><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></AppIcon>;
export const MoonIcon = () => <AppIcon><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a7 7 0 1 0 11 11Z" /></AppIcon>;
export const TrashIcon = () => <AppIcon><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="m6 6 1 15h10l1-15" /><path d="M10 11v6M14 11v6" /></AppIcon>;
export const EditIcon = () => <AppIcon><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></AppIcon>;
export const EraserIcon = () => <AppIcon><path d="m7 21-4-4L14.5 5.5a2.1 2.1 0 0 1 3 0l1 1a2.1 2.1 0 0 1 0 3L7 21Z" /><path d="M12 10 6 16" /><path d="M10 21h11" /></AppIcon>;
export const OpenIcon = () => <AppIcon><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></AppIcon>;
export const CopyIcon = () => <AppIcon><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></AppIcon>;
export const SearchIcon = () => <AppIcon><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></AppIcon>;
export const TranslateIcon = () => <AppIcon><path d="m5 8 6 6" /><path d="m4 14 6-6 2-3" /><path d="M2 5h12" /><path d="M7 2h1" /><path d="M22 22l-5-10-5 10" /><path d="M14 18h6" /></AppIcon>;
export const MessageIcon = () => <AppIcon><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" /></AppIcon>;
export const HighlightIcon = () => <AppIcon><path d="m9 11-6 6v3h3l6-6" /><path d="m22 12-4.5 4.5L7.5 6.5 12 2Z" /></AppIcon>;
export const NoteIcon = () => <AppIcon><path d="M4 4h16v16H4z" /><path d="M8 8h8M8 12h8M8 16h5" /></AppIcon>;
export const SaveIcon = () => <AppIcon><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" /><path d="M17 21v-8H7v8" /><path d="M7 3v5h8" /></AppIcon>;
export const DownloadIcon = () => <AppIcon><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></AppIcon>;
export const SendIcon = () => <AppIcon><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></AppIcon>;
export const ZoomInIcon = () => <AppIcon><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3M11 8v6M8 11h6" /></AppIcon>;
export const ZoomOutIcon = () => <AppIcon><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3M8 11h6" /></AppIcon>;
export const FitWidthIcon = () => <AppIcon><path d="M4 7V5h16v2" /><path d="M4 17v2h16v-2" /><path d="M8 12h8" /><path d="m10 10-2 2 2 2M14 10l2 2-2 2" /></AppIcon>;
export const SidebarIcon = () => <AppIcon><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></AppIcon>;
export const RefreshIcon = () => <AppIcon><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /></AppIcon>;
