function prefixStr(msg: string, prefix?: string) {
  return `${prefix ? `${prefix}:` : ''}${msg}`;
}

export const getLogger = (prefix?: string) => ({
  debug: (msg: string) => console.debug(prefixStr(msg, `[${prefix}]`)),
  info: (msg: string) => console.info(prefixStr(msg, `[${prefix}]`)),
  warn: (msg: string) => console.warn(prefixStr(msg, `[${prefix}]`)),
  error: (msg: string) => console.error(prefixStr(msg, `[${prefix}]`)),
  child: (newPrefix: string) => getLogger(prefixStr(newPrefix, prefix)),
});

export type Logger = ReturnType<typeof getLogger>;
