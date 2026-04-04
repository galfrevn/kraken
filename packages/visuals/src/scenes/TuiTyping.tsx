import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  Easing,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/JetBrainsMono";
import { COLORS } from "../constants";

const { fontFamily: mono } = loadFont("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

const USER_PROMPT = "Fix the failing test in src/auth.test.ts";

type Line = {
  text: string;
  type:
    | "text"
    | "command"
    | "fail"
    | "error"
    | "edit"
    | "added"
    | "removed"
    | "success"
    | "empty"
    | "thinking"
    | "separator";
};

const AGENT_RESPONSE: Line[] = [
  { text: "I'll check the test file and identify the issue.", type: "text" },
  { text: "", type: "empty" },
  { text: "-> Read src/auth.test.ts", type: "command" },
  { text: "", type: "empty" },
  { text: "$ npx jest src/auth.test.ts --no-coverage", type: "command" },
  { text: "", type: "empty" },
  { text: "  FAIL  src/auth.test.ts", type: "fail" },
  { text: "    x should validate token expiry (12ms)", type: "error" },
  { text: "    . should hash password (3ms)", type: "success" },
  { text: "    . should verify JWT signature (5ms)", type: "success" },
  { text: "", type: "empty" },
  { text: "  Expected: true", type: "error" },
  { text: "  Received: false", type: "error" },
  { text: "", type: "empty" },
  { text: "The test passes a raw timestamp string to isExpired(),", type: "text" },
  { text: "but it expects a Date object. Fixing the comparison:", type: "text" },
  { text: "", type: "empty" },
  { text: "<- Edit src/auth.test.ts", type: "edit" },
  { text: "  14 |   const result = isExpired(token);", type: "removed" },
  { text: "  14 |   const result = isExpired(new Date(token.exp * 1000));", type: "added" },
  { text: "", type: "empty" },
  { text: "$ npx jest src/auth.test.ts --no-coverage", type: "command" },
  { text: "", type: "empty" },
  { text: "  PASS  src/auth.test.ts", type: "success" },
  { text: "    . should validate token expiry (4ms)", type: "success" },
  { text: "    . should hash password (3ms)", type: "success" },
  { text: "    . should verify JWT signature (5ms)", type: "success" },
  { text: "", type: "empty" },
  { text: "  Tests: 3 passed, 3 total", type: "success" },
];

const SECOND_PROMPT = "Now add a test for expired refresh tokens";

const SECOND_RESPONSE: Line[] = [
  { text: "Adding a test case for expired refresh tokens.", type: "text" },
  { text: "", type: "empty" },
  { text: "<- Edit src/auth.test.ts", type: "edit" },
  { text: '  + it("should reject expired refresh token", () => {', type: "added" },
  { text: "  +   const token = createRefreshToken({ exp: past() });", type: "added" },
  { text: "  +   expect(validateRefresh(token)).rejects.toThrow();", type: "added" },
  { text: "  + });", type: "added" },
];

const LINE_STYLE: Record<Line["type"], { color: string; bg: string }> = {
  text: { color: COLORS.text, bg: "transparent" },
  command: { color: COLORS.cyan, bg: "transparent" },
  fail: { color: COLORS.red, bg: "transparent" },
  error: { color: COLORS.red, bg: "transparent" },
  edit: { color: COLORS.accent, bg: "transparent" },
  added: { color: COLORS.green, bg: "rgba(127, 216, 143, 0.06)" },
  removed: { color: COLORS.red, bg: "rgba(224, 108, 117, 0.06)" },
  success: { color: COLORS.green, bg: "transparent" },
  empty: { color: "transparent", bg: "transparent" },
  thinking: { color: COLORS.textDim, bg: "transparent" },
  separator: { color: COLORS.border, bg: "transparent" },
};

const ResponseLine: React.FC<{ line: Line }> = ({ line }) => {
  if (line.type === "empty") return <div style={{ height: 6 }} />;

  const style = LINE_STYLE[line.type];
  const isDiff = line.type === "added" || line.type === "removed";

  return (
    <div
      style={{
        fontSize: 16,
        color: style.color,
        lineHeight: 1.7,
        backgroundColor: style.bg,
        padding: isDiff ? "0 8px" : 0,
        borderRadius: isDiff ? 3 : 0,
        whiteSpace: "pre",
      }}
    >
      {line.text}
    </div>
  );
};

// Knight-rider style spinner
const Spinner: React.FC<{ frame: number; fps: number }> = ({ frame, fps }) => {
  const width = 8;
  const speed = 12;
  const pos = Math.floor((frame * speed) / fps) % (width * 2);
  const idx = pos < width ? pos : width * 2 - pos - 1;

  return (
    <div style={{ display: "flex", gap: 3, marginLeft: 4, marginTop: 2 }}>
      {Array.from({ length: width }).map((_, i) => {
        const dist = Math.abs(i - idx);
        const opacity = dist === 0 ? 1 : dist === 1 ? 0.4 : 0.1;
        return (
          <div
            key={i}
            style={{
              width: 8,
              height: 8,
              borderRadius: 2,
              backgroundColor: COLORS.accent,
              opacity,
            }}
          />
        );
      })}
    </div>
  );
};

const Sidebar: React.FC<{ frame: number; fps: number; opacity: number }> = ({
  frame,
  fps,
  opacity,
}) => {
  // Animate token count and cost
  const tokensBase = 0;
  const tokensTarget = 24_310;
  const costTarget = 0.08;
  const progress = interpolate(frame, [1.5 * fps, 6 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.quad),
  });
  const tokens = Math.floor(tokensBase + progress * tokensTarget);
  const cost = (progress * costTarget).toFixed(2);

  return (
    <div
      style={{
        position: "absolute",
        right: 0,
        top: 0,
        bottom: 0,
        width: 320,
        borderLeft: `1px solid ${COLORS.border}`,
        backgroundColor: COLORS.panel,
        padding: "28px 22px",
        display: "flex",
        flexDirection: "column",
        gap: 16,
        fontFamily: mono,
        opacity,
      }}
    >
      <div style={{ fontSize: 13, color: COLORS.textDim, letterSpacing: 1 }}>SESSION</div>
      <div style={{ fontSize: 15, color: COLORS.text }}>Fix auth tests</div>
      <div style={{ height: 1, backgroundColor: COLORS.border }} />

      <div style={{ fontSize: 13, color: COLORS.textDim, letterSpacing: 1 }}>AGENT</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: COLORS.accent }} />
        <span style={{ fontSize: 15, color: COLORS.text }}>Build</span>
      </div>
      <div style={{ height: 1, backgroundColor: COLORS.border }} />

      <div style={{ fontSize: 13, color: COLORS.textDim, letterSpacing: 1 }}>CONTEXT</div>
      <div style={{ fontSize: 14, color: COLORS.textMuted }}>{tokens.toLocaleString()} tokens</div>
      <div style={{ fontSize: 14, color: COLORS.textMuted }}>${cost} spent</div>

      {/* Token bar */}
      <div
        style={{ height: 4, backgroundColor: COLORS.element, borderRadius: 2, overflow: "hidden" }}
      >
        <div
          style={{
            height: "100%",
            width: `${progress * 18}%`,
            backgroundColor: COLORS.textDim,
            borderRadius: 2,
          }}
        />
      </div>
      <div style={{ height: 1, backgroundColor: COLORS.border }} />

      <div style={{ fontSize: 13, color: COLORS.textDim, letterSpacing: 1 }}>LSP</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: COLORS.green }} />
        <span style={{ fontSize: 14, color: COLORS.textMuted }}>typescript</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: COLORS.textDim }}
        />
        <span style={{ fontSize: 14, color: COLORS.textDim }}>python</span>
      </div>
      <div style={{ height: 1, backgroundColor: COLORS.border }} />

      <div style={{ fontSize: 13, color: COLORS.textDim, letterSpacing: 1 }}>MODEL</div>
      <div style={{ fontSize: 14, color: COLORS.textMuted }}>claude-opus</div>
      <div style={{ fontSize: 13, color: COLORS.textDim }}>anthropic</div>
    </div>
  );
};

