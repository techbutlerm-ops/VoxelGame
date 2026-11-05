import { ChunkJob, runJob, transferables } from './job';

self.onmessage = (e: MessageEvent<ChunkJob>) => {
  const result = runJob(e.data);
  (self as unknown as Worker).postMessage(result, transferables(result));
};
