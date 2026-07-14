export type OutputWriteOutcome = { kind: "written" } | { kind: "outputUnavailable" };

export interface AwaitedOutputSink {
  writeUtf8(
    text: string,
    options?: Readonly<{ abortSignal?: AbortSignal }>,
  ): Promise<OutputWriteOutcome>;
}

export interface StreamSupervisor {
  readonly stdout: AwaitedOutputSink;
  readonly stderr: AwaitedOutputSink;
  quiesce(): Promise<void>;
  dispose(): void;
}
