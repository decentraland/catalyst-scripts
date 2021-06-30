
import cliProgress from 'cli-progress'
import asyncPool from 'tiny-async-pool'

export async function executeWithProgressBar<T, K>(detail: string, array: Array<T>, iterator: (element: T) => Promise<K>, concurrency: number = 15): Promise<K[]> {
  const bar = new cliProgress.SingleBar({format: `${detail.padEnd(22, ' ')}: [{bar}] {percentage}% | ETA: {eta}s | {value}/{total}`});
  bar.start(array.length, 0);

  const result = await asyncPool(concurrency, array, async (value) => {
      const result: K = await iterator(value)
      bar.increment(1)
      return result
  });

  bar.stop()

  return result
}