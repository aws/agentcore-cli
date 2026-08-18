import winston from "winston";
import { type AsyncLogger, type LoggerBindings, type LogLevel } from "./types";

export interface FileLoggerConfig {
  /** The exact file to write. Its directory is created if it does not exist yet. */
  filePath: string;
  bindings?: LoggerBindings;
  logLevel: LogLevel;
}

function wrapWinstonLogger(
  winstonLogger: winston.Logger,
  transport: winston.transports.FileTransportInstance,
  bindings: LoggerBindings,
): AsyncLogger {
  const log =
    (level: string) =>
    (...args: string[]) =>
      winstonLogger.log(level, args.join(" "), bindings);

  return {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    child: (childBindings) =>
      wrapWinstonLogger(winstonLogger, transport, { ...bindings, ...childBindings }),
    end: () =>
      new Promise<void>((resolve) => {
        // Ending the transport flushes what it has buffered and closes the file stream;
        // `finish` is what it emits once that has happened.
        transport.once("finish", resolve);
        transport.end();
      }),
  };
}

/**
 * Creates a logger that writes structured JSON to one file per run.
 *
 * A run's log is a whole run and only that run, so nothing rotates and nothing is
 * appended to by a later run; {@link logFilePath} names the file for the run. Bounding
 * the directory of them is {@link pruneOldLogs}, since it is the run that knows which
 * file is its own and must be kept.
 *
 * @param config - Logger configuration (file path, level, bindings).
 * @returns A {@link AsyncLogger} that writes to `config.filePath` via winston.
 */
export function createFileLogger(config: FileLoggerConfig): AsyncLogger {
  const bindings = config.bindings ?? {};

  // The transport creates the file's directory itself, so a command's first ever run
  // needs no separate mkdir.
  const transport = new winston.transports.File({ filename: config.filePath });

  const jsonFormat = winston.format.printf((info) => {
    const { level, message, ...rest } = info;
    return JSON.stringify({ level, msg: message, time: Date.now(), ...rest });
  });

  const logger = winston.createLogger({
    level: config.logLevel,
    format: jsonFormat,
    transports: [transport],
  });

  return wrapWinstonLogger(logger, transport, bindings);
}
