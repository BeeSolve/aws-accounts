export interface Logger {
  log: (...args: Array<unknown>) => void;
  info: (...args: Array<unknown>) => void;
  warn: (...args: Array<unknown>) => void;
  error: (...args: Array<unknown>) => void;
  debug: (...args: Array<unknown>) => void;
  trace: (...args: Array<unknown>) => void;
}

export const consoleLogger: Logger = {
  log: (...args: Array<unknown>) => console.log(...args),
  info: (...args: Array<unknown>) => console.info(...args),
  warn: (...args: Array<unknown>) => console.warn(...args),
  error: (...args: Array<unknown>) => console.error(...args),
  debug: (...args: Array<unknown>) => console.debug(...args),
  trace: (...args: Array<unknown>) => console.trace(...args),
};

export const noopLogger: Logger = {
  log: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
};
