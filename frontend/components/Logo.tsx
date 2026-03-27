interface LogoProps {
  size?: number;
  className?: string;
}

export default function Logo({ size = 40, className = "" }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Predacy"
    >
      <defs>
        <filter id="logo-eye-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="logo-pupil-glow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <radialGradient id="logo-iris-bg" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#2CE8C6" stopOpacity="0.13" />
          <stop offset="100%" stopColor="#2CE8C6" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Eye interior ambient */}
      <path d="M 6,32 C 20,19 44,19 58,32 C 44,45 20,45 6,32 Z" fill="url(#logo-iris-bg)" />

      {/* Iris ring */}
      <ellipse cx="32" cy="32" rx="11" ry="8.5" stroke="#2CE8C6" strokeWidth="0.6" opacity={0.35} />

      {/* Eye lens outline */}
      <path
        d="M 6,32 C 20,19 44,19 58,32 C 44,45 20,45 6,32 Z"
        stroke="#2CE8C6"
        strokeWidth="1.5"
        filter="url(#logo-eye-glow)"
      />

      {/* Vertical slit pupil */}
      <path
        d="M 32,21 C 35.5,26 35.5,38 32,43 C 28.5,38 28.5,26 32,21 Z"
        fill="#2CE8C6"
        filter="url(#logo-pupil-glow)"
      />

      {/* Glint */}
      <circle cx="42" cy="25" r="1.5" fill="white" opacity={0.45} />
    </svg>
  );
}
