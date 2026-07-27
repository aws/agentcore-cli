import type z from "zod";

// AppIO is injected at the application edge and threaded through handlers and
// the TUI so production uses process streams while tests use in-memory streams.
export interface AppIO {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

export interface ReadWriteJson {
  /** Reads and validates data from the given file. */
  read<TSchema extends z.ZodType>(filePath: string, schema: TSchema): Promise<z.infer<TSchema>>;
  /** Writes data to the given file. */
  write<TData extends object>(filePath: string, data: TData): Promise<TData>;
}
