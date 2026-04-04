import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { loadFont } from "@remotion/google-fonts/JetBrainsMono";
import { COLORS } from "../constants";

const { fontFamily: mono } = loadFont("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

// --- Data ---

const STATUS_LINES = [
  { label: "Daemon:", value: "running", color: COLORS.green },
  { label: "PID:", value: "48201", color: COLORS.text },
  { label: "Uptime:", value: "14h 32m", color: COLORS.text },
  { label: "Port:", value: "50051", color: COLORS.text },
  { label: "Workers:", value: "2/4", color: COLORS.cyan },
  { label: "Tasks:", value: "3 pending, 1 running, 87 completed", color: COLORS.text },
];

const TASK_CREATE_LINES = [
  { text: "Task created: a1b2c3d4", color: COLORS.green },
  { text: '  Prompt:   "Review PR #42 and leave comments"', color: COLORS.text },
  { text: "  Priority: 8", color: COLORS.text },
  { text: "  Status:   pending", color: COLORS.cyan },
];

const LOG_LINES = [
  { time: "10:31:02", tag: "cron", msg: "triggered: daily-lint", color: COLORS.cyan },
  { time: "10:31:03", tag: "worker-1", msg: "spawned for task a3f2", color: COLORS.text },
  {
    time: "10:31:08",
    tag: "worker-1",
    msg: "tool: bash  $ eslint src/ --fix",
    color: COLORS.textMuted,
  },
  { time: "10:31:15", tag: "worker-1", msg: "completed task a3f2 (12s)", color: COLORS.green },
  { time: "10:31:20", tag: "webhook", msg: "github push event on main", color: COLORS.accent },
  { time: "10:31:21", tag: "worker-2", msg: "spawned for task b7c1", color: COLORS.text },
  {
    time: "10:31:33",
    tag: "worker-2",
    msg: "tool: read  src/api/handler.ts",
    color: COLORS.textMuted,
  },
  { time: "10:31:45", tag: "watcher", msg: "detected change in src/api/", color: COLORS.cyan },
  { time: "10:31:46", tag: "notify", msg: "slack: task a3f2 completed", color: COLORS.textMuted },
  { time: "10:32:01", tag: "worker-2", msg: "completed task b7c1 (40s)", color: COLORS.green },
  { time: "10:32:05", tag: "telegram", msg: "received /deploy from @dev", color: COLORS.accent },
  { time: "10:32:06", tag: "worker-3", msg: "spawned for task c2d8", color: COLORS.text },
];

// --- Typed command animation ---
const TypedCommand: React.FC<{
  command: string;
  frame: number;
  fps: number;
  startFrame: number;
  typeDuration: number;
}> = ({ command, frame, fps, startFrame, typeDuration }) => {
  const elapsed = Math.max(0, frame - startFrame);
  const chars = Math.min(Math.floor((elapsed / typeDuration) * command.length), command.length);
  const cursorVisible = Math.floor(frame / (fps * 0.35)) % 2 === 0;
  const doneTyping = chars >= command.length;

  return (
    <div style={{ marginBottom: 8 }}>
      <span style={{ color: COLORS.textDim }}>$ </span>
      <span style={{ color: COLORS.text }}>{command.slice(0, chars)}</span>
      {!doneTyping && (
        <span style={{ color: COLORS.accent, opacity: cursorVisible ? 1 : 0 }}>|</span>
      )}
    </div>
  );
};

export const Daemon: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // --- Timeline (7s total) ---
  // Phase 1: Type "kraken daemon status" (0 - 0.6s)
  const cmd1Start = 0;
  const cmd1TypeDur = 0.6 * fps;
  const cmd1Done = 0.8 * fps;

  // Phase 2: Status output appears (0.8s - 1.8s)
  const statusStart = cmd1Done;
  const statusVisible = Math.min(
    Math.floor(Math.max(0, frame - statusStart) / (fps * 0.12)),
    STATUS_LINES.length,
  );

  // Phase 3: Type "kraken task create" (2.2s - 2.8s)
  const cmd2Start = 2.2 * fps;
  const cmd2TypeDur = 0.7 * fps;
  const cmd2Text = 'kraken task create "Review PR #42 and leave comments" --priority 8';
  const cmd2Done = 3.0 * fps;
  const showCmd2 = frame >= cmd2Start;

  // Phase 4: Task create output (3.0s - 3.5s)
  const taskVisible = Math.min(
    Math.floor(Math.max(0, frame - cmd2Done) / (fps * 0.1)),
    TASK_CREATE_LINES.length,
  );

  // Phase 5: Type "kraken logs --follow" (3.8s - 4.3s)
  const cmd3Start = 3.8 * fps;
  const cmd3TypeDur = 0.5 * fps;
  const cmd3Done = 4.4 * fps;
  const showCmd3 = frame >= cmd3Start;

  // Phase 6: Logs streaming (4.4s - 7s)
  const logsFrame = Math.max(0, frame - cmd3Done);
  const logLinesVisible = Math.min(Math.floor((logsFrame / fps) * 4.5), LOG_LINES.length);

  const cursorVisible = Math.floor(frame / (fps * 0.35)) % 2 === 0;

  // Calculate scroll offset — content moves up as we add more lines
  const totalContentLines =
    1 +
    statusVisible + // cmd1 + status
    (showCmd2 ? 2 : 0) +
    taskVisible + // cmd2 + spacing + task
    (showCmd3 ? 2 : 0) +
    logLinesVisible; // cmd3 + spacing + logs

  const maxVisibleLines = 22;
  const scrollOffset = Math.max(0, totalContentLines - maxVisibleLines) * 28;
  const smoothScroll = interpolate(scrollOffset, [0, 1000], [0, 1000]);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        fontFamily: mono,
        padding: "60px 100px",
      }}
    >
      {/* Terminal window */}
      <div
        style={{
          backgroundColor: COLORS.panel,
          borderRadius: 12,
          border: `1px solid ${COLORS.border}`,
          overflow: "hidden",
          height: "100%",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Title bar */}
        <div
          style={{
            height: 40,
            backgroundColor: COLORS.element,
            display: "flex",
            alignItems: "center",
            padding: "0 16px",
            gap: 8,
            flexShrink: 0,
          }}
        >
          <div style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: "#ff5f57" }} />
          <div style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: "#febc2e" }} />
          <div style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: "#28c840" }} />
          <span style={{ fontSize: 13, color: COLORS.textDim, marginLeft: 12 }}>
            Terminal — kraken
          </span>
        </div>

        {/* Terminal content */}
        <div
          style={{
            padding: "20px 28px",
            flex: 1,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              transform: `translateY(-${smoothScroll}px)`,
            }}
          >
            {/* Command 1: daemon status */}
            <TypedCommand
              command="kraken daemon status"
              frame={frame}
              fps={fps}
              startFrame={cmd1Start}
              typeDuration={cmd1TypeDur}
            />

            {/* Status output */}
            {statusVisible > 0 && (
              <div style={{ marginBottom: 20, marginLeft: 8 }}>
                {STATUS_LINES.slice(0, statusVisible).map((line, i) => (
                  <div
                    key={i}
                    style={{
                      fontSize: 16,
                      lineHeight: 1.7,
                      display: "flex",
                      gap: 14,
                    }}
                  >
                    <span
                      style={{
                        color: COLORS.textMuted,
                        width: 90,
                        textAlign: "right",
                        flexShrink: 0,
                      }}
                    >
                      {line.label}
                    </span>
                    <span style={{ color: line.color }}>{line.value}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Command 2: task create */}
            {showCmd2 && (
              <>
                <div style={{ height: 8 }} />
                <TypedCommand
                  command={cmd2Text}
                  frame={frame}
                  fps={fps}
                  startFrame={cmd2Start}
                  typeDuration={cmd2TypeDur}
                />
              </>
            )}

            {/* Task output */}
            {taskVisible > 0 && (
              <div style={{ marginBottom: 16, marginLeft: 8 }}>
                {TASK_CREATE_LINES.slice(0, taskVisible).map((line, i) => (
                  <div
                    key={i}
                    style={{
                      fontSize: 16,
                      lineHeight: 1.7,
                      color: line.color,
                    }}
                  >
                    {line.text}
                  </div>
                ))}
              </div>
            )}

            {/* Command 3: logs */}
            {showCmd3 && (
              <>
                <div style={{ height: 8 }} />
                <TypedCommand
                  command="kraken logs --follow"
                  frame={frame}
                  fps={fps}
                  startFrame={cmd3Start}
                  typeDuration={cmd3TypeDur}
                />
              </>
            )}

            {/* Log output */}
            {logLinesVisible > 0 && (
              <div>
                {LOG_LINES.slice(0, logLinesVisible).map((line, i) => (
                  <div
                    key={i}
                    style={{
                      fontSize: 15,
                      lineHeight: 1.75,
                    }}
                  >
                    <span style={{ color: COLORS.textDim }}>{line.time} </span>
                    <span style={{ color: COLORS.textMuted }}>[{line.tag}]</span>{" "}
                    <span style={{ color: line.color }}>{line.msg}</span>
                  </div>
                ))}
                <span
                  style={{
                    color: COLORS.textDim,
                    opacity: cursorVisible ? 1 : 0,
                    fontSize: 15,
                  }}
                >
                  _
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
