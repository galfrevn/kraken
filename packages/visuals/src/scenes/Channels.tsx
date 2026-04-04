import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { loadFont } from "@remotion/google-fonts/JetBrainsMono";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { COLORS } from "../constants";

const { fontFamily: mono } = loadFont("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

const { fontFamily: inter } = loadInter("normal", {
  weights: ["400", "500", "600"],
  subsets: ["latin"],
});

// --- Phone chat messages ---
type ChatMsg = {
  sender: "user" | "bot";
  text: string;
};

const CHAT: ChatMsg[] = [
  { sender: "user", text: "/deploy staging" },
  { sender: "bot", text: "Task queued: deploy to staging" },
  { sender: "bot", text: "Running deploy pipeline..." },
  { sender: "bot", text: "Deployed to staging (32s)" },
];

// --- Terminal log lines that react to the phone ---
const TERMINAL_EVENTS = [
  {
    time: "14:22:01",
    tag: "telegram",
    msg: "received /deploy staging from @galfrevn",
    color: COLORS.accent,
  },
  { time: "14:22:01", tag: "daemon", msg: "created task e4a1 (priority: 10)", color: COLORS.text },
  { time: "14:22:02", tag: "worker-1", msg: "spawned for task e4a1", color: COLORS.text },
  {
    time: "14:22:03",
    tag: "worker-1",
    msg: "tool: bash  $ ./scripts/deploy.sh staging",
    color: COLORS.cyan,
  },
  {
    time: "14:22:18",
    tag: "worker-1",
    msg: "tool: bash  $ curl -s https://staging.app/health",
    color: COLORS.cyan,
  },
  {
    time: "14:22:19",
    tag: "worker-1",
    msg: 'health check: {"status":"ok","version":"0.1.5"}',
    color: COLORS.green,
  },
  { time: "14:22:33", tag: "worker-1", msg: "completed task e4a1 (32s)", color: COLORS.green },
  {
    time: "14:22:33",
    tag: "notify",
    msg: "telegram: replied to @galfrevn",
    color: COLORS.textMuted,
  },
];

// --- Phone mockup ---
const PhoneMockup: React.FC<{ frame: number; fps: number }> = ({ frame, fps }) => {
  const phoneScale = spring({ frame, fps, config: { damping: 200 } });
  const phoneOpacity = interpolate(frame, [0, 0.3 * fps], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        opacity: phoneOpacity,
        transform: `scale(${phoneScale})`,
        width: 380,
        height: 700,
        backgroundColor: COLORS.panel,
        borderRadius: 40,
        border: `2px solid ${COLORS.border}`,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
      }}
    >
      {/* Status bar */}
      <div
        style={{
          height: 44,
          padding: "0 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 12,
          color: COLORS.textMuted,
          fontFamily: inter,
        }}
      >
        <span>14:22</span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 10 }}>5G</span>
          {/* Battery icon */}
          <div
            style={{
              width: 22,
              height: 10,
              border: `1px solid ${COLORS.textMuted}`,
              borderRadius: 2,
              padding: 1,
            }}
          >
            <div
              style={{
                width: "75%",
                height: "100%",
                backgroundColor: COLORS.green,
                borderRadius: 1,
              }}
            />
          </div>
        </div>
      </div>

      {/* Chat header */}
      <div
        style={{
          height: 56,
          borderBottom: `1px solid ${COLORS.border}`,
          display: "flex",
          alignItems: "center",
          padding: "0 20px",
          gap: 12,
        }}
      >
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: "50%",
            backgroundColor: COLORS.element,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 14,
            color: COLORS.accent,
            fontFamily: mono,
            fontWeight: 700,
          }}
        >
          K
        </div>
        <div>
          <div style={{ fontSize: 15, color: COLORS.text, fontFamily: inter, fontWeight: 600 }}>
            Kraken Bot
          </div>
          <div style={{ fontSize: 11, color: COLORS.green, fontFamily: inter }}>online</div>
        </div>
      </div>

      {/* Messages */}
      <div
        style={{
          flex: 1,
          padding: "16px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          justifyContent: "flex-end",
        }}
      >
        {CHAT.map((msg, i) => {
          const delay = 0.5 * fps + i * 1.0 * fps;
          const msgOpacity = interpolate(frame, [delay, delay + 0.2 * fps], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          const msgY = interpolate(frame, [delay, delay + 0.2 * fps], [12, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });

          if (msgOpacity <= 0) return null;

          const isUser = msg.sender === "user";

          return (
            <div
              key={i}
              style={{
                opacity: msgOpacity,
                transform: `translateY(${msgY}px)`,
                alignSelf: isUser ? "flex-end" : "flex-start",
                maxWidth: "85%",
              }}
            >
              <div
                style={{
                  backgroundColor: isUser ? COLORS.blue : COLORS.element,
                  color: COLORS.text,
                  padding: "10px 14px",
                  borderRadius: isUser ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
                  fontSize: 14,
                  fontFamily: isUser ? mono : inter,
                  lineHeight: 1.4,
                }}
              >
                {msg.text}
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: COLORS.textDim,
                  marginTop: 3,
                  textAlign: isUser ? "right" : "left",
                  fontFamily: inter,
                  padding: "0 4px",
                }}
              >
                {isUser ? "14:22" : "14:22"}
              </div>
            </div>
          );
        })}
      </div>

      {/* Input bar */}
      <div
        style={{
          height: 52,
          borderTop: `1px solid ${COLORS.border}`,
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          gap: 10,
        }}
      >
        <div
          style={{
            flex: 1,
            height: 34,
            backgroundColor: COLORS.element,
            borderRadius: 17,
            display: "flex",
            alignItems: "center",
            padding: "0 14px",
            fontSize: 13,
            color: COLORS.textDim,
            fontFamily: inter,
          }}
        >
          Message...
        </div>
      </div>
    </div>
  );
};

