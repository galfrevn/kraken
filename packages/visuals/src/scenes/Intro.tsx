import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { loadFont } from "@remotion/google-fonts/JetBrainsMono";
import { COLORS } from "../constants";

const { fontFamily: mono } = loadFont("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

const LOGO_LINES = [
  "█░░█ █▀▀▄ ▄▀▀▄ █░░█ █▀▀▀ █▀▀▄   █▀▀▀ █▀▀█ █▀▀▄ █▀▀▀",
  "█▀▀░ █▀▀░ █▀▀█ █▀▀░ █▀▀░ █░░█   █░░░ █░░█ █░░█ █▀▀░",
  "█░░█ █░░█ █░░█ █░░█ ████ █  █   ████ ████ ████ ████",
];

export const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const logoScale = spring({ frame, fps, config: { damping: 200 } });
  const logoOpacity = interpolate(frame, [0, 0.3 * fps], [0, 1], {
    extrapolateRight: "clamp",
  });

  const taglineOpacity = interpolate(frame, [0.6 * fps, 1.1 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const versionOpacity = interpolate(frame, [1.2 * fps, 1.6 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Cursor blink
  const cursorVisible = Math.floor(frame / (fps * 0.5)) % 2 === 0;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        justifyContent: "center",
        alignItems: "center",
        fontFamily: mono,
      }}
    >
      {/* Logo */}
      <div
        style={{
          opacity: logoOpacity,
          transform: `scale(${logoScale})`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 2,
        }}
      >
        {LOGO_LINES.map((line, i) => (
          <div
            key={i}
            style={{
              fontSize: 38,
              color: COLORS.text,
              letterSpacing: 2,
              lineHeight: 1.1,
              whiteSpace: "pre",
            }}
          >
            {line}
          </div>
        ))}
      </div>

      {/* Tagline */}
      <div
        style={{
          marginTop: 40,
          opacity: taglineOpacity,
          textAlign: "center",
        }}
      >
        <span style={{ fontSize: 22, color: COLORS.textMuted }}>an autonomous developer agent</span>
      </div>

      {/* Version + cursor */}
      <div
        style={{
          marginTop: 20,
          opacity: versionOpacity,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ fontSize: 16, color: COLORS.textDim }}>v0.1.4</span>
        <span
          style={{
            fontSize: 16,
            color: COLORS.textDim,
            opacity: cursorVisible ? 1 : 0,
          }}
        >
          _
        </span>
      </div>
    </AbsoluteFill>
  );
};
