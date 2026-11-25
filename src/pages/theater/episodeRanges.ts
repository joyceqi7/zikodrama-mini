import type { DramaDetail } from "../../domain/types";

/** EPISODES_PER_RANGE 每组 30 集，对应六列五行；小屏网格仍可纵向滚动。 */
export const EPISODES_PER_RANGE = 30;

type EpisodeRange = {
  label: string;
  episodes: DramaDetail["episodes"];
};

/** buildEpisodeRanges 按接口顺序分页，以真实集号标记范围。 */
export function buildEpisodeRanges(
  episodes: DramaDetail["episodes"],
): EpisodeRange[] {
  const ranges: EpisodeRange[] = [];
  for (let index = 0; index < episodes.length; index += EPISODES_PER_RANGE) {
    const rangeEpisodes = episodes.slice(index, index + EPISODES_PER_RANGE);
    const firstNumber = rangeEpisodes[0]?.number;
    const lastNumber = rangeEpisodes.at(-1)?.number;
    if (firstNumber === undefined || lastNumber === undefined) continue;
    ranges.push({
      label:
        firstNumber === lastNumber
          ? String(firstNumber)
          : `${firstNumber}-${lastNumber}`,
      episodes: rangeEpisodes,
    });
  }
  return ranges;
}
