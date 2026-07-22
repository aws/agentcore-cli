import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import { type AsyncLogger, type LoggerBindings, type LogLevel } from "./types";

export interface FileLoggerConfig {
  filePath: string;
  maxSizeInMB?: number;
  maxFileCount?: number;
  bindings?: LoggerBindings;
  logLevel: LogLevel;
}

function wrapWinstonLogger(
  winstonLogger: winston.Logger,
  transport: DailyRotateFile,
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
        transport.on("finish", resolve);
        // note: we prefer close over end since close calls end on the stream internally: https://github.com/winstonjs/winston-daily-rotate-file/blob/a1a4668cfea77476cd6a4a11f038c2aac9d10741/daily-rotate-file.js#L201-L207
        if (transport.close) transport.close();
      }),
  };
}

/**
 * Creates a logger that writes structured JSON to a rotating file.
 *
 * @param config - Logger configuration (file path, rotation limits, level).
 * @returns A {@link AsyncLogger} that writes to a rotating file via winston.
 */
export function createFileLogger(config: FileLoggerConfig): AsyncLogger {
  const maxSizeInMB = config.maxSizeInMB ?? 5;
  const maxFileCount = config.maxFileCount ?? 10;
  const bindings = config.bindings ?? {};

  const transport = new DailyRotateFile({
    filename: `${config.filePath}-%DATE%`,
    extension: ".log",
    datePattern: "YYYY-MM-DD",
    maxSize: `${maxSizeInMB}m`,
    maxFiles: maxFileCount,
    createSymlink: false,
  });

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