export const TuiTyping: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // --- Timing ---
  // Phase 1: Type first prompt (0 - 1.2s)
  const typingDuration = 1.2 * fps;
  const typingSpeed = USER_PROMPT.length / typingDuration;
  const charsTyped = Math.min(Math.floor(frame * typingSpeed), USER_PROMPT.length);
  const visiblePrompt = USER_PROMPT.slice(0, charsTyped);
  const isTypingFirst = charsTyped < USER_PROMPT.length;

  // Phase 2: Spinner thinking (1.4s - 1.8s)
  const spinnerStart = 1.4 * fps;
  const spinnerEnd = 1.9 * fps;
  const showSpinner1 = frame >= spinnerStart && frame < spinnerEnd;

  // Phase 3: First response streams (1.9s - 5s)
  const responseStart = 1.9 * fps;
  const responseFrame = Math.max(0, frame - responseStart);
  const linesPerSecond = 7;
  const visibleLines1 = Math.min(
    Math.floor((responseFrame / fps) * linesPerSecond),
    AGENT_RESPONSE.length,
  );

  // Phase 4: Second prompt typed (5.2s - 6.2s)
  const secondPromptStart = 5.2 * fps;
  const secondTypingDuration = 1.0 * fps;
  const secondChars = Math.min(
    Math.max(
      0,
      Math.floor((frame - secondPromptStart) * (SECOND_PROMPT.length / secondTypingDuration)),
    ),
    SECOND_PROMPT.length,
  );
  const visibleSecondPrompt = SECOND_PROMPT.slice(0, secondChars);
  const isTypingSecond = frame >= secondPromptStart && secondChars < SECOND_PROMPT.length;

  // Phase 5: Spinner (6.4s - 6.7s)
  const spinnerStart2 = 6.4 * fps;
  const spinnerEnd2 = 6.8 * fps;
  const showSpinner2 = frame >= spinnerStart2 && frame < spinnerEnd2;

  // Phase 6: Second response (6.8s - end)
  const response2Start = 6.8 * fps;
  const response2Frame = Math.max(0, frame - response2Start);
  const visibleLines2 = Math.min(
    Math.floor((response2Frame / fps) * linesPerSecond),
    SECOND_RESPONSE.length,
  );

  // Prompt submitted states
  const firstSubmitted = frame > 1.3 * fps;
  const secondSubmitted = frame > 6.3 * fps;

  // Cursor
  const cursorVisible = Math.floor(frame / (fps * 0.4)) % 2 === 0;

  // UI fade in
  const sidebarOpacity = interpolate(frame, [0, 0.4 * fps], [0, 1], { extrapolateRight: "clamp" });
  const footerOpacity = interpolate(frame, [0, 0.2 * fps], [0, 1], { extrapolateRight: "clamp" });

  // Determine what's in the input box
  let inputContent: React.ReactNode;
  if (!firstSubmitted) {
    inputContent = (
      <span style={{ fontSize: 17, color: COLORS.text }}>
        {visiblePrompt}
        <span style={{ color: COLORS.accent, opacity: cursorVisible ? 1 : 0 }}>|</span>
      </span>
    );
  } else if (frame >= secondPromptStart && !secondSubmitted) {
    inputContent = (
      <span style={{ fontSize: 17, color: COLORS.text }}>
        {visibleSecondPrompt}
        <span style={{ color: COLORS.accent, opacity: cursorVisible ? 1 : 0 }}>|</span>
      </span>
    );
  } else {
    inputContent = <span style={{ fontSize: 15, color: COLORS.textDim }}>Ask anything...</span>;
  }

  // Active border color
  const inputActive = isTypingFirst || isTypingSecond;

  // Metadata line after first response
  const showMeta1 = visibleLines1 >= AGENT_RESPONSE.length;

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg, fontFamily: mono }}>
      <Sidebar frame={frame} fps={fps} opacity={sidebarOpacity} />

      {/* Main content */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 44,
          right: 320,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Messages */}
        <div
          style={{
            flex: 1,
            padding: "36px 52px",
            display: "flex",
            flexDirection: "column",
            gap: 20,
            overflow: "hidden",
          }}
        >
          {/* First user message */}
          {firstSubmitted && (
            <div style={{ display: "flex", gap: 12 }}>
              <div
                style={{ width: 3, backgroundColor: COLORS.blue, borderRadius: 2, flexShrink: 0 }}
              />
              <div style={{ fontSize: 17, color: COLORS.text, lineHeight: 1.6 }}>{USER_PROMPT}</div>
            </div>
          )}

          {/* Spinner 1 */}
          {showSpinner1 && <Spinner frame={frame - spinnerStart} fps={fps} />}

          {/* First response */}
          {visibleLines1 > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {AGENT_RESPONSE.slice(0, visibleLines1).map((line, i) => (
                <ResponseLine key={i} line={line} />
              ))}
            </div>
          )}

          {/* Metadata after first response */}
          {showMeta1 && (
            <div style={{ fontSize: 12, color: COLORS.textDim, marginTop: 4 }}>
              Build . claude-opus . 3.2s
            </div>
          )}

          {/* Second user message */}
          {secondSubmitted && (
            <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
              <div
                style={{ width: 3, backgroundColor: COLORS.blue, borderRadius: 2, flexShrink: 0 }}
              />
              <div style={{ fontSize: 17, color: COLORS.text, lineHeight: 1.6 }}>
                {SECOND_PROMPT}
              </div>
            </div>
          )}

          {/* Spinner 2 */}
          {showSpinner2 && <Spinner frame={frame - spinnerStart2} fps={fps} />}

          {/* Second response */}
          {visibleLines2 > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {SECOND_RESPONSE.slice(0, visibleLines2).map((line, i) => (
                <ResponseLine key={`s2-${i}`} line={line} />
              ))}
            </div>
          )}
        </div>

        {/* Input area */}
        <div style={{ padding: "0 52px 20px" }}>
          <div
            style={{
              borderLeft: `3px solid ${inputActive ? COLORS.accent : COLORS.textDim}`,
              padding: "14px 18px",
              backgroundColor: COLORS.panel,
              borderRadius: "0 6px 6px 0",
              minHeight: 44,
              display: "flex",
              alignItems: "center",
            }}
          >
            {inputContent}
          </div>
          <div
            style={{ display: "flex", gap: 20, marginTop: 6, fontSize: 11, color: COLORS.textDim }}
          >
            <span>tab agents</span>
            <span>ctrl+p commands</span>
            {(showSpinner1 || showSpinner2) && <span>esc interrupt</span>}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 320,
          bottom: 0,
          height: 34,
          backgroundColor: COLORS.panel,
          borderTop: `1px solid ${COLORS.border}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 20px",
          fontSize: 12,
          opacity: footerOpacity,
        }}
      >
        <span style={{ color: COLORS.textDim }}>~/project:main</span>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div
              style={{ width: 5, height: 5, borderRadius: "50%", backgroundColor: COLORS.green }}
            />
            <span style={{ color: COLORS.textDim }}>daemon 2w 1q</span>
          </div>
          <span style={{ color: COLORS.textDim }}>v0.1.4</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};
