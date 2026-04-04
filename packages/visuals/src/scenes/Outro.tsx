import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { loadFont } from "@remotion/google-fonts/JetBrainsMono";
import { COLORS } from "../constants";

const { fontFamily: mono } = loadFont("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const nameScale = spring({ frame, fps, config: { damping: 200 } });
  const nameOpacity = interpolate(frame, [0, 0.3 * fps], [0, 1], {
    extrapolateRight: "clamp",
  });

  const installOpacity = interpolate(frame, [0.5 * fps, 0.9 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const cursorVisible = Math.floor(frame / (fps * 0.4)) % 2 === 0;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        justifyContent: "center",
        alignItems: "center",
        fontFamily: mono,
      }}
    >
      {/* Name */}
      <div
        style={{
          opacity: nameOpacity,
          transform: `scale(${nameScale})`,
          marginBottom: 40,
        }}
      >
        <span style={{ fontSize: 64, color: COLORS.text, fontWeight: 700 }}>kraken</span>
      </div>

      {/* Install command */}
      <div style={{ opacity: installOpacity }}>
        <div
          style={{
            fontSize: 18,
            color: COLORS.textMuted,
            backgroundColor: COLORS.panel,
            border: `1px solid ${COLORS.border}`,
            padding: "14px 32px",
            borderRadius: 8,
          }}
        >
          <span style={{ color: COLORS.textDim }}>$ </span>
          <span style={{ color: COLORS.text }}>curl -fsSL https://kraken.dev/install | bash</span>
          <span style={{ color: COLORS.textDim, opacity: cursorVisible ? 1 : 0 }}> _</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};
