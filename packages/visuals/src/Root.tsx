import { Composition } from "remotion";
import { KrakenDemo } from "./KrakenDemo";
import { COMP_WIDTH, COMP_HEIGHT, FPS, TOTAL_DURATION } from "./constants";

export const RemotionRoot = () => {
  return (
    <Composition
      id="KrakenDemo"
      component={KrakenDemo}
      durationInFrames={TOTAL_DURATION}
      fps={FPS}
      width={COMP_WIDTH}
      height={COMP_HEIGHT}
    />
  );
};
