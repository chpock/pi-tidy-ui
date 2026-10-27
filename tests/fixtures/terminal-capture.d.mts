export interface CaptureProducer {
  owner: WeakRef<{ whenSettled(): Promise<boolean> }>;
  sample(): unknown;
}
export interface CaptureBridge {
  producer?: CaptureProducer;
  changed?: () => void;
}
export function terminalCaptureBridge(): CaptureBridge;
export function registerCaptureProducer(owner: { whenSettled(): Promise<boolean> }, sample: () => unknown): () => void;
