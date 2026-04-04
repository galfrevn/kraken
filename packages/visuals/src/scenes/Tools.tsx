import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { loadFont } from "@remotion/google-fonts/JetBrainsMono";
import { COLORS } from "../constants";

const { fontFamily: mono } = loadFont("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

const TOOL_GROUPS = [
  {
    label: "CODE",
    tools: ["bash", "read", "write", "edit", "glob", "grep"],
  },
  {
    label: "AUTOMATION",
    tools: ["schedule_task", "cron", "webhook", "watcher"],
  },
  {
    label: "INTEGRATE",
    tools: ["github", "mcp", "lsp", "websearch", "webfetch"],
  },
  {
    label: "MEMORY",
    tools: ["memory_save", "memory_search", "memory_context"],
  },
  {
    label: "CHANNELS",
    tools: ["telegram", "discord", "slack"],
  },
];

export const Tools: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleOpacity = interpolate(frame, [0, 0.3 * fps], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        fontFamily: mono,
        padding: "80px 140px",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Title */}
      <div style={{ opacity: titleOpacity, marginBottom: 48 }}>
        <span style={{ fontSize: 32, color: COLORS.text, fontWeight: 700 }}>
          20+ built-in tools
        </span>
        <span style={{ fontSize: 18, color: COLORS.textDim, marginLeft: 16 }}>
          extensible via MCP
        </span>
      </div>

      {/* Tool groups */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 28,
        }}
      >
        {TOOL_GROUPS.map((group, gi) => {
          const groupDelay = 0.3 * fps + gi * 0.35 * fps;
          const groupProgress = spring({
            frame,
            fps,
            delay: groupDelay,
            config: { damping: 200 },
          });
          const groupOpacity = interpolate(frame, [groupDelay, groupDelay + 0.3 * fps], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });

          return (
            <div
              key={gi}
              style={{
                opacity: groupOpacity,
                transform: `translateX(${interpolate(groupProgress, [0, 1], [30, 0])}px)`,
                display: "flex",
                alignItems: "center",
                gap: 20,
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  color: COLORS.textDim,
                  letterSpacing: 2,
                  width: 120,
                  textAlign: "right",
                  flexShrink: 0,
                }}
              >
                {group.label}
              </span>
              <div
                style={{
                  width: 1,
                  height: 28,
                  backgroundColor: COLORS.border,
                }}
              />
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                {group.tools.map((tool, ti) => (
                  <div
                    key={ti}
                    style={{
                      fontSize: 15,
                      color: COLORS.textMuted,
                      backgroundColor: COLORS.element,
                      border: `1px solid ${COLORS.border}`,
                      padding: "6px 14px",
                      borderRadius: 6,
                    }}
                  >
                    {tool}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
