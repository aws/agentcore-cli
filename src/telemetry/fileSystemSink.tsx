import type { Logger } from "../logging";
import type { ResourceAttributes } from "./shapes";
import type { MetricSink } from "./types";
import { mkdir, appendFile } from "fs/promises";
import { dirname } from "path";

export type FileSystemSinkConfig = {
  logger: Logger;
  filePath: string;
  resourceAttributes: ResourceAttributes;
};

/** An implementation of {@link MetricSink} that sends all data to the specified file in JSONL format **/
export class FileSystemSink implements MetricSink {
  private readonly name: string;

  private readonly filePath: string;
  private logger: Logger;

  private readonly resourceAttributes: ResourceAttributes;

  /* a chain of promises describing the pending writes to the audit file */
  private pendingWrite: Promise<void>;

  constructor(config: FileSystemSinkConfig) {
    this.filePath = config.filePath;
    this.logger = config.logger.child({ fsSinkFilePath: this.filePath });
    this.name = new.target.name;
    this.resourceAttributes = config.resourceAttributes;

    this.pendingWrite = Promise.resolve();
  }

  send(
    metricName: string,
    value: number,
    attributes: Record<string, string | number | boolean>,
  ): void {
    this.pendingWrite = this.pendingWrite.then(() =>
      this.appendEntry({ metricName, value, attrs: { ...this.resourceAttributes, ...attributes } }),
    );
  }

  private async appendEntry(entry: {
    metricName: string;
    value: number;
    attrs: Record<string, string | number | boolean>;
  }): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, JSON.stringify(entry) + "\n");
  }

  async shutdown(): Promise<void> {
    try {
      await this.pendingWrite;
      this.logger.info(`audit file written to '${this.filePath}'`);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      this.logger
        .child({ errorName: error.name, errorMessage: error.message })
        .warn(`failed to append metric data to file`);
    }
  }

  getName(): string {
    return this.name;
  }
}