// --- Connection line animation ---
const ConnectionLine: React.FC<{ frame: number; fps: number }> = ({ frame, fps }) => {
  const lineStart = 0.7 * fps;
  const lineOpacity = interpolate(frame, [lineStart, lineStart + 0.3 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Pulse dot traveling along the line
  const dotCycle = 1.5 * fps;
  const dotFrame = Math.max(0, frame - 1.0 * fps);
  const dotProgress = (dotFrame % dotCycle) / dotCycle;
  const dotX = interpolate(dotProgress, [0, 1], [0, 200]);
  const dotOpacity = interpolate(dotProgress, [0, 0.1, 0.9, 1], [0, 1, 1, 0]);

  return (
    <div
      style={{
        width: 200,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        opacity: lineOpacity,
        position: "relative",
      }}
    >
      {/* Line */}
      <div
        style={{
          width: "100%",
          height: 1,
          backgroundColor: COLORS.border,
        }}
      />

      {/* Dashes */}
      <div
        style={{
          position: "absolute",
          width: "100%",
          height: 1,
          background: `repeating-linear-gradient(90deg, ${COLORS.textDim} 0px, ${COLORS.textDim} 6px, transparent 6px, transparent 14px)`,
        }}
      />

      {/* Traveling dot */}
      {frame > 1.0 * fps && (
        <div
          style={{
            position: "absolute",
            left: dotX,
            width: 6,
            height: 6,
            borderRadius: "50%",
            backgroundColor: COLORS.accent,
            opacity: dotOpacity,
            boxShadow: `0 0 8px ${COLORS.accent}`,
          }}
        />
      )}

      {/* Label */}
      <div
        style={{
          position: "absolute",
          top: -20,
          fontSize: 11,
          color: COLORS.textDim,
          fontFamily: mono,
          letterSpacing: 1,
        }}
      >
        HTTPS
      </div>
    </div>
  );
};

export const Channels: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Terminal events appear shortly after phone messages
  const terminalStart = 1.2 * fps;
  const terminalFrame = Math.max(0, frame - terminalStart);
  const terminalVisible = Math.min(Math.floor((terminalFrame / fps) * 2.5), TERMINAL_EVENTS.length);

  const terminalOpacity = interpolate(frame, [0.8 * fps, 1.2 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const cursorVisible = Math.floor(frame / (fps * 0.35)) % 2 === 0;

  // Title
  const titleOpacity = interpolate(frame, [0, 0.3 * fps], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        fontFamily: mono,
      }}
    >
      {/* Section title */}
      <div
        style={{
          position: "absolute",
          top: 40,
          left: 0,
          right: 0,
          textAlign: "center",
          opacity: titleOpacity,
        }}
      >
        <span style={{ fontSize: 14, color: COLORS.textDim, letterSpacing: 3 }}>
          DEPLOY FROM ANYWHERE
        </span>
      </div>

      {/* Main layout: phone — line — terminal */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 0,
        }}
      >
        {/* Phone */}
        <PhoneMockup frame={frame} fps={fps} />

        {/* Connection */}
        <ConnectionLine frame={frame} fps={fps} />

        {/* Terminal */}
        <div
          style={{
            opacity: terminalOpacity,
            width: 820,
            height: 700,
            backgroundColor: COLORS.panel,
            borderRadius: 12,
            border: `1px solid ${COLORS.border}`,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
          }}
        >
          {/* Title bar */}
          <div
            style={{
              height: 36,
              backgroundColor: COLORS.element,
              display: "flex",
              alignItems: "center",
              padding: "0 14px",
              gap: 7,
              flexShrink: 0,
            }}
          >
            <div
              style={{ width: 10, height: 10, borderRadius: "50%", backgroundColor: "#ff5f57" }}
            />
            <div
              style={{ width: 10, height: 10, borderRadius: "50%", backgroundColor: "#febc2e" }}
            />
            <div
              style={{ width: 10, height: 10, borderRadius: "50%", backgroundColor: "#28c840" }}
            />
            <span style={{ fontSize: 12, color: COLORS.textDim, marginLeft: 10 }}>
              kraken logs --follow
            </span>
          </div>

          {/* Logs */}
          <div style={{ padding: "18px 22px", flex: 1 }}>
            {TERMINAL_EVENTS.slice(0, terminalVisible).map((line, i) => {
              const lineDelay = terminalStart + (i / 2.5) * fps;
              const lineOpacity = interpolate(frame, [lineDelay, lineDelay + 0.15 * fps], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              });

              return (
                <div
                  key={i}
                  style={{
                    fontSize: 14,
                    lineHeight: 1.85,
                    opacity: lineOpacity,
                  }}
                >
                  <span style={{ color: COLORS.textDim }}>{line.time} </span>
                  <span style={{ color: COLORS.textMuted }}>[{line.tag}]</span>{" "}
                  <span style={{ color: line.color }}>{line.msg}</span>
                </div>
              );
            })}

            {terminalVisible > 0 && (
              <span style={{ color: COLORS.textDim, opacity: cursorVisible ? 1 : 0, fontSize: 14 }}>
                _
              </span>
            )}

            {/* Success banner */}
            {terminalVisible >= TERMINAL_EVENTS.length && (
              <div
                style={{
                  marginTop: 20,
                  padding: "12px 18px",
                  borderRadius: 8,
                  border: `1px solid ${COLORS.green}33`,
                  backgroundColor: "rgba(127, 216, 143, 0.05)",
                  opacity: interpolate(
                    frame,
                    [terminalStart + 3.5 * fps, terminalStart + 3.8 * fps],
                    [0, 1],
                    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
                  ),
                }}
              >
                <div style={{ fontSize: 14, color: COLORS.green }}>
                  Deploy complete — staging is live
                </div>
                <div style={{ fontSize: 12, color: COLORS.textDim, marginTop: 4 }}>
                  v0.1.5 . 32s . notified via telegram
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
