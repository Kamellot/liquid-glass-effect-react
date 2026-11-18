import { useId, type SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & {
  size?: number;
};

export function LogoIcon({ size = 24, style, ...props }: IconProps) {
  const clipId = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ color: '#F1F1FA', ...style }}
      aria-hidden="true"
      {...props}
    >
      <g clipPath={`url(#${clipId})`}>
        <path
          d="M4.22182 4.22183C8.51759 -0.0739417 15.4824 -0.0739417 19.7782 4.22183C24.0739 8.51759 24.0739 15.4824 19.7782 19.7782C15.4824 24.0739 8.51759 24.0739 4.22182 19.7782C-0.0739435 15.4824 -0.0739435 8.51759 4.22182 4.22183ZM9.74679 3.09556C6.68214 4.26188 4.26188 6.68214 3.09556 9.74679C2.87193 10.3345 2.75834 10.9589 2.76134 11.5878L2.76273 11.7631C2.77944 15.2571 7.00397 16.9955 9.47472 14.5253L14.5253 9.47472C16.9955 7.00398 15.2571 2.77944 11.7631 2.76273L11.5877 2.76135C10.9589 2.75834 10.3345 2.87193 9.74679 3.09556Z"
          fill="currentColor"
        />
        <path
          d="M4.75215 4.75216C8.75503 0.749282 15.245 0.749282 19.2478 4.75216C23.2507 8.75503 23.2507 15.245 19.2478 19.2478C15.245 23.2507 8.75503 23.2507 4.75215 19.2478C0.74928 15.245 0.74928 8.75503 4.75215 4.75216Z"
          strokeWidth="1.5"
          stroke="currentColor"
        />
      </g>
      <defs>
        <clipPath id={clipId}>
          <rect width="24" height="24" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
}

export function CopyIcon({ size = 24, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ color: '#DFDFED', ...style }}
      aria-hidden="true"
      {...props}
    >
      <path
        d="M19.4 20H9.6C9.26863 20 9 19.7314 9 19.4V9.6C9 9.26863 9.26863 9 9.6 9H19.4C19.7314 9 20 9.26863 20 9.6V19.4C20 19.7314 19.7314 20 19.4 20Z"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        stroke="currentColor"
      />
      <path
        d="M15 9V4.6C15 4.26863 14.7314 4 14.4 4H4.6C4.26863 4 4 4.26863 4 4.6V14.4C4 14.7314 4.26863 15 4.6 15H9"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        stroke="currentColor"
      />
    </svg>
  );
}

export function CheckIcon({ size = 24, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ color: '#8383FF', ...style }}
      aria-hidden="true"
      {...props}
    >
      <path
        d="M5 13L9 17L19 7"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        stroke="currentColor"
      />
    </svg>
  );
}

export function NpmIcon({ size = 16, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ color: '#DFDFED', ...style }}
      aria-hidden="true"
      {...props}
    >
      <path
        d="M1 8H23V15H11V17H7.5V15H1V8Z"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        stroke="currentColor"
      />
      <path d="M7.5 8V15" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" stroke="currentColor" />
      <path d="M13.5 8V15" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" stroke="currentColor" />
      <path d="M18 11V15" strokeWidth="1.5" strokeLinecap="round" stroke="currentColor" />
      <path d="M5 11V15" strokeWidth="1.5" strokeLinecap="round" stroke="currentColor" />
      <path d="M11 11V12" strokeWidth="1.5" strokeLinecap="round" stroke="currentColor" />
      <path d="M20.5 11V15" strokeWidth="1.5" strokeLinecap="round" stroke="currentColor" />
    </svg>
  );
}

export function GithubIcon({ size = 16, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ color: '#DFDFED', ...style }}
      aria-hidden="true"
      {...props}
    >
      <path
        d="M16 22.0268V19.1568C16.0375 18.68 15.9731 18.2006 15.811 17.7506C15.6489 17.3006 15.3929 16.8902 15.06 16.5468C18.2 16.1968 21.5 15.0068 21.5 9.54679C21.4997 8.15062 20.9627 6.80799 20 5.79679C20.4558 4.5753 20.4236 3.22514 19.91 2.02679C19.91 2.02679 18.73 1.67679 16 3.50679C13.708 2.88561 11.292 2.88561 9.00002 3.50679C6.27002 1.67679 5.09002 2.02679 5.09002 2.02679C4.57639 3.22514 4.54416 4.5753 5.00002 5.79679C4.03014 6.81549 3.49254 8.17026 3.50002 9.57679C3.50002 14.9968 6.80001 16.1868 9.94001 16.5768C9.61101 16.9168 9.35728 17.3222 9.19532 17.7667C9.03337 18.2112 8.96682 18.6849 9.00002 19.1568V22.0268"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        stroke="currentColor"
      />
      <path
        d="M9 20.0267C6 20.9999 3.5 20.0267 2 17.0267"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        stroke="currentColor"
      />
    </svg>
  );
}
